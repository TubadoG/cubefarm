import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brief } from '../shared/brief.ts';
import type { PullInfo } from '../shared/types.ts';
import type { DecisionView } from '../shared/decisions.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';
import type { FixRecord } from './fixOutcome.ts';
import { MERGE_RETRY_MS } from './mergeGate.ts';

const REPO = 'demo-co/weather-api';
const PR = 79;
type Rec = FixRecord & {
  status: string; approvedSha?: string | null; approvedAt?: number | null; heldFor?: string | null;
  mergeRetryAt: number | null; mergeFixes: number; updatedAt: number; escalated: boolean;
};
type Internals = {
  state: { qa: Rec[]; messages: { text: string }[]; agents: { id: string; status: string; prNumber: number | null }[] };
  repoRt: Map<string, { pulls: PullInfo[]; syncing: boolean; fetchedAt: number }>;
  briefs: Map<string, Brief>;
  repo(id: string): { autoMerge: boolean };
  queueQa(repo: unknown, number: number, dev: null, issue: null): void;
  advanceMerges(repo: unknown): Promise<void>;
  setQa(rec: Rec, patch: object): void;
  onFixFinished(agent: unknown, repo: unknown, result: object): Promise<void>;
  decisionViews(): DecisionView[];
  approveMerge(repo: unknown, number: number): Promise<string | null>;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function office(details: Partial<PullInfo> = {}) {
  const listed: PullInfo = {
    number: PR, title: 'Visit schedule', url: `https://github.com/${REPO}/pull/${PR}`, headRefName: 'swarm/issue-12-kim',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, closesIssues: [],
    createdAt: new Date().toISOString(), mergedAt: null, additions: 30, deletions: 4, checks: 'passing',
    headSha: 'approved-head', mergeState: 'CLEAN', failedChecks: [], pendingChecks: [], labels: ['swarm:hold'],
  };
  const live = { ...listed, ...details };
  const backend = createDemoBackend();
  const merge = vi.fn(async () => { live.state = 'MERGED'; });
  const update = vi.fn(async () => { Object.assign(live, { headSha: 'updated-head', mergeState: 'CLEAN', checks: 'pending' }); });
  Object.assign(backend, {
    listIssues: async () => [], listPulls: async () => [],
    prDetails: vi.fn(async () => ({ ...live, body: '', failedChecks: live.failedChecks.map((c) => c.name) })),
    commentIssue: vi.fn(async () => undefined), mergePull: merge, updateBranch: update,
    rerunFailedJobs: vi.fn(async () => undefined), discussion: async () => ({ body: '', comments: [] }),
  });
  const swarm = new Swarm(backend);
  const x = swarm as unknown as Internals;
  await swarm.connectRepo(REPO);
  const rt = x.repoRt.get(REPO)!;
  while (rt.syncing) await Promise.resolve();
  rt.pulls = [listed]; // the card was mergeable when displayed; details may now disagree
  const repo = x.repo(REPO);
  x.queueQa(repo, PR, null, null);
  const rec = x.state.qa[0];
  x.setQa(rec, { status: 'passed', passedSha: listed.headSha, heldFor: 'held by label' });
  x.briefs.set(`${REPO}#pr#${PR}`, { background: '', decision: 'Merge?', options: ['Merge it.'], recommendation: 'Merge it.', risk: '', ifNoReply: '' });
  const approve = () => swarm.answerDecision(REPO, PR, { choice: 'approve' });
  const advance = async () => {
    rt.pulls = [{ ...live }];
    rt.fetchedAt = Date.now();
    await x.advanceMerges(repo);
  };
  return { swarm, x, repo, rec, listed, live, rt, backend, merge, update, approve, advance };
}

describe('approving a PR through the merge gate', () => {
  it('queues a conflict fix and keeps approval through its outcome, with no second card', async () => {
    const o = await office({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
    const result = await o.approve();
    expect(result).toMatchObject({ ok: true, answer: expect.stringContaining('a developer resolves that first') });
    expect(o.merge).not.toHaveBeenCalled();
    expect(o.rec).toMatchObject({ status: 'failed', fixReason: 'conflict', approvedSha: 'approved-head', approvedAt: Date.now(), passedSha: 'approved-head', mergeFixes: 1, heldFor: null });
    expect(o.x.state.messages.at(-1)?.text).toContain(result.answer);
    Object.assign(o.live, { headSha: 'resolved-head', mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
    const dev = o.x.state.agents[0];
    Object.assign(dev, { status: 'working', prNumber: PR });
    o.rec.status = 'fixing';
    await o.x.onFixFinished(dev, o.repo, { ok: true, text: '', costUsd: 0, turns: 1, errors: [] });
    expect(o.rec).toMatchObject({ status: 'passed', passedSha: 'resolved-head', approvedSha: 'approved-head' });
    expect(o.x.decisionViews()).toEqual([]);
    await o.advance();
    expect(o.merge).toHaveBeenCalledExactlyOnceWith(REPO, PR, 'squash', 'resolved-head');
  });

  it('merges a clean PR once, preserving the existing answer', async () => {
    const o = await office();
    expect(await o.approve()).toEqual({ ok: true, answer: 'approved the recommendation: Merge it.' });
    expect(o.merge).toHaveBeenCalledExactlyOnceWith(REPO, PR, 'squash');
  });

  it('updates a BEHIND branch even while checks run, then waits for fresh checks', async () => {
    const o = await office({ mergeState: 'BEHIND', checks: 'pending' });
    expect((await o.approve()).answer).toContain('brought up to date');
    expect(o.update).toHaveBeenCalledExactlyOnceWith(REPO, PR);
    expect(o.merge).not.toHaveBeenCalled();
    expect(o.rec).toMatchObject({ approvedSha: 'approved-head', passedSha: 'updated-head', status: 'passed' });
    await o.advance();
    expect(o.merge).not.toHaveBeenCalled();
    o.live.checks = 'passing';
    await o.advance();
    expect(o.merge).toHaveBeenCalledOnce();
  });

  it('waits for pending checks, including when the floor has auto-merge turned off', async () => {
    const o = await office({ checks: 'pending' });
    o.repo.autoMerge = false;
    await o.approve();
    expect(o.rec.approvedSha).toBe('approved-head');
    expect(o.merge).not.toHaveBeenCalled();
    o.live.checks = 'passing';
    await o.advance();
    expect(o.merge).toHaveBeenCalledOnce();
  });

  it.each(['mergeable', 'mergeState'] as const)('asks twice and waits while %s is UNKNOWN', async (field) => {
    const o = await office({ [field]: 'UNKNOWN' });
    await o.approve();
    expect(o.backend.prDetails).toHaveBeenCalledTimes(2);
    expect(o.merge).not.toHaveBeenCalled();
    await o.advance();
    expect(o.merge).not.toHaveBeenCalled();
    Object.assign(o.live, { mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
    await o.advance();
    expect(o.merge).toHaveBeenCalledOnce();
  });

  it('re-runs failed checks, or queues a checks fix when they cannot be re-run', async () => {
    const o = await office({ checks: 'failing', failedChecks: [{ name: 'build', url: 'https://github.com/o/r/actions/runs/1/job/2' }] });
    o.listed.failedChecks = o.live.failedChecks;
    await o.approve();
    expect(o.backend.rerunFailedJobs).toHaveBeenCalledWith(REPO, [1]);
    expect(o.merge).not.toHaveBeenCalled();
    o.live.headSha = 'new-checks-head';
    o.live.failedChecks = [];
    o.x.setQa(o.rec, { status: 'passed', heldFor: 'held', passedSha: o.live.headSha });
    await o.approve();
    expect(o.rec).toMatchObject({ status: 'failed', fixReason: 'checks', approvedSha: 'new-checks-head' });
  });

  it('saves approval and retries through the gate after a merge race', async () => {
    const o = await office();
    o.merge.mockRejectedValueOnce(new Error('not mergeable'));
    expect((await o.approve()).answer).toContain('approval is saved');
    expect(o.rec).toMatchObject({ approvedSha: 'approved-head', mergeRetryAt: Date.now() + MERGE_RETRY_MS });
    await o.advance();
    expect(o.merge).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + MERGE_RETRY_MS);
    await o.advance();
    expect(o.merge).toHaveBeenCalledTimes(2);
  });

  it('clears approval for unrelated new commits and brings the card back after QA', async () => {
    const o = await office({ checks: 'pending' });
    await o.approve();
    Object.assign(o.live, { headSha: 'unrelated-head', checks: 'passing' });
    await o.advance();
    expect(o.rec).toMatchObject({ status: 'queued', approvedSha: null, approvedAt: null });
    o.x.setQa(o.rec, { status: 'passed', passedSha: o.live.headSha });
    await o.advance();
    expect(o.x.decisionViews()).toContainEqual(expect.objectContaining({ reason: 'held', number: PR }));
    expect(o.merge).not.toHaveBeenCalled();
  });

  it('creates the normal QA record when an approved swarm PR has none', async () => {
    const o = await office({ checks: 'pending' });
    o.x.state.qa = [];
    await o.x.approveMerge(o.repo, PR);
    expect(o.x.state.qa[0]).toMatchObject({ status: 'passed', approvedSha: 'approved-head', passedSha: 'approved-head', mergeFixes: 0 });
  });

  it('keeps the direct merge behavior for a non-swarm PR', async () => {
    const o = await office({ headRefName: 'bryan/change', mergeable: 'CONFLICTING' });
    await o.approve();
    expect(o.merge).toHaveBeenCalledExactlyOnceWith(REPO, PR, 'squash');
    expect(o.rec.approvedSha).toBeUndefined();
  });
});
