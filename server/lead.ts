import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BRIEF_HEADING, BRIEF_TEMPLATE, briefGaps, parseBrief, type Brief } from '../shared/brief.ts';
import type { EffortLevel, LeadSettings } from '../shared/types.ts';
import type { OfficeTools } from './ceo.ts';
import { ONE_TURN } from './prompts.ts';
import { MAX_TRIAGES, type TriagePr } from './triage.ts';

// The floor lead (docs/floor-lead.md): one standing employee per floor, extra to its team, who owns the floor's stuck
// pull requests from start to finish and keeps its board (Kanban) in order. The office wakes it on events (a PR
// becomes needs-human, the ready backlog drops below minReady, an issue is held or keeps failing) and every 4 hours,
// and it acts through its own office tools, never a shell. The limits are the tools': it can't merge, can't message
// the manager (only a decision brief through escalate reaches them), can't file new work (only a split's parts) and
// can't push. Every board change it makes is logged with its undo (boardLog.ts). Pure: the rules, prompts and tool
// definitions; swarm.ts runs the sessions and the GitHub calls.

// ---------- jobs ----------

/** Why a board job runs: the 4-hourly clean-up, the ready backlog dropping below minReady, an issue held after its PR
 * closed, or an issue skipped after failed sessions. */
export type BoardReason = 'cleanup' | 'low-backlog' | 'held' | 'failing';

/** What wakes a floor lead: a stuck PR to triage, or its board to look after. */
export type LeadJob = { kind: 'triage'; prNumber: number; at: number } | { kind: 'board'; reasons: BoardReason[]; at: number };
export type LeadJobKind = LeadJob['kind'];

/** How often the lead cleans up its board when nothing else wakes it (skipped when the board hasn't changed). */
export const LEAD_CLEANUP_MS = 4 * 60 * 60_000;

/** A floor lead's work: its queue, the job it is on, and what its board looked like at the last clean-up. */
export interface LeadState {
  queue: LeadJob[];
  job: LeadJob | null;
  lastCleanupAt: number | null;
  low: boolean; // the ready backlog was below minReady at the last look (a board job wakes when it drops, not while it stays low)
  fingerprint: string | null; // the board at the last clean-up: unchanged means the next one is skipped
}

const REASONS: BoardReason[] = ['cleanup', 'low-backlog', 'held', 'failing'];

const isJob = (j: unknown): j is LeadJob => {
  const x = j as Partial<{ kind: string; prNumber: number; reasons: unknown; at: number }> | null;
  if (!x || typeof x !== 'object' || typeof x.at !== 'number') return false;
  if (x.kind === 'triage') return Number.isInteger(x.prNumber);
  return x.kind === 'board' && Array.isArray(x.reasons) && x.reasons.every((r) => REASONS.includes(r as BoardReason));
};

/** A fresh lead's state. */
export const newLeadState = (): LeadState => ({ queue: [], job: null, lastCleanupAt: null, low: false, fingerprint: null });

/** The leads' saved state, with anything unreadable dropped. A job cut off by a restart goes back to the front of its queue. */
export function loadLeads(raw: unknown): Record<string, LeadState> {
  const out: Record<string, LeadState> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [repoId, v] of Object.entries(raw as Record<string, Partial<LeadState>>)) {
    const queue = Array.isArray(v?.queue) ? v.queue.filter(isJob) : [];
    out[repoId] = {
      ...newLeadState(),
      queue: isJob(v?.job) ? enqueueLead(queue, v.job, true) : queue,
      lastCleanupAt: typeof v?.lastCleanupAt === 'number' ? v.lastCleanupAt : null,
      low: v?.low === true,
      fingerprint: typeof v?.fingerprint === 'string' ? v.fingerprint : null,
    };
  }
  return out;
}

/** A queue with the job added: one triage per PR (a newer one replaces it), one board job with every reason. front: first in line. */
export function enqueueLead(queue: readonly LeadJob[], job: LeadJob, front = false): LeadJob[] {
  const same = queue.findIndex((j) => j.kind === job.kind && (j.kind === 'board' || (job.kind === 'triage' && j.prNumber === job.prNumber)));
  if (same < 0) return front ? [job, ...queue] : [...queue, job];
  const old = queue[same];
  const merged: LeadJob = old.kind === 'board' && job.kind === 'board' ? { kind: 'board', reasons: REASONS.filter((r) => old.reasons.includes(r) || job.reasons.includes(r)), at: Math.min(old.at, job.at) } : job;
  return queue.map((j, i) => (i === same ? merged : j));
}

/** The job a free lead takes next: stuck PRs first, oldest first, then the board. */
export function nextLeadJob(queue: readonly LeadJob[]): LeadJob | null {
  return [...queue].sort((x, y) => Number(x.kind === 'board') - Number(y.kind === 'board') || x.at - y.at)[0] ?? null;
}

/**
 * The timer and backlog wake rules, checked on every scheduler pass: a board job when the ready backlog drops below
 * minReady (once per drop, not on every pass while it stays low), and the clean-up every LEAD_CLEANUP_MS, skipped
 * (only its clock reset) when the board hasn't changed since the last one. A fresh lead cleans up at once.
 */
export function boardWake(x: { now: number; state: Pick<LeadState, 'lastCleanupAt' | 'low' | 'fingerprint'>; ready: number; minReady: number; fingerprint: string }): {
  reasons: BoardReason[];
  low: boolean;
  skipCleanup: boolean;
} {
  const low = x.ready < x.minReady;
  const reasons: BoardReason[] = low && !x.state.low ? ['low-backlog'] : [];
  const due = x.state.lastCleanupAt === null || x.now - x.state.lastCleanupAt >= LEAD_CLEANUP_MS;
  const unchanged = x.state.lastCleanupAt !== null && x.fingerprint === x.state.fingerprint;
  if (due && !unchanged) reasons.unshift('cleanup');
  return { reasons, low, skipCleanup: due && unchanged };
}

// ---------- business holds on issues ----------

/** Labels only the manager sets or clears: the lead's relabel never touches them. */
export const PROTECTED_LABELS = ['swarm:hold', 'swarm:skip', 'needs-input', 'decided:default', 'decided:manager'];

/**
 * Why an issue is held for a business reason, or null: the swarm:hold label, needs-input (a decision for the manager),
 * or a decision brief on it. The lead may not close, merge away or split such an issue.
 */
export function issueBusinessHold(i: { labels: readonly string[]; brief: boolean }): string | null {
  const l = i.labels.map((x) => x.toLowerCase());
  if (l.includes('swarm:hold')) return 'label swarm:hold';
  if (l.includes('needs-input')) return 'it waits for the manager (needs-input)';
  if (i.brief) return 'it has a decision brief';
  return null;
}

/** Labels a relabel may add or remove. Throws a message the lead can act on for a protected one. */
export function checkRelabel(add: readonly string[], remove: readonly string[]) {
  const bad = [...add, ...remove].find((l) => PROTECTED_LABELS.includes(l.trim().toLowerCase()));
  if (bad) throw new Error(`${bad} is the manager's label: only they set or clear it.`);
  if (!add.length && !remove.length) throw new Error('Name a label to add or remove.');
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
 * the office's for that kind of job. A board job always runs on the cheap model.
 */
export function leadModel(kind: LeadJobKind, agent: { model: string; effort: EffortLevel | '' }, s: LeadSettings): { model: string; effort: EffortLevel } {
  if (kind === 'board') return { model: s.cleanupModel || DEFAULT_LEAD_SETTINGS.cleanupModel, effort: s.cleanupEffort };
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
    "- You never decide new work: you split, merge, close and order the issues that exist, and file issues only as a split's parts. You never push code.",
    "- You never close, merge away or split an issue held for a business reason (swarm:hold, needs-input, a decision brief), and never touch the manager's labels.",
    '- Every board change is logged, and the manager can undo it: make the ones you would defend.',
    `- Your final message is for the office log, not the manager: one line on what you did.`,
  ].join('\n');
}

/** What a board job's prompt says about the board. */
export interface BoardFacts {
  ready: number; // issues ready to start now
  minReady: number;
  held: { issue: number; title: string; pr: number }[]; // open issues whose PR a person closed
  failing: { issue: number; title: string; failures: number }[]; // issues auto-assign skips after failed sessions
}

const BOARD_WHY: Record<BoardReason, string> = {
  cleanup: 'the regular clean-up',
  'low-backlog': 'fewer issues are ready to start than the floor keeps',
  held: 'an issue waits after its pull request was closed',
  failing: 'an issue keeps failing its sessions',
};

export function leadJobPrompt(job: LeadJob, floor: { floor: number; fullName: string; clone: string }, pr: TriagePr | null, board?: BoardFacts | null): string {
  if (job.kind === 'board') return boardPrompt(job.reasons, floor, board ?? { ready: 0, minReady: 0, held: [], failing: [] });
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

function boardPrompt(reasons: BoardReason[], floor: { floor: number; fullName: string; clone: string }, b: BoardFacts): string {
  return [
    `Board: look after floor ${floor.floor}'s board (${floor.fullName}, read-only clone at ${floor.clone}). Why now: ${reasons.map((r) => BOARD_WHY[r]).join('; ')}.`,
    `${b.ready} issue${b.ready === 1 ? ' is' : 's are'} ready to start; the floor keeps ${b.minReady}.`,
    ...(b.held.length ? ['Issues whose pull request a person closed (they wait until you decide):', ...b.held.map((h) => `- #${h.issue} "${h.title}" (PR #${h.pr} closed): read why it was closed, then release_issue it, or close_issue it if it is no longer wanted.`)] : []),
    ...(b.failing.length ? ['Issues auto-assign skips after failed sessions:', ...b.failing.map((f) => `- #${f.issue} "${f.title}" (${f.failures} failed): split_issue it if it is too big for one PR, else release_issue it with a note for the next developer, or close_issue it if it is obsolete.`)] : []),
    '',
    'Then tidy the board, only where it clearly helps:',
    '- merge_duplicates for two issues that ask for the same thing; close_issue for one that is stale or superseded, with a short note;',
    '- split_issue for one too big for a single pull request (its parts cover exactly its scope, nothing new);',
    '- set_dependencies where an issue truly waits for another; relabel for wrong labels;',
    '- reorder_backlog so the work that unblocks the most, or that the brief needs first, starts next.',
    'If the board is fine, change nothing.',
  ].join('\n');
}

export function leadJobLabel(job: LeadJob) {
  return job.kind === 'triage' ? `Triaging PR #${job.prNumber}` : job.reasons.includes('cleanup') ? 'Cleaning up the board' : 'Looking after the board';
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
  closeIssue(a: { number: number; note: string }): Promise<string>;
  mergeDuplicates(a: { keep: number; duplicate: number; note: string }): Promise<string>;
  relabel(a: { number: number; add?: string[]; remove?: string[] }): Promise<string>;
  reorderBacklog(a: { order: number[] }): Promise<string>;
  splitIssue(a: { number: number; parts: { title: string; body: string }[]; note: string }): Promise<string>;
  setDependencies(a: { number: number; depends_on: number[] }): Promise<string>;
  releaseIssue(a: { number: number; note?: string }): Promise<string>;
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
    tool(
      'close_issue',
      'Close a stale or superseded open issue as "not planned", with your note as a comment. Logged; the manager can reopen it. Refused for an issue held for a business reason, one in progress, or one an open PR closes.',
      { floor: FLOOR, number: z.number().int().positive(), note: z.string().min(1).max(1000).describe('Why, e.g. "Superseded by #152."') },
      mine((a) => h.closeIssue(a)),
    ),
    tool(
      'merge_duplicates',
      'Two open issues ask for the same thing: close the duplicate (with a comment pointing at the one kept) and add a note on the kept one with what the duplicate adds. Logged; the manager can undo it.',
      { floor: FLOOR, keep: z.number().int().positive(), duplicate: z.number().int().positive(), note: z.string().min(1).max(600).describe('What the duplicate adds to the kept issue, if anything') },
      mine((a) => h.mergeDuplicates(a)),
    ),
    tool(
      'relabel',
      "Add or remove labels on an open issue. Never the manager's labels (swarm:hold, swarm:skip, needs-input, decided:*). Logged.",
      { floor: FLOOR, number: z.number().int().positive(), add: z.array(z.string().min(1).max(50)).max(5).optional(), remove: z.array(z.string().min(1).max(50)).max(5).optional() },
      mine((a) => h.relabel(a)),
    ),
    tool(
      'reorder_backlog',
      'Put open issues first in the backlog, in this order: free agents take the first one ready to start. Issues not named keep their order after these. Logged; the manager can restore the old order.',
      { floor: FLOOR, order: z.array(z.number().int().positive()).min(1).max(30).describe('Issue numbers, the next to start first') },
      mine((a) => h.reorderBacklog(a)),
    ),
    tool(
      'split_issue',
      'Split an open issue too big for one pull request into 2 to 5 issues that together cover exactly its scope (nothing new), then close it as not planned pointing at them. Logged; the manager can undo it.',
      {
        floor: FLOOR,
        number: z.number().int().positive(),
        parts: z
          .array(z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(4000).describe('Its part of the original scope, with acceptance criteria') }))
          .min(2)
          .max(5),
        note: z.string().min(1).max(600).describe('Why it is split, posted on the original'),
      },
      mine((a) => h.splitIssue(a)),
    ),
    tool(
      'set_dependencies',
      'Rewrite the "Depends on #N" line of an open issue (not one in progress). The rest of the body stays. Logged.',
      { floor: FLOOR, number: z.number().int().positive(), depends_on: z.array(z.number().int().positive()).max(10).describe('Issues it waits for; [] for none') },
      mine((a) => h.setDependencies(a)),
    ),
    tool(
      'release_issue',
      'Put an issue that waits after its PR was closed, or that auto-assign skips after failed sessions, back in line for the next free agent, with an optional note for them. Logged.',
      { floor: FLOOR, number: z.number().int().positive(), note: z.string().max(1000).optional().describe('Posted on the issue for the next developer') },
      mine((a) => h.releaseIssue(a)),
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
export const LEAD_TOOLS = [
  'floor_status',
  'write_brief',
  'retry_qa',
  'send_back',
  'rerun_checks',
  'close_pull',
  'rebuild',
  'escalate',
  'close_issue',
  'merge_duplicates',
  'relabel',
  'reorder_backlog',
  'split_issue',
  'set_dependencies',
  'release_issue',
] as const;
