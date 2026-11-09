import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BRIEF_HEADING, BRIEF_TEMPLATE, briefGaps, parseBrief, type Brief } from '../shared/brief.ts';
import type { EffortLevel, LeadSettings } from '../shared/types.ts';
import type { OfficeTools } from './ceo.ts';
import { ONE_TURN } from './prompts.ts';
import { MAX_TRIAGES, type TriagePr } from './triage.ts';

// The floor lead (docs/floor-lead.md): one standing employee per floor, extra to its team, who owns the floor's stuck
// pull requests from start to finish. The office wakes it on events (a PR becomes needs-human) and it acts through
// its own office tools, never a shell. The limits are the tools': it can't merge, can't message the manager (only a
// decision brief through escalate reaches them), can't file new work and can't push. Pure: the rules, prompts and tool
// definitions; swarm.ts runs the sessions and the GitHub calls.

// ---------- jobs ----------

/** What wakes a floor lead: a stuck PR to triage. */
export type LeadJobKind = 'triage';

export interface LeadJob {
  kind: LeadJobKind;
  prNumber: number; // triage: the stuck pull request
  at: number;
}

/** A floor lead's work: its queue, and the job it is on. */
export interface LeadState {
  queue: LeadJob[];
  job: LeadJob | null;
}

const isJob = (j: unknown): j is LeadJob => !!j && typeof j === 'object' && (j as LeadJob).kind === 'triage' && Number.isInteger((j as LeadJob).prNumber) && typeof (j as LeadJob).at === 'number';

/** The leads' saved state, with anything unreadable dropped. A job cut off by a restart goes back to the front of its queue. */
export function loadLeads(raw: unknown): Record<string, LeadState> {
  const out: Record<string, LeadState> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [repoId, v] of Object.entries(raw as Record<string, Partial<LeadState>>)) {
    const queue = Array.isArray(v?.queue) ? v.queue.filter(isJob) : [];
    out[repoId] = { queue: isJob(v?.job) ? [v.job, ...queue.filter((j) => j.prNumber !== v.job!.prNumber)] : queue, job: null };
  }
  return out;
}

/** A queue with the job added: one triage per PR (a newer one replaces it). */
export function enqueueLead(queue: readonly LeadJob[], job: LeadJob): LeadJob[] {
  const same = queue.findIndex((j) => j.kind === job.kind && j.prNumber === job.prNumber);
  return same >= 0 ? queue.map((j, i) => (i === same ? job : j)) : [...queue, job];
}

/** The job a free lead takes next: the oldest stuck PR first. */
export function nextLeadJob(queue: readonly LeadJob[]): LeadJob | null {
  return [...queue].sort((x, y) => x.at - y.at)[0] ?? null;
}

/**
 * A PR just became needs-human: the floor lead triages it (at most MAX_TRIAGES times), or, when the floor has no lead
 * or its tries are spent, the office gives up on it at once (rebuild.ts: rebuilt, or the manager for a business hold).
 */
export function stuckStep(x: { lead: boolean; triages: number }): 'triage' | 'give-up' {
  return x.lead && x.triages < MAX_TRIAGES ? 'triage' : 'give-up';
}

// ---------- models ----------

/** A strong model diagnoses stuck PRs; a cheap one cleans up the board. */
export const DEFAULT_LEAD_SETTINGS: LeadSettings = { triageModel: 'claude-opus-5-5', triageEffort: 'high', cleanupModel: 'claude-sonnet-5', cleanupEffort: 'low' };

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const model = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim().slice(0, 100) : fallback);
const effort = (v: unknown, fallback: EffortLevel) => (EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : fallback);

/** Settings → Floor leads from a saved file or a request body: unknown fields dropped, bad ones back to `base`. */
export function leadSettings(base: LeadSettings, raw: unknown): LeadSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    triageModel: model(r.triageModel, base.triageModel),
    triageEffort: effort(r.triageEffort, base.triageEffort),
    cleanupModel: model(r.cleanupModel, base.cleanupModel),
    cleanupEffort: effort(r.cleanupEffort, base.cleanupEffort),
  };
}

/**
 * The model and effort for a lead's job, the way the CEO's are picked: the lead's own (its agent settings) when set, else
 * the office's for that kind of job. A board clean-up always runs on the cheap model.
 */
export function leadModel(kind: LeadJobKind | 'cleanup', agent: { model: string; effort: EffortLevel | '' }, s: LeadSettings): { model: string; effort: EffortLevel } {
  if (kind === 'cleanup') return { model: s.cleanupModel || DEFAULT_LEAD_SETTINGS.cleanupModel, effort: s.cleanupEffort };
  return { model: agent.model || s.triageModel || DEFAULT_LEAD_SETTINGS.triageModel, effort: agent.effort || s.triageEffort };
}

// ---------- escalate: business only ----------

/**
 * The brief an escalation carries. Only a business decision reaches the manager, and every one of those comes with a
 * complete decision brief: none, or one with empty sections, is refused (an Error worded for the lead).
 */
export function escalationBrief(text: string | null | undefined): Brief {
  const brief = parseBrief(text);
  if (!brief) throw new Error(`Escalate needs a decision brief: start it with "## ${BRIEF_HEADING}" and fill every section. Only a business decision (scope, product behaviour, spend, naming, licensing, credentials) goes to the manager; fix technical problems with the other tools.`);
  const gaps = briefGaps(brief);
  if (gaps.length) throw new Error(`The decision brief is missing ${gaps.join(', ')}. Fill every section, or fix the problem with the other tools if it isn't a business decision.`);
  if (brief.options.length < 2) throw new Error('The decision brief needs at least two options for the manager to choose from.');
  return brief;
}

// ---------- prompts ----------

export function leadSystemPrompt(o: { name: string; floor: number; fullName: string; company: string; notesFile: string }) {
  return [
    `You are ${o.name}, the floor lead of floor ${o.floor} (${o.fullName}) in cubefarm, ${o.company || 'an autonomous software company'}'s office. The floor's agents build issues, test each other's pull requests and fix them; the CEO runs the company from the lobby.`,
    'Your job: the floor runs around the clock and waits for the manager only for a business decision (scope, product behaviour, spend, naming, licensing, credentials). Technical and code-quality problems are yours, never theirs.',
    '',
    'How you work:',
    '- Call mcp__office__floor_status first.',
    "- Read the repository through its clone path with Read, Glob and Grep. It is read-only to you. You cannot run shell commands.",
    `- Keep notes on this floor in ${o.notesFile}: read them at the start, update them at the end.`,
    '- Change things only through the mcp__office__ tools.',
    `- ${ONE_TURN}`,
    '',
    'Limits (the office enforces them):',
    '- You never merge, and never close or rebuild a PR held for a business reason (swarm:hold, a hold path, a decision brief).',
    '- You never message the manager. Only escalate reaches them, and only with a complete decision brief.',
    '- You never decide new work. You never push code.',
    `- Your final message is for the office log, not the manager: one line on what you did.`,
  ].join('\n');
}

export function leadJobPrompt(job: LeadJob, floor: { floor: number; fullName: string; clone: string }, pr: TriagePr | null): string {
  if (!pr) return `Pull request #${job.prNumber} no longer needs triage. Reply "Nothing to do."`;
  return [
    `Triage: pull request #${pr.number} on floor ${floor.floor} (${floor.fullName}) is stuck.`,
    `"${pr.title}" · ${pr.url} · read-only clone of the default branch at ${floor.clone}`,
    `Why it stopped: ${pr.why ?? 'unknown'}`,
    `QA round ${pr.round}. QA summary: ${pr.summary ?? 'none yet'}`,
    pr.fixInstructions ? `QA's fix instructions:\n${pr.fixInstructions}` : '',
    pr.mergeNote ? `Merge note: ${pr.mergeNote}` : '',
    `GitHub checks: ${pr.checks}${pr.failedChecks.length ? ` (failed: ${pr.failedChecks.join(', ')})` : ''}${pr.pendingChecks.length ? ` (running: ${pr.pendingChecks.join(', ')})` : ''} · mergeable: ${pr.mergeable} (${pr.mergeState})`,
    `This is triage ${pr.triage} of ${MAX_TRIAGES} for this PR; after that the office rebuilds it from the default branch.`,
    '',
    `Work out why it is stuck, then call exactly one of retry_qa (a flaky QA session, or fixed since), send_back (a developer can fix it; your note says how), rerun_checks (a flaky check or an outage), close_pull (the wrong approach: its issue is built again), rebuild (a technical tangle, e.g. it keeps conflicting: closed and built again from the default branch) or escalate (only a business decision, with a complete brief), with floor ${floor.floor} and pr ${pr.number}. If you end without one, the office rebuilds it.`,
    `An escalation's brief, in this template:\n${BRIEF_TEMPLATE}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function leadJobLabel(job: LeadJob) {
  return `Triaging PR #${job.prNumber}`;
}

// ---------- tools ----------

/** What a lead's tools do, for its own floor. Implemented by the swarm; errors go back to the lead as tool errors. */
export interface LeadHandlers {
  floorStatus(): string;
  writeBrief(a: { number: number; background: string; decision: string; options: string[]; recommendation: string; risk: string; if_no_reply?: string }): Promise<string>;
  retryQa(a: { pr: number }): Promise<string>;
  sendBack(a: { pr: number; note: string }): Promise<string>;
  rerunChecks(a: { pr: number }): Promise<string>;
  closePull(a: { pr: number; comment: string }): Promise<string>;
  rebuild(a: { pr: number }): Promise<string>;
  escalate(a: { pr: number; brief: string }): Promise<string>;
}

/**
 * The lead's office tools, for one floor. `floor` in each call must be the lead's own; the swarm refuses any other.
 * There is no merge, no file_issue, no email and no chat: what a lead may never do, it has no tool for.
 */
export function createLeadTools(floor: number, h: LeadHandlers): OfficeTools {
  const run = async (fn: () => string | Promise<string>) => {
    try {
      return { content: [{ type: 'text' as const, text: await fn() }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Refused: ${(err as Error).message}` }], isError: true };
    }
  };
  /** Each tool takes `floor` like the CEO's do, and refuses another floor's. */
  const mine = <T extends { floor: number }>(fn: (a: Omit<T, 'floor'>) => string | Promise<string>) => (a: T) =>
    run(() => {
      if (a.floor !== floor) throw new Error(`You lead floor ${floor}: floor ${a.floor} isn't yours to change.`);
      return fn(a);
    });
  const FLOOR = z.number().int().describe(`Your floor: ${floor}`);
  const PR = z.number().int().positive().describe('The pull request number');
  const defs = [
    tool('floor_status', "Your floor right now: its open issues (labels, what they wait for, who is on them), its pull requests and where each stands in QA, and its settings. Call this first.", {}, () => run(() => h.floorStatus())),
    tool(
      'write_brief',
      'Post a decision brief on a needs-input issue or a held PR that has none, for an executive who has not read the code. The office adds the deadline; if the manager does not reply by then, it applies your recommendation.',
      {
        floor: FLOOR,
        number: z.number().int().positive().describe('The issue or PR number'),
        background: z.string().min(1).max(1500),
        decision: z.string().min(1).max(300),
        options: z.array(z.string().min(1).max(400)).min(2).max(5),
        recommendation: z.string().min(1).max(600),
        risk: z.string().min(1).max(600),
        if_no_reply: z.string().max(300).optional(),
      },
      mine((a) => h.writeBrief(a)),
    ),
    tool('retry_qa', 'Give a stuck pull request another QA round (a flaky session, or the problem has since been fixed).', { floor: FLOOR, pr: PR }, mine((a) => h.retryQa(a))),
    tool(
      'send_back',
      "Send a stuck pull request back to a developer with QA's findings plus your note, without another QA round first.",
      { floor: FLOOR, pr: PR, note: z.string().min(1).max(1000).describe('What the developer should do, e.g. "Merge main and keep both toolbar changes."') },
      mine((a) => h.sendBack(a)),
    ),
    tool('rerun_checks', "Re-run the failed GitHub Actions runs on a stuck pull request's head commit (a flaky check or an outage).", { floor: FLOOR, pr: PR }, mine((a) => h.rerunChecks(a))),
    tool(
      'close_pull',
      'Close a stuck pull request that is the wrong approach, with your comment on it. Its issue stays open so it is built again. Refused for a PR held for a business reason.',
      { floor: FLOOR, pr: PR, comment: z.string().min(1).max(1000).describe('Posted on the PR: why it is closed') },
      mine((a) => h.closePull(a)),
    ),
    tool(
      'rebuild',
      'Close a pull request stuck for a technical reason and have its issue built again from the default branch. The branch is kept for reference. Refused for a PR held for a business reason, or one that is already a rebuild.',
      { floor: FLOOR, pr: PR },
      mine((a) => h.rebuild(a)),
    ),
    tool(
      'escalate',
      'Hand a stuck pull request to the manager, only for a business decision only they can make. Carries a complete decision brief (every section filled), posted on the PR; anything less is refused.',
      { floor: FLOOR, pr: PR, brief: z.string().min(1).max(6000).describe(`The decision brief as markdown, starting with "## ${BRIEF_HEADING}"`) },
      mine((a) => h.escalate(a)),
    ),
  ];
  const make = () => createSdkMcpServer({ name: 'office', version: '1.0.0', tools: defs });
  const server = make();
  return {
    server,
    serve: () => make().instance,
    async call(name, args) {
      const def = defs.find((d) => d.name === name);
      if (!def) throw new Error(`No office tool ${name}`);
      const res = (await def.handler(args as never, undefined)) as { content: { text?: string }[] };
      return res.content.map((c) => c.text ?? '').join('\n');
    },
  };
}

/** The lead's tool names, for the tests and the prompt preview. */
export const LEAD_TOOLS = ['floor_status', 'write_brief', 'retry_qa', 'send_back', 'rerun_checks', 'close_pull', 'rebuild', 'escalate'] as const;
