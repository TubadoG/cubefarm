import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_INPUT, type Brief } from '../shared/brief.ts';
import { DECIDED_MANAGER, type DecisionView } from '../shared/decisions.ts';
import type { PullInfo } from '../shared/types.ts';
import type { AuditRow } from './decisionAudit.ts';
import { azureTables, decisionsJson, DECISIONS_MAX_CHARS, receiptEmail, redactSas, snapshotCard, type MemoryTables, type SnapshotCard } from './decisionConnector.ts';
import { createDemoBackend } from './demo.ts';
import { screen } from './mailInbox.ts';
import { Swarm } from './swarm.ts';

// The office's half of the decision connector on a demo office, against the demo's in-memory tables: what it pushes,
// how it picks up, re-checks and applies (or refuses) queued answers through the Room's own code, the audit, the
// receipts, and when it touches the tables at all.

const REPO = 'demo-co/weather-api';
const PR = 77;
const HEAD = 'abc1234def5678abc1234def5678abc1234def56';
const EP = 'https://stbcdecisionconn01.table.core.windows.net';
const SAS = 'sv=2019-02-02&tn=answers&sp=raud&se=2027-11-20T00%3A00%3A00Z&sig=c2VjcmV0LXNpZ25hdHVyZS12YWx1ZQ%3D%3D';
const NOON = '2026-11-20T17:00:00Z'; // noon Eastern
const MIN = 60_000;
const ISSUE_BRIEF = ['## Decision brief', '### Background', 'Rate limits need a number.', '### The decision', 'How many requests a minute?', '### Options', '- 60: safe', '- 600: generous', '### Recommendation', '60: it protects the free tier.', '### Risk and mitigation', 'Heavy users hit it; raise it per key later.'].join('\n');
const PR_BRIEF: Brief = { background: 'QA passed; the PR touches billing.', decision: 'Merge now or wait?', options: ['Merge it as it is.', 'Wait for the pricing review first.'], recommendation: 'Merge it as it is.', risk: 'Low.', ifNoReply: '' };

type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  decisionViews(): DecisionView[];
  applyAnswer(repoId: string, n: number, body: unknown, opts: { via?: 'room' | 'connector'; expectedHeadSha?: string }): Promise<unknown>;
  repoRt: Map<string, { pulls: PullInfo[]; syncing?: boolean }>;
  briefs: Map<string, Brief>;
  audit: { rows: AuditRow[] };
  state: { settings: { managerName: string; email: { from: string; mine: string[] } }; qa: Record<string, unknown>[] };
};

async function sync(swarm: Swarm) {
  const rt = (swarm as unknown as Internals).repoRt.get(REPO);
  while (rt?.syncing) await new Promise((r) => setTimeout(r, 5));
  await swarm.syncRepo(REPO);
}

function pull(): PullInfo {
  return {
    number: PR,
    title: 'Bill per request',
    url: `https://github.com/${REPO}/pull/${PR}`,
    headRefName: 'swarm/issue-9-kim',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    closesIssues: [],
    createdAt: new Date().toISOString(),
    mergedAt: null,
    additions: 30,
    deletions: 4,
    checks: 'passing',
    headSha: HEAD,
    mergeState: 'CLEAN',
    failedChecks: [],
    pendingChecks: [],
    labels: ['swarm:hold'],
  };
}

/** A held PR's QA record, as the office keeps it once QA passed and the PR waits for the manager. */
function heldRecord(): Record<string, unknown> {
  return {
    repoId: REPO, prNumber: PR, status: 'passed', round: 1, devAgentId: null, qaAgentId: null, summary: null, checks: [], commentUrl: null, mergeNote: null,
    heldFor: 'label swarm:hold', updatedAt: Date.now(), issueNumber: null, devSessionId: null, fixInstructions: null, sessionFailures: 0, testedSha: HEAD, passedSha: HEAD,
    fixReason: null, mergeFixes: 0, retests: 0, preQa: null, noChangeSha: null, pendingSince: null, mergeRetryAt: null, alerted: false, rerunSha: null, rerunAt: null,
    qaChecks: null, stuckWhy: null, triages: 0, rebuildRetryAt: null, escalated: false, parkBy: null, parked: false,
  };
}

/** A demo office with one needs-input issue card, the connector set up and on, and receipts captured. */
async function office(opts: { on?: boolean; pr?: boolean } = {}) {
  const backend = createDemoBackend();
  const tables = backend.tables as MemoryTables;
  const swarm = new Swarm(backend);
  await swarm.connectRepo(REPO);
  const internals = swarm as unknown as Internals;
  internals.ensureCeo([]);
  internals.state.settings.managerName = 'Bryan';
  Object.assign(internals.state.settings.email, { from: 'ceo@demo-co.example.com', mine: ['bryan@demo-co.example.com'] });
  vi.spyOn(swarm.mailer, 'ready', 'get').mockReturnValue(true);
  const sent = vi.spyOn(swarm.mailer, 'send').mockResolvedValue();
  const n = await backend.createIssue(REPO, `Rate limit ${Math.random().toString(36).slice(2, 6)}`, ISSUE_BRIEF, [NEEDS_INPUT]);
  await sync(swarm);
  await swarm.decisionTick(Date.now() - 1000);

  const pulls: PullInfo[] = [];
  const merged = vi.fn(async (_f: string, num: number) => void pulls.filter((p) => p.number === num).forEach((p) => (p.state = 'MERGED')));
  if (opts.pr) {
    pulls.push(pull());
    Object.assign(backend, {
      listPulls: async () => pulls.filter((p) => p.state === 'OPEN'),
      prDetails: async (_f: string, num: number) => ({ ...pulls.find((p) => p.number === num)!, body: '' }),
      mergePull: merged,
    });
    internals.repoRt.get(REPO)!.pulls = [...pulls];
    internals.state.qa.push(heldRecord());
    internals.briefs.set(`${REPO}#pr#${PR}`, PR_BRIEF);
  }
  await swarm.connector.setSas({ sas: SAS });
  if (opts.on !== false) swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: EP, receiptsPerDay: 30 } });
  tables.calls.length = 0;

  const queue = (a: { tool: string; number?: number; option?: string; sha?: string; askedAt?: number; repo?: string }) => {
    const id = crypto.randomUUID();
    tables.put('answers', {
      PartitionKey: 'answer',
      RowKey: id,
      tool: a.tool,
      repo: a.repo ?? REPO,
      number: a.number ?? n,
      option: a.option ?? '',
      expectedHeadSha: a.sha ?? '',
      askedAt: new Date(a.askedAt ?? Date.now()).toISOString(),
      askedBy: 'e00b07ab-2f12-4a13-a2cd-156a025ae427',
      status: 'queued',
    });
    return id;
  };
  const answer = (id: string) => tables.read('answers', 'answer', id)!;
  const snapshot = () => {
    const row = tables.read('snapshot', 'office', 'current');
    return row ? { ...row, decisions: JSON.parse(String(row.decisions)) as SnapshotCard[] } : null;
  };
  const labels = async () => (await backend.listIssues(REPO)).find((i) => i.number === n)?.labels ?? [];
  const comments = async (num = n) => (await backend.discussion(REPO, num)).comments.map((c) => c.body);
  const audit = () => internals.audit.rows.filter((r) => r.via === 'connector');
  return { backend, tables, swarm, internals, n, queue, answer, snapshot, labels, comments, audit, sent, merged, pulls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the snapshot', () => {
  it("pushes the open cards with each option's effect from the Room's answerPlan, and only when something changed", async () => {
    const { swarm, tables, snapshot, n } = await office();
    await swarm.connector.tick();
    const snap = snapshot()!;
    expect(snap).toMatchObject({ version: 1, enabled: true, writtenAt: new Date(NOON).toISOString(), heartbeatAt: new Date(NOON).toISOString() });
    const card = snap.decisions.find((d) => d.number === n)!;
    expect(card).toMatchObject({ key: `${REPO}#${n}`, repo: REPO, kind: 'issue', recommendation: '60: it protects the free tier.', headSha: null, lastResult: null });
    expect(card.options).toEqual([
      { label: '60: safe', effect: 'unblock', note: null },
      { label: '600: generous', effect: 'unblock', note: null },
    ]);
    expect(card.brief).toContain('How many requests a minute?');
    expect(tables.calls.filter((c) => c === 'upsert snapshot')).toHaveLength(1);
    await swarm.connector.tick(); // nothing changed: no new snapshot, no heartbeat yet
    expect(tables.calls.filter((c) => c.endsWith('snapshot'))).toEqual(['upsert snapshot']);
    vi.setSystemTime(Date.now() + 61 * MIN);
    await swarm.connector.tick(); // an hour on: the heartbeat only
    expect(tables.calls.filter((c) => c.endsWith('snapshot'))).toEqual(['upsert snapshot', 'merge snapshot']);
    expect(snapshot()).toMatchObject({ version: 1, heartbeatAt: new Date(Date.now()).toISOString() });
  });

  it('says merge or send back for a PR exactly as the Room would answer it, with its head', async () => {
    const { swarm, snapshot } = await office({ pr: true });
    await swarm.connector.tick();
    const card = snapshot()!.decisions.find((d) => d.number === PR)!;
    expect(card).toMatchObject({ kind: 'pr', headSha: HEAD, recommendation: 'Merge it as it is.' });
    expect(card.options).toEqual([
      { label: 'Merge it as it is.', effect: 'merge', note: null },
      { label: 'Wait for the pricing review first.', effect: 'send_back', note: 'The manager chose option 2: Wait for the pricing review first.' },
    ]);
  });

  it('fits a big office into the property, shortening briefs first', () => {
    const view = (i: number): DecisionView => ({
      key: `${REPO}#${i}`, repoId: REPO, floor: 1, kind: 'issue', reason: 'needs-input', number: i, title: `Card ${i}`, url: '', briefRead: true, deadline: null, answeredAt: null, answer: null, thread: [], asking: false,
      brief: { ...PR_BRIEF, decision: 'x'.repeat(2000), options: ['a'.repeat(300), 'b'.repeat(300)] },
    });
    const cards = Array.from({ length: 80 }, (_, i) => snapshotCard(view(i + 1), { headSha: null, openedAt: null, by: 'Bryan' }));
    expect(cards[0].brief.length).toBeLessThanOrEqual(600);
    const json = decisionsJson(cards);
    expect(json.length).toBeLessThanOrEqual(DECISIONS_MAX_CHARS);
    expect((JSON.parse(json) as SnapshotCard[]).length).toBeGreaterThan(20);
  });
});

describe('answers through the connector', () => {
  it('approves an issue the way the Room does, with "via connector" on GitHub, an audit row and one receipt', async () => {
    const { swarm, queue, answer, labels, comments, audit, sent, n, internals } = await office();
    const id = queue({ tool: 'approve_recommendation' });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'applied', detail: 'unblocked the issue (decided:manager)', pickedAt: new Date(NOON).toISOString(), resultAt: new Date(NOON).toISOString() });
    expect(await labels()).toEqual([DECIDED_MANAGER]);
    const c = (await comments()).at(-1)!;
    expect(c.split('\n')[0]).toBe('Decision: Approved the recommendation: 60: it protects the free tier.');
    expect(c).toContain('_Answered by Bryan via the cubefarm decision connector._');
    expect(internals.decisionViews().find((d) => d.number === n)).toBeUndefined();
    expect(audit()).toEqual([
      expect.objectContaining({ via: 'connector', tool: 'approve_recommendation', repo: REPO, number: n, result: 'applied', answerId: id, askedAt: new Date(NOON).toISOString(), appliedAt: new Date(NOON).toISOString(), askedBy: 'e00b07ab-2f12-4a13-a2cd-156a025ae427' }),
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
    const mail = sent.mock.calls[0][0];
    expect(mail).toMatchObject({ from: 'ceo@demo-co.example.com', to: 'bryan@demo-co.example.com', subject: `Decision recorded: ${REPO} #${n}, unblocked` });
    expect(mail.text).toContain('What the office did: unblocked the issue (decided:manager)');
    expect(mail.text).toContain('Via: connector');
    expect(mail.text).toContain('Asked: 2026-11-20 17:00 UTC (Nov 20, 12:00 PM Eastern)');
    await swarm.connector.tick();
    expect(sent).toHaveBeenCalledTimes(1); // one receipt per answer, however often the office checks
    expect(swarm.connector.view()).toMatchObject({ pickedToday: 1, appliedToday: 1, refusedToday: 0, receiptsToday: 1 });
  });

  it('chooses an option by its label', async () => {
    const { swarm, queue, answer, comments } = await office();
    const id = queue({ tool: 'choose_option', option: '600: generous' });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'applied' });
    expect((await comments()).at(-1)!.split('\n')[0]).toBe('Decision: Chose option 2: 600: generous');
    const missing = queue({ tool: 'choose_option', option: '6000' });
    await swarm.connector.tick();
    expect(answer(missing)).toMatchObject({ status: 'refused' });
  });

  it('merges a PR when the option merges, and sends it back with the note when it does not', async () => {
    const a = await office({ pr: true });
    const id = a.queue({ tool: 'approve_recommendation', number: PR, sha: HEAD });
    await a.swarm.connector.tick();
    expect(a.answer(id)).toMatchObject({ status: 'applied', detail: 'merged' });
    expect(a.merged).toHaveBeenCalledTimes(1);
    expect(a.sent.mock.calls[0][0].subject).toBe(`Decision recorded: ${REPO} #${PR}, merged`);
    expect(a.audit()[0]).toMatchObject({ expectedHeadSha: HEAD, actualHeadSha: HEAD, result: 'applied' });

    const b = await office({ pr: true });
    const back = b.queue({ tool: 'choose_option', number: PR, option: 'Wait for the pricing review first.', sha: HEAD });
    await b.swarm.connector.tick();
    expect(b.answer(back)).toMatchObject({ status: 'applied', detail: 'sent back to a developer with this note: The manager chose option 2: Wait for the pricing review first.' });
    expect(b.merged).not.toHaveBeenCalled();
    expect(b.internals.state.qa.find((q) => q.prNumber === PR)).toMatchObject({ status: 'failed', fixInstructions: 'From the manager: The manager chose option 2: Wait for the pricing review first.' });
  });

  it('refuses a PR answer whose head moved since the snapshot, or that names no head', async () => {
    const { swarm, queue, answer, merged, audit, sent } = await office({ pr: true });
    const moved = queue({ tool: 'approve_recommendation', number: PR, sha: 'ffff000' });
    await swarm.connector.tick();
    expect(answer(moved)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/changed since the snapshot: its head is abc1234/) });
    const none = queue({ tool: 'approve_recommendation', number: PR });
    await swarm.connector.tick();
    expect(answer(none)).toMatchObject({ status: 'refused', detail: 'A PR answer must name the head SHA it was given on.' });
    expect(merged).not.toHaveBeenCalled();
    expect(audit().map((r) => [r.result, r.expectedHeadSha, r.actualHeadSha])).toEqual([
      ['refused', 'ffff000', HEAD],
      ['refused', null, null],
    ]);
    expect(sent).toHaveBeenCalledTimes(2); // refusals get their receipt too
    expect(sent.mock.calls[0][0].subject).toMatch(new RegExp(`^Decision recorded: ${REPO} #${PR}, refused: PR #${PR} changed since the snapshot`));
  });

  it('refuses an answer older than 30 minutes when it is picked up', async () => {
    const { swarm, queue, answer, labels, audit } = await office();
    const id = queue({ tool: 'approve_recommendation', askedAt: Date.now() - 31 * MIN });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/31 minutes .*older than 30 minutes are refused/) });
    expect(await labels()).toEqual([NEEDS_INPUT]);
    expect(audit()[0]).toMatchObject({ result: 'refused', answerId: id });
  });

  it('lets only the first of two answers through: Room then connector', async () => {
    const { swarm, queue, answer, n, comments } = await office();
    await swarm.answerDecision(REPO, n, { choice: 'option', option: 1 });
    const id = queue({ tool: 'approve_recommendation' });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'refused', detail: 'This decision was already answered.' });
    expect((await comments()).filter((c) => c.startsWith('Decision:'))).toHaveLength(1);
  });

  it('lets only the first of two answers through: connector then Room', async () => {
    const { swarm, queue, answer, n } = await office();
    const id = queue({ tool: 'approve_recommendation' });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'applied' });
    await expect(swarm.answerDecision(REPO, n, { choice: 'option', option: 2 })).rejects.toThrow(/no longer waits/);
  });

  it('lets only the first of two answers through: both at once', async () => {
    const { swarm, internals, n, comments } = await office();
    const [room, connector] = await Promise.allSettled([swarm.answerDecision(REPO, n, { choice: 'option', option: 1 }), internals.applyAnswer(REPO, n, { choice: 'approve' }, { via: 'connector' })]);
    expect(room.status).toBe('fulfilled');
    expect(connector).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/already answered/) }) });
    expect((await comments()).filter((c) => c.startsWith('Decision:'))).toHaveLength(1);
    // Two queued at once for the same card: the second is refused.
    const b = await office();
    const first = b.queue({ tool: 'approve_recommendation' });
    const second = b.queue({ tool: 'choose_option', option: '600: generous', askedAt: Date.now() + 1 });
    await b.swarm.connector.tick();
    expect([b.answer(first).status, b.answer(second).status]).toEqual(['applied', 'refused']);
    expect(b.answer(second).detail).toBe('This decision was already answered.');
  });

  it('retries QA on a PR: queued for QA, a short comment on GitHub, an audit row and a receipt', async () => {
    const { swarm, queue, answer, comments, internals, audit, sent } = await office({ pr: true });
    const id = queue({ tool: 'retry_qa', number: PR, sha: HEAD });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'applied', detail: 'queued for QA' });
    expect(internals.state.qa.find((q) => q.prNumber === PR)).toMatchObject({ status: 'queued', round: 2 });
    expect((await comments(PR)).at(-1)).toContain('Retry QA requested by Bryan via the connector.');
    expect(audit()[0]).toMatchObject({ tool: 'retry_qa', result: 'applied', expectedHeadSha: HEAD, actualHeadSha: HEAD });
    expect(sent.mock.calls[0][0].subject).toBe(`Decision recorded: ${REPO} #${PR}, queued for QA`);
  });

  it('never closes, sends back, holds or merges a list, whatever the row asks for', async () => {
    const { swarm, internals, queue, answer, labels, audit, merged } = await office({ pr: true });
    const apply = vi.spyOn(internals, 'applyAnswer');
    const ids = ['close', 'send_back', 'hold', 'merge_in_order', ''].map((tool) => queue({ tool, number: PR, sha: HEAD }));
    await swarm.connector.tick();
    for (const id of ids) expect(answer(id)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/only approve_recommendation, choose_option, retry_qa/) });
    expect(apply).not.toHaveBeenCalled();
    expect(merged).not.toHaveBeenCalled();
    expect(await labels()).toEqual([NEEDS_INPUT]);
    expect(internals.state.qa.find((q) => q.prNumber === PR)).toMatchObject({ status: 'passed' });
    expect(audit()).toHaveLength(5);
  });
});

describe('off and quiet hours', () => {
  it('neither pushes nor polls while off, writes enabled=false once on switching off, and refuses what was asked meanwhile', async () => {
    const { swarm, tables, queue, answer, snapshot, labels } = await office({ on: false });
    await swarm.connector.tick();
    expect(tables.calls).toEqual([]);
    expect(swarm.connector.nextDelay()).toBeNull();
    swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: EP, receiptsPerDay: 30 } });
    await swarm.connector.tick();
    expect(snapshot()).toMatchObject({ enabled: true, version: 1 });
    swarm.updateSettings({ decisionConnector: { enabled: false, tableEndpoint: EP, receiptsPerDay: 30 } });
    tables.calls.length = 0;
    await swarm.connector.tick();
    expect(tables.calls).toEqual(['upsert snapshot']);
    expect(snapshot()).toMatchObject({ enabled: false, version: 2, decisions: [] });
    const id = queue({ tool: 'approve_recommendation' }); // queued (somehow) while off
    await swarm.connector.tick();
    await swarm.connector.tick();
    expect(tables.calls).toEqual(['upsert snapshot']); // once, then nothing
    expect(swarm.connector.nextDelay()).toBeNull();
    vi.setSystemTime(Date.now() + MIN);
    swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: EP, receiptsPerDay: 30 } });
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'refused', detail: 'It was asked while the connector was switched off.' });
    expect(await labels()).toEqual([NEEDS_INPUT]);
  });

  it("won't switch on without the endpoint and the SAS token", async () => {
    const { swarm } = await office({ on: false });
    expect(() => swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: '', receiptsPerDay: 30 } })).toThrow(/table endpoint/);
    await swarm.connector.removeSas();
    expect(() => swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: EP, receiptsPerDay: 30 } })).toThrow(/SAS token/);
  });

  it('touches nothing in quiet hours, and refuses at 5 am what was asked overnight', async () => {
    const { swarm, tables, queue, answer, labels } = await office();
    vi.setSystemTime(new Date('2026-11-21T09:50:00Z')); // 04:50 EST
    const id = queue({ tool: 'approve_recommendation' });
    await swarm.connector.tick();
    expect(tables.calls).toEqual([]);
    expect(swarm.connector.nextDelay()).toBe(10 * MIN);
    swarm.updateSettings({ decisionConnector: { enabled: false, tableEndpoint: EP, receiptsPerDay: 30 } });
    await swarm.connector.tick();
    expect(tables.calls).toEqual([]); // not even the off row until 5 am
    swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: EP, receiptsPerDay: 30 } });
    vi.setSystemTime(new Date('2026-11-21T10:05:00Z')); // 05:05 EST
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'refused' });
    expect(await labels()).toEqual([NEEDS_INPUT]);
  });

  it('refuses an answer asked in quiet hours even when it is fresh (summer time)', async () => {
    const { swarm, queue, answer } = await office();
    vi.setSystemTime(new Date('2027-07-15T08:59:00Z')); // 04:59 EDT
    const id = queue({ tool: 'approve_recommendation' });
    vi.setSystemTime(new Date('2027-07-15T09:01:00Z')); // 05:01 EDT
    await swarm.connector.tick();
    expect(answer(id)).toMatchObject({ status: 'refused', detail: 'It was asked during quiet hours (midnight to 5 am Eastern).' });
  });
});

describe('the scheduler', () => {
  it('checks every 3 s in a voice session, every 30 s with cards open, every 5 min without', async () => {
    const { swarm, tables, n } = await office();
    await swarm.connector.tick();
    expect(swarm.connector.nextDelay()).toBe(30_000);
    tables.put('session', { PartitionKey: 'session', RowKey: 'active', lastCallAt: new Date(Date.now() - 2 * MIN).toISOString() });
    await swarm.connector.tick();
    expect(swarm.connector.nextDelay()).toBe(3_000);
    vi.setSystemTime(Date.now() + 11 * MIN);
    await swarm.connector.tick();
    expect(swarm.connector.nextDelay()).toBe(30_000);
    await swarm.answerDecision(REPO, n, { choice: 'approve' });
    vi.spyOn(swarm, 'connectorCards').mockReturnValue([]); // the demo floor's other cards answered too
    await swarm.connector.tick();
    expect(swarm.connector.nextDelay()).toBe(5 * MIN);
  });
});

describe('receipts', () => {
  it('keep their own daily cap, apart from the CEO’s', async () => {
    const { swarm, queue, sent } = await office();
    swarm.updateSettings({ decisionConnector: { enabled: true, tableEndpoint: EP, receiptsPerDay: 1 } });
    queue({ tool: 'choose_option', option: 'nope' });
    queue({ tool: 'choose_option', option: 'nope either', askedAt: Date.now() + 1 });
    await swarm.connector.tick();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(swarm.connector.view().results[0].receipt).toBe('not sent: the 1 receipts a day are used up');
  });

  it('say what happened, in both time zones, and that replies are not read', () => {
    const at = Date.parse('2026-07-15T14:05:00Z');
    const r = receiptEmail({ repo: REPO, number: 5, title: 'Rate limit', choice: 'approved the recommendation: 60', status: 'refused', did: 'It was asked 41 minutes before the office picked it up.', short: 'refused: stale', headSha: null, askedAt: at - 41 * MIN, at, answerId: 'a1', company: 'BC Consulting' });
    expect(r.subject).toBe(`Decision recorded: ${REPO} #5, refused: stale`);
    expect(r.text).toContain('Refused: 2026-07-15 14:05 UTC (Jul 15, 10:05 AM Eastern)');
    expect(r.text).toContain("Replies to this email aren't read and never count as an answer.");
  });

  it('are never read back from the inbox, not even a reply from Bryan', () => {
    const mail = { id: '1', receivedDateTime: NOON, subject: 'RE: Decision recorded: demo-co/weather-api #5, merged', from: { emailAddress: { address: 'bryan@demo-co.example.com' } }, sender: { emailAddress: { address: 'bryan@demo-co.example.com' } }, internetMessageHeaders: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' }] };
    expect(screen(mail, { mine: ['bryan@demo-co.example.com'], officeDomain: 'demo-co.example.com' })).toEqual({ ok: false, reason: 'reply to a decision receipt' });
  });
});

describe('the Azure Table REST client', () => {
  it('signs with the SAS in the query, merges with If-Match, follows continuations, and never puts the token in an error', async () => {
    const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
    let page = 0;
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), url, headers: init.headers as Record<string, string> });
      if (init.method === 'MERGE') return new Response(null, { status: 412 });
      if (url.includes('answers()')) {
        page++;
        return new Response(JSON.stringify({ value: [{ 'odata.etag': `W/"${page}"`, PartitionKey: 'answer', RowKey: `r${page}`, status: 'queued' }] }), {
          status: 200,
          headers: page === 1 ? { 'x-ms-continuation-NextPartitionKey': 'answer', 'x-ms-continuation-NextRowKey': 'r2' } : {},
        });
      }
      return new Response(JSON.stringify({ 'odata.error': { code: 'AuthenticationFailed', message: { value: `bad ${SAS}` } } }), { status: 403 });
    }) as unknown as typeof fetch;
    const t = azureTables(fake).open(EP, SAS);
    const rows = await t.query('answers', "PartitionKey eq 'answer' and status eq 'queued'");
    expect(rows.map((r) => [r.entity.RowKey, r.etag])).toEqual([['r1', 'W/"1"'], ['r2', 'W/"2"']]);
    expect(seen[0].url).toBe(`${EP}/answers()?${SAS}&$filter=${encodeURIComponent("PartitionKey eq 'answer' and status eq 'queued'")}`);
    expect(seen[1].url).toContain('NextPartitionKey=answer&NextRowKey=r2');
    expect(seen[0].headers['x-ms-version']).toBe('2019-02-02');
    expect(await t.merge('answers', { PartitionKey: 'answer', RowKey: 'r1', status: 'picked' }, 'W/"1"')).toBe(false);
    expect(seen.at(-1)).toMatchObject({ method: 'MERGE', url: `${EP}/answers(PartitionKey='answer',RowKey='r1')?${SAS}`, headers: expect.objectContaining({ 'If-Match': 'W/"1"' }) });
    const err = await t.get('session', 'session', 'active').catch((e: Error) => e);
    expect(String(err)).toMatch(/refused the SAS token .*AuthenticationFailed/);
    expect(String(err)).not.toContain('sig=');
    expect(redactSas(`x ${SAS} y c2VjcmV0LXNpZ25hdHVyZS12YWx1ZQ==`, SAS)).toBe('x *** y ***');
  });
});
