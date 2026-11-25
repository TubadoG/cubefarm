import { describe, expect, it, vi } from 'vitest';
import { NEEDS_INPUT, renderBrief, type Brief } from '../shared/brief.ts';
import { DECIDED_MANAGER, type DecisionView } from '../shared/decisions.ts';
import type { PullInfo } from '../shared/types.ts';
import { BRIEF_GRACE_MS, type DecisionRecord } from './decisionClock.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// The Decision room on a demo office: cards for open decisions, the manager's answer through the office, and
// questions for the CEO that come back on the card's thread and on GitHub.
type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  decisionViews(): DecisionView[];
  missingBriefs(): { floor: number; kind: 'issue' | 'pr'; number: number; title: string }[];
  decisionAnswered(job: { kind: 'decision'; repoId: string; prNumber: number; text: string; at: number }, text: string | null): Promise<void>;
  queueQa(repo: unknown, number: number, dev: null, issue: null): void;
  repo(id: string): { floor: number };
  repoRt: Map<string, { pulls: PullInfo[]; syncing?: boolean }>;
  setQa(rec: object, patch: object): void;
  state: {
    decisions: DecisionRecord[];
    qa: { repoId: string; prNumber: number; status: string; heldFor?: string | null }[];
    ceo: { queue: { kind: string; prNumber?: number; text?: string }[] };
  };
};

const REPO = 'demo-co/weather-api';
const H = 3_600_000;
const BRIEF = ['## Decision brief', '### Background', 'Rate limits need a number.', '### The decision', 'How many requests a minute?', '### Options', '- 60: safe', '- 600: generous', '### Recommendation', '60: it protects the free tier.', '### Risk and mitigation', 'Heavy users hit it; raise it per key later.'].join('\n');

/** A sync that waits for one already running (connectRepo starts its own), so it sees what was just filed. */
async function sync(swarm: Swarm) {
  const rt = (swarm as unknown as { repoRt: Map<string, { syncing?: boolean }> }).repoRt.get(REPO);
  while (rt?.syncing) await new Promise((r) => setTimeout(r, 5));
  await swarm.syncRepo(REPO);
}

async function office() {
  const backend = createDemoBackend();
  const swarm = new Swarm(backend);
  await swarm.connectRepo(REPO);
  const internals = swarm as unknown as Internals;
  internals.ensureCeo([]);
  const n = await backend.createIssue(REPO, `Rate limit ${Math.random().toString(36).slice(2, 6)}`, BRIEF, [NEEDS_INPUT]);
  await sync(swarm);
  await swarm.decisionTick(Date.now() - 1000);
  const card = () => internals.decisionViews().find((d) => d.number === n)!;
  return { backend, swarm, internals, n, card };
}

describe('the Decision room', () => {
  it('shows a card with its parsed brief and its deadline', async () => {
    const { card } = await office();
    expect(card()).toMatchObject({ repoId: REPO, kind: 'issue', reason: 'needs-input', briefRead: true, answeredAt: null, thread: [], asking: false });
    expect(card().brief?.options).toEqual(['60: safe', '600: generous']);
    expect(card().deadline).toBeGreaterThan(Date.now() + 47 * H);
  });

  it("records the manager's answer on GitHub, relabels the issue and stops the clock", async () => {
    const { backend, swarm, internals, n, card } = await office();
    await expect(swarm.answerDecision(REPO, n, { choice: 'option', option: 3 })).rejects.toThrow('The brief has no option 3.');
    expect(await swarm.answerDecision(REPO, n, { choice: 'option', option: 2 })).toEqual({ ok: true, answer: 'chose option 2: 600: generous' });
    const issue = (await backend.listIssues(REPO)).find((i) => i.number === n)!;
    expect(issue.labels).toEqual([DECIDED_MANAGER]);
    const { comments } = await backend.discussion(REPO, n);
    expect(comments.at(-1)?.body.split('\n')[0]).toBe('Decision: Chose option 2: 600: generous');
    expect(internals.state.decisions.find((d) => d.number === n)?.answeredAt).not.toBeNull();
    expect(card()).toBeUndefined(); // no longer waiting: the card leaves the room
    await expect(swarm.answerDecision(REPO, n, { choice: 'approve' })).rejects.toThrow(/no longer waits/);
  });

  it('sends a question to the CEO and puts the answer on the card and on GitHub', async () => {
    const { backend, swarm, internals, n, card } = await office();
    expect(() => swarm.askDecision(REPO, n, { question: ' ' })).toThrow(/Write the question/);
    swarm.askDecision(REPO, n, { question: 'What do competitors allow?' });
    expect(internals.state.ceo.queue).toContainEqual(expect.objectContaining({ kind: 'decision', prNumber: n, text: 'What do competitors allow?' }));
    expect(card()).toMatchObject({ asking: true, thread: [{ from: 'manager', text: 'What do competitors allow?' }] });
    internals.state.ceo.queue = [];
    await internals.decisionAnswered({ kind: 'decision', repoId: REPO, prNumber: n, text: 'What do competitors allow?', at: Date.now() }, 'Most allow 60 a minute on free plans.');
    expect(card().thread.map((m) => [m.from, m.text])).toEqual([
      ['manager', 'What do competitors allow?'],
      ['ceo', 'Most allow 60 a minute on free plans.'],
    ]);
    const last = (await backend.discussion(REPO, n)).comments.at(-1)!.body;
    expect(last).toContain('> What do competitors allow?');
    expect(last).toContain('Most allow 60 a minute on free plans.');
    expect(last.startsWith('Decision:')).toBe(false); // the CEO's answer is not the manager's decision
    await swarm.decisionTick(Date.now());
    expect(card().answeredAt).toBeNull();
  });

  it('ignores a held PR brief from before its current decision and uses a fresh one', async () => {
    const pr = 79;
    const firstSeen = Date.parse('2026-11-25T12:00:00Z');
    const pull: PullInfo = {
      number: pr,
      title: 'Visit schedule',
      url: `https://github.com/${REPO}/pull/${pr}`,
      headRefName: 'swarm/issue-12-kim',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: null,
      closesIssues: [],
      createdAt: new Date(firstSeen - H).toISOString(),
      mergedAt: null,
      additions: 30,
      deletions: 4,
      checks: 'passing',
      headSha: 'held-head',
      mergeState: 'CLEAN',
      failedChecks: [],
      pendingChecks: [],
      labels: ['swarm:hold'],
    };
    const oldBrief: Brief = { background: 'Old facts.', decision: 'Merge?', options: ['Wait.'], recommendation: 'Wait.', risk: 'Delay.', ifNoReply: 'Wait.' };
    const freshBrief: Brief = { ...oldBrief, background: 'Current facts.', recommendation: 'Merge it.' };
    let comments = [{ body: renderBrief(oldBrief), createdAt: new Date(firstSeen - H).toISOString(), author: 'lead' }];
    const backend = createDemoBackend();
    Object.assign(backend, {
      listIssues: async () => [],
      listPulls: async () => [],
      discussion: async () => ({ body: 'Implements the change.', comments }),
    });
    const swarm = new Swarm(backend);
    const x = swarm as unknown as Internals;
    const notify = vi.spyOn(swarm.notifier, 'notify');
    await swarm.connectRepo(REPO);
    const rt = x.repoRt.get(REPO)!;
    while (rt.syncing) await Promise.resolve();
    rt.pulls = [pull];
    x.queueQa(x.repo(REPO), pr, null, null);
    x.setQa(x.state.qa[0], { status: 'passed', heldFor: 'held by label' });

    await swarm.decisionTick(firstSeen);
    expect(x.state.decisions.find((d) => d.number === pr)?.firstSeen).toBe(firstSeen);
    expect(x.decisionViews().find((d) => d.number === pr)?.brief).toBeNull();
    expect(x.missingBriefs()).toContainEqual({ floor: 1, kind: 'pr', number: pr, title: 'Visit schedule' });

    await swarm.decisionTick(firstSeen + BRIEF_GRACE_MS);
    expect(x.state.decisions.find((d) => d.number === pr)?.alerted).toBe('no-brief');
    expect(notify).toHaveBeenCalledWith('needsHuman', expect.any(String), expect.stringContaining('No decision brief yet'), expect.any(String), expect.any(String));

    comments = [...comments, { body: renderBrief(freshBrief), createdAt: new Date(firstSeen + H).toISOString(), author: 'lead' }];
    await swarm.decisionTick(firstSeen + BRIEF_GRACE_MS + 1);
    expect(x.decisionViews().find((d) => d.number === pr)?.brief).toEqual(freshBrief);
    expect(x.missingBriefs()).not.toContainEqual(expect.objectContaining({ kind: 'pr', number: pr }));
  });
});
