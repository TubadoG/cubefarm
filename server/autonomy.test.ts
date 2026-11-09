import { describe, expect, it } from 'vitest';
import { DECIDED_DEFAULT, NEEDS_INPUT } from '../shared/brief.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// The office runs a floor on its own: the floor settings, and the decision clock applying a brief's recommendation
// when the manager doesn't answer in time (decisionClock.ts has the pure rules).
type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  state: { decisions: { kind: string; number: number; firstSeen: number; answeredAt: number | null; appliedAt: number | null; alerted: string | null }[] };
  companyStatus(): string;
  writeBrief(x: { floor: number; number: number; background: string; decision: string; options: string[]; recommendation: string; risk: string }): Promise<string>;
};

const REPO = 'demo-co/pixel-todo';
const H = 3_600_000;

async function office() {
  const backend = createDemoBackend();
  const swarm = new Swarm(backend);
  await swarm.connectRepo(REPO);
  await swarm.syncRepo(REPO);
  const internals = swarm as unknown as Internals;
  internals.ensureCeo([]);
  return { backend, swarm, internals };
}

type Backend = ReturnType<typeof createDemoBackend>;
const BRIEF = ['## Decision brief', '### Background', 'v2 needs a palette.', '### The decision', 'Which palette?', '### Options', '- Sunrise', '- Harbour', '### Recommendation', 'Harbour: better contrast.', '### Risk and mitigation', 'Less on-brand; one file to change.'].join('\n');
/** A fresh needs-input issue (the demo's GitHub is shared by every office in this file). */
async function ask(backend: Backend, swarm: Swarm, body = BRIEF) {
  const n = await backend.createIssue(REPO, `Question ${Math.random().toString(36).slice(2, 7)}`, body, [NEEDS_INPUT]);
  await swarm.syncRepo(REPO);
  return n;
}
const labels = async (backend: Backend, n: number) => (await backend.listIssues(REPO)).find((i) => i.number === n)?.labels ?? [];
const record = (internals: Internals, n: number) => internals.state.decisions.find((d) => d.kind === 'issue' && d.number === n)!;

describe('floor settings', () => {
  it('default to off, 5 ready and 48 hours, and are patchable', async () => {
    const { swarm } = await office();
    expect(swarm.updateRepo(REPO, {})).toMatchObject({ autoPlan: false, minReady: 5, decisionTimeoutHours: 48 });
    expect(swarm.updateRepo(REPO, { autoPlan: true, minReady: 8, decisionTimeoutHours: 0 })).toMatchObject({ autoPlan: true, minReady: 8, decisionTimeoutHours: 0 });
    expect(() => swarm.updateRepo(REPO, { minReady: 0 })).toThrow(/minReady/);
    expect(() => swarm.updateRepo(REPO, { decisionTimeoutHours: -2 })).toThrow(/decisionTimeoutHours/);
  });
});

describe('the decision clock', () => {
  it('reads the brief, then applies its recommendation once the deadline passes with no reply', async () => {
    const { backend, swarm, internals } = await office();
    swarm.updateRepo(REPO, { decisionTimeoutHours: 1 });
    const n = await ask(backend, swarm);
    const t0 = Date.now();
    await swarm.decisionTick(t0);
    expect(record(internals, n)).toMatchObject({ firstSeen: t0, appliedAt: null, alerted: 'brief' });
    const status = JSON.parse(internals.companyStatus()).floors[0].decisionsForManager;
    expect(status.find((d: { number: number }) => d.number === n)).toEqual({ kind: 'issue', number: n, brief: 'written', defaultAppliesAt: new Date(t0 + H).toISOString() });

    await swarm.decisionTick(t0 + 30 * 60_000); // not yet
    expect(await labels(backend, n)).toContain(NEEDS_INPUT);

    await swarm.decisionTick(t0 + 2 * H);
    expect(await labels(backend, n)).toEqual([DECIDED_DEFAULT]);
    const { comments } = await backend.discussion(REPO, n);
    expect(comments.at(-1)?.body).toMatch(/^No reply within 1 h, so the office proceeds with the recommendation: Harbour: better contrast\./);
    expect(record(internals, n).appliedAt).toBe(t0 + 2 * H);
  });

  it('stops when the manager replies after it started', async () => {
    const { backend, swarm, internals } = await office();
    swarm.updateRepo(REPO, { decisionTimeoutHours: 1 });
    const n = await ask(backend, swarm);
    const t0 = Date.now() - 60_000;
    await swarm.decisionTick(t0);
    await backend.commentIssue(REPO, n, 'Go with Sunrise.');
    await swarm.decisionTick(t0 + 2 * H);
    expect(record(internals, n).answeredAt).not.toBeNull();
    expect(await labels(backend, n)).toContain(NEEDS_INPUT);
  });

  it('never decides on a floor with the timeout at 0, or without a brief', async () => {
    const { backend, swarm } = await office();
    swarm.updateRepo(REPO, { decisionTimeoutHours: 0 });
    const n = await ask(backend, swarm);
    await swarm.decisionTick(Date.now());
    await swarm.decisionTick(Date.now() + 1000 * H);
    expect(await labels(backend, n)).toContain(NEEDS_INPUT);
    swarm.updateRepo(REPO, { decisionTimeoutHours: 1 });
    const bare = await ask(backend, swarm, 'No brief here.');
    await swarm.decisionTick(Date.now());
    await swarm.decisionTick(Date.now() + 2 * H);
    expect(await labels(backend, bare)).toContain(NEEDS_INPUT);
  });

  it('asks the CEO for a missing brief, which write_brief posts with the deadline', async () => {
    const { backend, swarm, internals } = await office();
    const n = await ask(backend, swarm, 'Pricing is not in the spec.');
    await swarm.decisionTick(Date.now());
    const status = JSON.parse(internals.companyStatus()).floors[0].decisionsForManager;
    expect(status.find((d: { number: number }) => d.number === n)).toMatchObject({ brief: 'missing: write_brief' });
    await expect(internals.writeBrief({ floor: 1, number: 1, background: 'b', decision: 'd?', options: ['a', 'b'], recommendation: 'a', risk: 'r' })).rejects.toThrow(/isn't waiting/);
    const out = await internals.writeBrief({ floor: 1, number: n, background: 'Pricing decides sign-ups.', decision: 'Free tier or 14-day trial?', options: ['Free tier: more sign-ups', 'Trial: more paid'], recommendation: 'Trial.', risk: 'Fewer sign-ups; revisit after a month.' });
    expect(out).toMatch(/^Posted the brief on #\d+ on floor 1\. If the manager doesn't reply by /);
    const { comments } = await backend.discussion(REPO, n);
    expect(comments.at(-1)?.body).toMatch(/^## Decision brief\n\n### Background\nPricing decides sign-ups\./);
    expect(JSON.parse(internals.companyStatus()).floors[0].decisionsForManager.find((d: { number: number }) => d.number === n)).toMatchObject({ brief: 'written' });
  });
});
