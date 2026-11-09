import { describe, expect, it, vi } from 'vitest';
import { renderBrief } from '../shared/brief.ts';
import type { PullInfo } from '../shared/types.ts';
import type { Backend } from './backend.ts';
import { createDemoBackend } from './demo.ts';
import type { OfficeTools } from './ceo.ts';
import { MAX_TRIAGES } from './triage.ts';
import { Swarm } from './swarm.ts';

// The floor lead (docs/floor-lead.md) in a demo office: a stuck PR goes to the lead first, its tools enforce the
// limits (business holds, escalate = business only), and the office's own give-up rebuilds instead of waiting for the
// manager: a PR stuck for an unknown reason, one that is only "not routine", and a rebuild GitHub refused.

type Rec = { repoId: string; prNumber: number; status: string; escalated: boolean; triages: number; stuckWhy: string | null; rebuildRetryAt: number | null; heldFor?: string | null };
type Internals = {
  state: { agents: { id: string; role: string; repoId: string; desk: number }[]; qa: Rec[]; leads: Record<string, { queue: { prNumber: number }[]; job: unknown }>; rebuilds: { issue: number; count: number }[] };
  repoRt: Map<string, { pulls: PullInfo[]; issues: unknown[] }>;
  stuck(rec: Rec, patch: object, why: string): boolean;
  leadTools(repo: unknown): OfficeTools;
  repo(id: string): unknown;
  givingUp: Set<string>;
};

const PR = 46;

function pull(over: Partial<PullInfo> = {}): PullInfo {
  return {
    number: PR,
    title: 'Add visit schedule',
    url: `https://github.com/demo-co/pixel-todo/pull/${PR}`,
    headRefName: 'swarm/issue-12-kim',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'CONFLICTING',
    reviewDecision: null,
    closesIssues: [12],
    createdAt: new Date().toISOString(),
    mergedAt: null,
    additions: 30,
    deletions: 4,
    checks: 'passing',
    headSha: 'abc1234',
    mergeState: 'DIRTY',
    failedChecks: [],
    pendingChecks: [],
    labels: [],
    ...over,
  } as PullInfo;
}

function record(): Rec {
  return {
    repoId: 'demo-co/pixel-todo',
    prNumber: PR,
    status: 'failed',
    round: 3,
    devAgentId: null,
    qaAgentId: null,
    summary: null,
    checks: [],
    commentUrl: null,
    mergeNote: null,
    heldFor: null,
    updatedAt: 0,
    issueNumber: 12,
    devSessionId: null,
    fixInstructions: null,
    sessionFailures: 0,
    testedSha: null,
    passedSha: null,
    fixReason: null,
    mergeFixes: 5,
    retests: 0,
    preQa: null,
    noChangeSha: null,
    pendingSince: null,
    mergeRetryAt: null,
    alerted: false,
    rerunSha: null,
    rerunAt: null,
    qaChecks: null,
    stuckWhy: null,
    triages: 0,
    rebuildRetryAt: null,
    escalated: false,
    parkBy: null,
    parked: false,
  } as Rec;
}

async function office(opts: { lead?: boolean; routineOnly?: boolean; pull?: Partial<PullInfo>; files?: string[] } = {}) {
  const backend = createDemoBackend() as Backend;
  const closed: number[] = [];
  const comments: string[] = [];
  const p = pull(opts.pull);
  Object.assign(backend, {
    prDetails: async () => ({ ...p, body: '', checks: p.checks, failedChecks: [], pendingChecks: [] }),
    discussion: async () => ({ body: '', comments: [] }),
    prFiles: async () => opts.files ?? ['src/schedule.ts'],
    commentPull: async (_r: string, _n: number, body: string) => (comments.push(body), 'url'),
    commentIssue: async (_r: string, _n: number, body: string) => void comments.push(body),
    closePull: vi.fn(async (_r: string, n: number) => void closed.push(n)),
    issueDetails: async () => ({ title: 'Visit schedule', body: '' }),
  });
  const swarm = new Swarm(backend);
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  await new Promise((r) => setTimeout(r, 30)); // the first sync settles
  if (opts.lead === false) swarm.updateRepo(repo.id, { floorLead: false });
  if (opts.routineOnly === false) swarm.updateRepo(repo.id, { routineOnly: false });
  const internals = swarm as unknown as Internals;
  const rt = internals.repoRt.get(repo.id)!;
  rt.pulls = [p];
  const rec = record();
  internals.state.qa.push(rec);
  const settle = async () => {
    for (let i = 0; i < 20 && internals.givingUp.size; i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { swarm, repo, internals, rec, closed, comments, backend, settle, tools: () => internals.leadTools(internals.repo(repo.id)) };
}

const BRIEF = renderBrief({
  background: 'The PR also adds paid exports, which the brief never mentioned.',
  decision: 'Should exports be a paid feature?',
  options: ['Paid: more revenue, more support.', 'Free: simpler, no revenue.'],
  recommendation: 'Free for now: the brief is about adoption.',
  risk: 'Lost revenue; easy to add a paywall later.',
  ifNoReply: 'The office ships it free.',
});

describe('the floor lead on a floor', () => {
  it('is a standing employee extra to the team, at the highest free desk', async () => {
    const { swarm, repo, internals } = await office();
    const here = internals.state.agents.filter((a) => a.repoId === repo.id);
    expect(here.map((a) => a.role).sort()).toEqual(['agent', 'lead']);
    expect(here.find((a) => a.role === 'lead')!.desk).toBe(14);
    expect(swarm.snapshot().agents.find((a) => a.role === 'lead')).toMatchObject({ repoId: repo.id, career: null });
    // turning it off removes it; the team stays
    swarm.updateRepo(repo.id, { floorLead: false });
    expect(internals.state.agents.filter((a) => a.repoId === repo.id).map((a) => a.role)).toEqual(['agent']);
  });

  it("can't be let go, given issues or messaged: it works from the floor's events", async () => {
    const { swarm, internals } = await office();
    const lead = internals.state.agents.find((a) => a.role === 'lead')!;
    expect(() => swarm.fireAgent(lead.id)).toThrow(/floor lead/);
    await expect(swarm.assign(lead.id, 1)).rejects.toThrow(/floor lead/);
    await expect(swarm.message(lead.id, 'hi')).rejects.toThrow(/floor lead/);
  });

  it('gets a stuck PR first, instead of the CEO', async () => {
    const { internals, rec, repo } = await office();
    expect(internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes')).toBe(true);
    expect(internals.state.leads[repo.id].queue.map((j) => j.prNumber)).toEqual([PR]);
    expect(rec).toMatchObject({ status: 'needs-human', triages: 1, escalated: false });
  });
});

describe("the lead's limits, enforced by its tools", () => {
  const onTriage = async (o: Parameters<typeof office>[0] = {}) => {
    const x = await office(o);
    x.internals.stuck(x.rec, {}, 'it still conflicts with main after 5 fixes');
    const l = x.internals.state.leads[x.repo.id];
    l.job = l.queue.shift(); // as runLeadJob does
    return x;
  };

  it('refuses to close or rebuild a PR held with swarm:hold', async () => {
    const { tools, closed } = await onTriage({ pull: { labels: ['swarm:hold'] } });
    expect(await tools().call('close_pull', { floor: 1, pr: PR, comment: 'Wrong approach.' })).toMatch(/^Refused: .*business reason \(label swarm:hold\)/);
    expect(await tools().call('rebuild', { floor: 1, pr: PR })).toMatch(/^Refused: .*business reason/);
    expect(closed).toEqual([]);
  });

  it('refuses to close a PR touching a hold path', async () => {
    const { swarm, repo, tools, closed } = await onTriage({ files: ['server/payments/charge.ts'] });
    swarm.updateRepo(repo.id, { holdPaths: ['server/payments/'] });
    expect(await tools().call('close_pull', { floor: 1, pr: PR, comment: 'Wrong approach.' })).toMatch(/^Refused: .*server\/payments\/charge\.ts/);
    expect(closed).toEqual([]);
  });

  it('refuses an escalation without a complete decision brief', async () => {
    const { tools, rec } = await onTriage();
    expect(await tools().call('escalate', { floor: 1, pr: PR, brief: 'Please look, it keeps conflicting.' })).toMatch(/^Refused: Escalate needs a decision brief/);
    expect(await tools().call('escalate', { floor: 1, pr: PR, brief: '## Decision brief\n### The decision\nShip it?' })).toMatch(/^Refused: The decision brief is missing Background/);
    expect(rec.escalated).toBe(false);
  });

  it('escalates a business decision with its brief posted on the PR', async () => {
    const { tools, rec, comments } = await onTriage();
    expect(await tools().call('escalate', { floor: 1, pr: PR, brief: BRIEF })).toMatch(/The manager has PR #46 now/);
    expect(rec.escalated).toBe(true);
    expect(comments.some((c) => c.includes('## Decision brief') && c.includes('Should exports be a paid feature?'))).toBe(true);
  });

  it("acts only on its own floor's current triage", async () => {
    const { tools } = await office(); // stuck, but no triage job running
    expect(await tools().call('retry_qa', { floor: 1, pr: PR })).toMatch(/^Refused: Triage tools only work in a triage job/);
    expect(await tools().call('retry_qa', { floor: 2, pr: PR })).toMatch(/^Refused: You lead floor 1/);
  });
});

describe('the office gives up by rebuilding, not by asking the manager', () => {
  it('rebuilds at once on a floor without a lead', async () => {
    const { internals, rec, closed, settle } = await office({ lead: false });
    expect(internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes')).toBe(false);
    await settle();
    expect(closed).toEqual([PR]);
    expect(internals.state.rebuilds.find((r) => r.issue === 12)?.count).toBe(1);
  });

  it('rebuilds a PR stuck for an unknown reason (wait 5)', async () => {
    const { internals, rec, closed, settle } = await office({ lead: false });
    internals.stuck(rec, {}, 'something nobody expected');
    await settle();
    expect(closed).toEqual([PR]);
    expect(rec.escalated).toBe(false);
  });

  it('rebuilds a PR that is only "not routine" (wait 6)', async () => {
    const { internals, rec, closed, settle } = await office({ lead: false, files: ['package.json'] });
    internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes');
    await settle();
    expect(closed).toEqual([PR]);
  });

  it('still hands a swarm:hold PR to the manager', async () => {
    const { internals, rec, closed, settle } = await office({ lead: false, pull: { labels: ['swarm:hold'] } });
    internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes');
    await settle();
    expect(closed).toEqual([]);
    expect(rec.escalated).toBe(true);
  });

  it('tries a rebuild GitHub refused again later instead of escalating (wait 7)', async () => {
    const { internals, rec, backend, settle } = await office({ lead: false });
    (backend.closePull as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 502'));
    internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes');
    await settle();
    expect(rec.escalated).toBe(false);
    expect(rec.rebuildRetryAt).toBeGreaterThan(Date.now());
  });

  it('gives up after the lead used its tries', async () => {
    const { internals, rec, closed, settle } = await office();
    rec.triages = MAX_TRIAGES;
    expect(internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes')).toBe(false);
    await settle();
    expect(closed).toEqual([PR]);
  });
});

describe("the lead's session", () => {
  it('starts on a stuck PR, acts through its tools and finishes without errors (demo session)', { timeout: 30_000 }, async () => {
    const { internals, rec, repo } = await office();
    const x = internals as unknown as Internals & { startLeadWork(): void; agentRt: Map<string, { log: { text: string }[] }> };
    const rt = internals.repoRt.get(repo.id) as unknown as { cloneStatus: string; lastSync: number | null };
    for (let i = 0; i < 50 && (rt.cloneStatus !== 'ready' || rt.lastSync == null); i++) await new Promise((r) => setTimeout(r, 20));
    internals.stuck(rec, {}, 'it still conflicts with main after 5 fixes');
    x.startLeadWork();
    const lead = internals.state.agents.find((a) => a.role === 'lead' && a.repoId === repo.id)! as unknown as { id: string; status: string; lastError: string | null; model: string };
    expect(lead.status).toBe('working');
    for (let i = 0; i < 200 && lead.status === 'working'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(lead).toMatchObject({ status: 'done', lastError: null });
    const log = x.agentRt.get(lead.id)!.log.map((l) => l.text).join('\n');
    expect(log).toContain('Triaging PR #46');
    expect(log).toContain('claude-opus-5-5 · high effort · floor lead'); // the strong model for a diagnosis
    expect(log).toMatch(/floor_status[\s\S]*send_back PR #46/);
    expect(internals.state.leads[repo.id].job).toBeNull();
  });
});

// ---------- the board (PR B) ----------

type BoardInternals = Omit<Internals, 'state' | 'repoRt'> & {
  state: Internals['state'] & { boardLog: { id: string; change: { kind: string }; undoneAt: number | null }[]; order: Record<string, number[]>; held: { repoId: string; issue: number; pr: number; since?: number; parked?: boolean }[] };
  repoRt: Map<string, { pulls: PullInfo[]; issues: { number: number; title: string; body: string; labels: string[] }[] }>;
  syncRepo(id: string): Promise<void>;
  readyIssues(repo: unknown): { issue: { number: number } }[];
  issueFailures: Map<string, { count: number; at: number }>;
  issueFailed(repo: unknown, n: number): void;
  waitsTick(now?: number): void;
  holdIssues(repo: unknown, pr: object): void;
  bootAt: number;
};

async function board() {
  const backend = createDemoBackend() as Backend;
  const swarm = new Swarm(backend);
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  const internals = swarm as unknown as BoardInternals;
  await internals.syncRepo(repo.id);
  const issues = () => internals.repoRt.get(repo.id)!.issues;
  const open = async () => (await backend.listIssues(repo.fullName)).map((i) => i.number);
  const tools = internals.leadTools(internals.repo(repo.id));
  const log = () => internals.state.boardLog;
  const undoLast = () => swarm.undoBoardChange(log()[log().length - 1].id);
  return { swarm, repo, internals, backend, issues, open, tools, log, undoLast, r: internals.repo(repo.id) };
}

// The demo's fake GitHub is shared by every office in this file: each test uses issues of its own.
describe("the lead's board tools, each logged and undone", () => {
  it('closes a stale issue; undo reopens it', async () => {
    const b = await board();
    expect(await b.tools.call('close_issue', { floor: 1, number: 6, note: 'Fixed by #2 already.' })).toMatch(/^Closed #6/);
    expect(await b.open()).not.toContain(6);
    expect(b.log().at(-1)!.change.kind).toBe('close');
    await b.undoLast();
    expect(await b.open()).toContain(6);
    expect(b.log().at(-1)!.undoneAt).not.toBeNull();
    await expect(b.undoLast()).rejects.toThrow(/already undone/);
  });

  it('merges a duplicate; undo reopens it and removes the note', async () => {
    const b = await board();
    const before = (await b.backend.issueDetails('demo-co/pixel-todo', 1)).body;
    expect(await b.tools.call('merge_duplicates', { floor: 1, keep: 1, duplicate: 4, note: 'Same screen.' })).toMatch(/Merged #4 into #1/);
    expect(await b.open()).not.toContain(4);
    expect((await b.backend.issueDetails('demo-co/pixel-todo', 1)).body).toContain('**Also covers #4**');
    await b.undoLast();
    expect(await b.open()).toContain(4);
    expect((await b.backend.issueDetails('demo-co/pixel-todo', 1)).body).toBe(before);
  });

  it('relabels; undo puts the labels back. The manager’s labels are refused', async () => {
    const b = await board();
    expect(await b.tools.call('relabel', { floor: 1, number: 5, add: ['ux'] })).toMatch(/Relabelled #5/);
    expect((await b.backend.listIssues('demo-co/pixel-todo')).find((i) => i.number === 5)!.labels).toContain('ux');
    await b.undoLast();
    expect((await b.backend.listIssues('demo-co/pixel-todo')).find((i) => i.number === 5)!.labels).not.toContain('ux');
    expect(await b.tools.call('relabel', { floor: 1, number: 5, add: ['swarm:hold'] })).toMatch(/^Refused: swarm:hold is the manager's label/);
  });

  it('reorders the backlog, which auto-assign follows; undo restores the order', async () => {
    const b = await board();
    expect(b.internals.readyIssues(b.r)[0].issue.number).not.toBe(3);
    await b.tools.call('reorder_backlog', { floor: 1, order: [3, 2] });
    expect(b.internals.readyIssues(b.r).slice(0, 2).map((x) => x.issue.number)).toEqual([3, 2]);
    await b.undoLast();
    expect(b.internals.state.order[b.repo.id]).toEqual([]);
    expect(await b.tools.call('reorder_backlog', { floor: 1, order: [999] })).toMatch(/^Refused: #999 isn't an open issue/);
  });

  it('splits an oversize issue into parts; undo closes the parts and reopens it', async () => {
    const b = await board();
    const out = await b.tools.call('split_issue', {
      floor: 1,
      number: 2,
      note: 'Two separate pieces.',
      parts: [
        { title: 'Due dates: data and picker', body: 'Store an optional due date.' },
        { title: 'Due dates: overdue highlight', body: 'Highlight overdue items.' },
      ],
    });
    const parts = [...out.matchAll(/#(\d+)/g)].map((m) => Number(m[1])).filter((n) => n !== 2);
    expect(parts).toHaveLength(2);
    expect(await b.open()).not.toContain(2);
    for (const n of parts) expect(await b.open()).toContain(n);
    await b.undoLast();
    expect(await b.open()).toContain(2);
    for (const n of parts) expect(await b.open()).not.toContain(n);
  });

  it('sets dependencies; undo sets them back', async () => {
    const b = await board();
    await b.tools.call('set_dependencies', { floor: 1, number: 3, depends_on: [5] });
    expect((await b.backend.issueDetails('demo-co/pixel-todo', 3)).body).toMatch(/^Depends on #5/);
    await b.undoLast();
    expect((await b.backend.issueDetails('demo-co/pixel-todo', 3)).body).not.toMatch(/Depends on/);
  });

  it('never closes, merges away or splits an issue held for a business reason, and files no new scope', async () => {
    const b = await board();
    const asks = b.issues().find((i) => i.labels.includes('needs-input'))!;
    expect(await b.tools.call('close_issue', { floor: 1, number: asks.number, note: 'Stale.' })).toMatch(/^Refused: .*business reason/);
    expect(await b.tools.call('merge_duplicates', { floor: 1, keep: 1, duplicate: asks.number, note: 'x' })).toMatch(/^Refused: .*business reason/);
    expect(await b.tools.call('split_issue', { floor: 1, number: asks.number, note: 'x', parts: [{ title: 'a', body: 'a' }, { title: 'b', body: 'b' }] })).toMatch(/^Refused: .*business reason/);
    expect(await b.tools.call('file_issue', { floor: 1, title: 'New idea', body: 'x' }).catch((e: Error) => e.message)).toMatch(/No office tool file_issue/);
  });
});

describe('the non-business waits on the board', () => {
  it('wait 1: an issue held after a person closed its PR goes to the lead, and back in line after a day without one', async () => {
    const b = await board();
    b.internals.holdIssues(b.r, { number: 77, headRefName: 'x', closesIssues: [5], state: 'CLOSED', at: Date.now() });
    expect(b.internals.state.held.map((h) => h.issue)).toEqual([5]);
    expect(b.internals.state.leads[b.repo.id].queue).toContainEqual(expect.objectContaining({ kind: 'board', reasons: ['held'] }));
    expect(await b.tools.call('release_issue', { floor: 1, number: 5, note: 'The PR was closed by mistake.' })).toMatch(/back in line/);
    expect(b.internals.state.held).toEqual([]);
    expect(b.log().at(-1)!.change.kind).toBe('release');
    // the office's own fallback
    b.internals.holdIssues(b.r, { number: 78, headRefName: 'y', closesIssues: [5], state: 'CLOSED', at: Date.now() });
    b.internals.waitsTick(Date.now() + 25 * 60 * 60_000);
    expect(b.internals.state.held).toEqual([]);
  });

  it('waits 2 and 3: an issue that keeps failing goes to the lead, and is retried after a few hours', async () => {
    const b = await board();
    b.internals.issueFailed(b.r, 3);
    b.internals.issueFailed(b.r, 3);
    expect(b.internals.readyIssues(b.r).map((x) => x.issue.number)).not.toContain(3);
    expect(b.internals.state.leads[b.repo.id].queue).toContainEqual(expect.objectContaining({ kind: 'board', reasons: ['failing'] }));
    b.internals.waitsTick(Date.now() + 7 * 60 * 60_000);
    expect(b.internals.readyIssues(b.r).map((x) => x.issue.number)).toContain(3);
  });

  it('wait 4: the office clears a desk left in an error before the alarm', async () => {
    const b = await board();
    const a = b.internals.state.agents.find((x) => x.role === 'agent')! as unknown as { status: string; endedAt: number; lastError: string | null };
    Object.assign(a, { status: 'error', endedAt: Date.now() - 9 * 60_000, lastError: 'boom' });
    b.internals.waitsTick();
    expect(a.status).toBe('idle');
  });
});
