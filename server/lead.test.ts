import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { renderBrief, type Brief } from '../shared/brief.ts';
import { noShell } from './clis.ts';
import {
  boardWake,
  checkRelabel,
  createLeadTools,
  issueBusinessHold,
  LEAD_CLEANUP_MS,
  newLeadState,
  DEFAULT_LEAD_SETTINGS,
  enqueueLead,
  escalationBrief,
  LEAD_TOOLS,
  leadJobPrompt,
  leadModel,
  leadSettings,
  leadSystemPrompt,
  loadLeads,
  nextLeadJob,
  stuckStep,
  type LeadHandlers,
  type LeadJob,
} from './lead.ts';
import { MAX_TRIAGES } from './triage.ts';

const job = (prNumber: number, at = 0): LeadJob => ({ kind: 'triage', prNumber, at });

describe('wake rules: who gets a stuck PR', () => {
  it('goes to the floor lead while it has tries left', () => {
    expect(stuckStep({ lead: true, triages: 0 })).toBe('triage');
    expect(stuckStep({ lead: true, triages: MAX_TRIAGES - 1 })).toBe('triage');
  });
  it('falls back on the office (rebuild, or the manager for a business hold) when the tries are spent', () => {
    expect(stuckStep({ lead: true, triages: MAX_TRIAGES })).toBe('give-up');
  });
  it('falls back on the office at once on a floor without a lead', () => {
    expect(stuckStep({ lead: false, triages: 0 })).toBe('give-up');
  });
});

describe('the lead’s queue', () => {
  it('keeps one triage per PR, the newest', () => {
    const q = enqueueLead(enqueueLead([job(4, 1)], job(7, 2)), job(4, 3));
    expect(q).toEqual([job(4, 3), job(7, 2)]);
  });
  it('takes the oldest stuck PR first', () => {
    expect(nextLeadJob([job(9, 30), job(3, 10), job(5, 20)])).toEqual(job(3, 10));
    expect(nextLeadJob([])).toBeNull();
  });
  it('keeps one board job, with every reason it was woken for', () => {
    const q = enqueueLead(enqueueLead([job(4, 5)], { kind: 'board', reasons: ['held'], at: 3 }), { kind: 'board', reasons: ['low-backlog', 'held'], at: 9 });
    expect(q).toEqual([job(4, 5), { kind: 'board', reasons: ['low-backlog', 'held'], at: 3 }]);
  });
  it('triages stuck PRs before looking after the board', () => {
    expect(nextLeadJob([{ kind: 'board', reasons: ['cleanup'], at: 1 }, job(8, 50)])).toEqual(job(8, 50));
  });
  it('loads saved state, putting a job cut off by a restart back at the front', () => {
    expect(loadLeads({ 'a/b': { queue: [job(5, 2), { kind: 'nope' }], job: job(3, 1), lastCleanupAt: 7, low: true }, 'c/d': null })).toEqual({
      'a/b': { ...newLeadState(), queue: [job(3, 1), job(5, 2)], lastCleanupAt: 7, low: true },
      'c/d': newLeadState(),
    });
    expect(loadLeads({ x: { queue: [{ kind: 'board', reasons: ['cleanup', 'bogus'], at: 1 }, { kind: 'board', reasons: ['held'], at: 2 }] } }).x.queue).toEqual([{ kind: 'board', reasons: ['held'], at: 2 }]);
    expect(loadLeads(undefined)).toEqual({});
  });
});

describe('wake rules: the board', () => {
  const now = 10 * LEAD_CLEANUP_MS;
  const quiet = { lastCleanupAt: now - 60_000, low: false, fingerprint: 'f1' };
  it('cleans up as soon as a lead arrives', () => {
    expect(boardWake({ now, state: newLeadState(), ready: 9, minReady: 5, fingerprint: 'f1' })).toEqual({ reasons: ['cleanup'], low: false, skipCleanup: false });
  });
  it('cleans up every 4 hours when the board changed', () => {
    expect(boardWake({ now, state: { ...quiet, lastCleanupAt: now - LEAD_CLEANUP_MS }, ready: 9, minReady: 5, fingerprint: 'f2' }).reasons).toEqual(['cleanup']);
    expect(boardWake({ now, state: { ...quiet, lastCleanupAt: now - LEAD_CLEANUP_MS + 1 }, ready: 9, minReady: 5, fingerprint: 'f2' }).reasons).toEqual([]);
  });
  it('skips a clean-up when nothing changed since the last one: only its clock resets', () => {
    expect(boardWake({ now, state: { ...quiet, lastCleanupAt: now - LEAD_CLEANUP_MS }, ready: 9, minReady: 5, fingerprint: 'f1' })).toEqual({ reasons: [], low: false, skipCleanup: true });
  });
  it('wakes when the ready backlog drops below minReady, once per drop', () => {
    expect(boardWake({ now, state: quiet, ready: 4, minReady: 5, fingerprint: 'f1' })).toEqual({ reasons: ['low-backlog'], low: true, skipCleanup: false });
    expect(boardWake({ now, state: { ...quiet, low: true }, ready: 2, minReady: 5, fingerprint: 'f1' }).reasons).toEqual([]);
    expect(boardWake({ now, state: { ...quiet, low: true }, ready: 5, minReady: 5, fingerprint: 'f1' }).low).toBe(false);
  });
});

describe('business holds on issues', () => {
  it('holds swarm:hold, needs-input and a decision brief', () => {
    expect(issueBusinessHold({ labels: ['Swarm:Hold'], brief: false })).toBe('label swarm:hold');
    expect(issueBusinessHold({ labels: ['needs-input'], brief: false })).toMatch(/needs-input/);
    expect(issueBusinessHold({ labels: [], brief: true })).toBe('it has a decision brief');
    expect(issueBusinessHold({ labels: ['bug', 'ui'], brief: false })).toBeNull();
  });
  it("never lets the lead touch the manager's labels", () => {
    expect(() => checkRelabel(['swarm:hold'], [])).toThrow(/manager's label/);
    expect(() => checkRelabel([], ['needs-input'])).toThrow(/manager's label/);
    expect(() => checkRelabel([], ['Decided:Default'])).toThrow(/manager's label/);
    expect(() => checkRelabel([], [])).toThrow(/Name a label/);
    expect(() => checkRelabel(['bug'], ['enhancement'])).not.toThrow();
  });
});

describe('models', () => {
  const none = { model: '', effort: '' as const };
  it('diagnoses stuck PRs on the strong model, like the CEO: its own when set, else the office’s', () => {
    expect(leadModel('triage', none, DEFAULT_LEAD_SETTINGS)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect(leadModel('triage', { model: 'claude-fable-5-1', effort: 'max' }, DEFAULT_LEAD_SETTINGS)).toEqual({ model: 'claude-fable-5-1', effort: 'max' });
  });
  it('looks after the board on the cheap model, whatever the lead’s own', () => {
    expect(leadModel('board', { model: 'claude-opus-5-5', effort: 'max' }, DEFAULT_LEAD_SETTINGS)).toEqual({ model: 'claude-sonnet-5', effort: 'low' });
  });
  it('are configurable, with bad values kept at what they were', () => {
    const s = leadSettings(DEFAULT_LEAD_SETTINGS, { triageModel: ' claude-opus-5 ', triageEffort: 'xhigh', cleanupModel: 42, cleanupEffort: 'lots', extra: 1 });
    expect(s).toEqual({ triageModel: 'claude-opus-5', triageEffort: 'xhigh', cleanupModel: 'claude-sonnet-5', cleanupEffort: 'low' });
    expect(leadSettings(DEFAULT_LEAD_SETTINGS, null)).toEqual(DEFAULT_LEAD_SETTINGS);
  });
});

const BRIEF: Brief = {
  background: 'The PR adds paid exports, which the brief never mentioned.',
  decision: 'Should exports be a paid feature?',
  options: ['Paid: more revenue, more support.', 'Free: simpler, no revenue.'],
  recommendation: 'Free for now: the brief is about adoption.',
  risk: 'Lost revenue; easy to add a paywall later.',
  ifNoReply: 'The office ships it free.',
};

describe('escalate is business only: it carries a complete brief', () => {
  it('accepts a complete brief', () => {
    expect(escalationBrief(renderBrief(BRIEF))).toMatchObject({ decision: BRIEF.decision, options: BRIEF.options });
  });
  it('refuses an escalation without a brief', () => {
    expect(() => escalationBrief('It keeps conflicting with main, please look.')).toThrow(/needs a decision brief/);
    expect(() => escalationBrief('')).toThrow(/needs a decision brief/);
  });
  it('refuses a brief with gaps, naming them', () => {
    expect(() => escalationBrief(renderBrief({ ...BRIEF, risk: '', recommendation: '' }).replace(/_\(not given\)_/g, ''))).toThrow(/missing Recommendation, Risk and mitigation/);
  });
  it('refuses a brief with a single option: there is nothing to decide', () => {
    expect(() => escalationBrief(renderBrief({ ...BRIEF, options: ['Just merge it.'] }))).toThrow(/at least two options/);
  });
});

describe('prompts', () => {
  const floor = { floor: 2, fullName: 'acme/app', clone: '/clones/app' };
  const pr = {
    number: 108,
    title: 'Jukebox volume',
    url: 'https://github.com/acme/app/pull/108',
    round: 3,
    why: 'it still conflicts with main after 3 fixes',
    summary: 'Works, but the slider overflows on phones.',
    fixInstructions: 'Wrap the slider below 480px.',
    mergeNote: 'the conflict was never resolved',
    checks: 'failing',
    failedChecks: ['CI / e2e'],
    pendingChecks: [],
    mergeable: 'CONFLICTING',
    mergeState: 'DIRTY',
    triage: 1,
  };
  it('gives a triage everything QA and GitHub know about the PR', () => {
    const prompt = leadJobPrompt(job(108), floor, pr);
    for (const fact of ['#108', 'Jukebox volume', 'QA round 3', pr.summary, pr.fixInstructions, pr.mergeNote, pr.why, 'GitHub checks: failing (failed: CI / e2e)', 'mergeable: CONFLICTING (DIRTY)', `triage 1 of ${MAX_TRIAGES}`, '## Decision brief']) {
      expect(prompt).toContain(fact);
    }
  });
  it('has nothing to do once the PR is no longer stuck', () => {
    expect(leadJobPrompt(job(108), floor, null)).toContain('no longer needs triage');
  });
  it('states the limits in the system prompt', () => {
    const system = leadSystemPrompt({ name: 'Quinn', floor: 2, fullName: 'acme/app', company: 'Acme', notesFile: 'n.md' });
    expect(system).toContain('You never merge');
    expect(system).toContain('You never message the manager');
    expect(system).toContain('You cannot run shell commands');
  });
});

describe('the lead’s tools', () => {
  const calls: string[] = [];
  const h: LeadHandlers = {
    floorStatus: () => '{}',
    writeBrief: async () => 'brief',
    retryQa: async (a) => (calls.push(`retry ${a.pr}`), 'ok'),
    sendBack: async () => 'ok',
    rerunChecks: async () => 'ok',
    closePull: async () => 'ok',
    rebuild: async () => 'ok',
    escalate: async () => 'ok',
    closeIssue: async () => 'ok',
    mergeDuplicates: async () => 'ok',
    relabel: async () => 'ok',
    reorderBacklog: async () => 'ok',
    splitIssue: async () => 'ok',
    setDependencies: async () => 'ok',
    releaseIssue: async () => 'ok',
  };
  const tools = createLeadTools(2, h);

  it('lists only what a lead may do: no merge, no new issues, no email or chat', async () => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await tools.server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...LEAD_TOOLS].sort());
    for (const never of ['merge', 'merge_pull', 'file_issue', 'send_email', 'scale_team', 'message_manager']) expect(names).not.toContain(never);
  });

  it("refuses another floor's PR", async () => {
    expect(await tools.call('retry_qa', { floor: 3, pr: 5 })).toBe("Refused: You lead floor 2: floor 3 isn't yours to change.");
    expect(await tools.call('retry_qa', { floor: 2, pr: 5 })).toBe('ok');
    expect(calls).toEqual(['retry 5']);
  });

  it('has no shell, so it cannot push: the CEO and leads run Claude Code without Bash', () => {
    expect(noShell('lead')).toBe(true);
    expect(noShell('ceo')).toBe(true);
    expect(noShell('agent')).toBe(false);
  });
});
