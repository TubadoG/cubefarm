import { describe, expect, it } from 'vitest';
import { askedFor, ceoJobPrompt, ceoSystemPrompt, mayFileIssue, NOT_ASKED, parseMinReady, planReviewDue } from './ceo.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// Only the manager decides on new work: the CEO files issues only in a job the manager started by asking for work
// (a plan from their brief, or their message), never in its own reviews, onboarding or triage.
type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  fileIssue(x: { floor: number; title: string; body: string }): Promise<string>;
  ceoAsked: boolean;
  state: { ceo: { queue: { kind: string; repoId?: string }[] } };
};

describe('who asks for new work', () => {
  it("is the manager: their plans and messages, not the CEO's own jobs", () => {
    expect(askedFor({ kind: 'plan' })).toBe(true);
    expect(askedFor({ kind: 'chat' })).toBe(true);
    for (const kind of ['review', 'onboard', 'triage'] as const) expect(askedFor({ kind })).toBe(false);
  });

  it('is in the prompts: reviews and onboarding suggest work instead of filing it', () => {
    const system = ceoSystemPrompt({ name: 'Luna', company: 'Acme', manager: 'Sam', notesFile: 'notes.md', sessionLimit: 0, maxAgents: 10, scaling: 'approve' });
    expect(system).toContain('Never decide on new work yourself.');
    const review = ceoJobPrompt({ kind: 'review', at: 0 }, null);
    expect(review).not.toContain('plan the next milestone');
    expect(review).toContain('file no issues');
    const floor = { floor: 2, fullName: 'acme/app', clone: '/clones/app', mission: 'Add voice messages', backlog: 0 };
    const onboard = ceoJobPrompt({ kind: 'onboard', repoId: 'r1', at: 0 }, floor);
    expect(onboard).toContain('File no issues');
    expect(onboard).not.toContain('plan the first milestone');
    expect(ceoJobPrompt({ kind: 'onboard', repoId: 'r1', at: 0 }, { ...floor, mission: '', backlog: 3 })).toContain('file no new ones');
  });
});

describe("the CEO's file_issue", () => {
  async function office(mission?: string) {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo', { mission });
    const internals = swarm as unknown as Internals;
    internals.ensureCeo([]);
    return { swarm, internals };
  }

  it("is refused in a job the manager didn't ask for", async () => {
    const { internals } = await office();
    internals.ceoAsked = false;
    await expect(internals.fileIssue({ floor: 1, title: 'Add a dark mode', body: 'Nobody asked.' })).rejects.toThrow(NOT_ASKED);
  });

  it('files work the manager asked for', async () => {
    const { internals } = await office();
    internals.ceoAsked = true;
    await expect(internals.fileIssue({ floor: 1, title: 'Add a dark mode', body: 'The manager asked.' })).resolves.toMatch(/^Filed #\d+ on floor 1: Add a dark mode\.$/);
  });

  it('plans a brief given when the project moves in, as a job of its own after onboarding', async () => {
    expect((await office('A cozy island bakery')).internals.state.ceo.queue.map((j) => j.kind)).toEqual(['onboard', 'plan']);
    expect((await office()).internals.state.ceo.queue.map((j) => j.kind)).toEqual(['onboard']);
  });
});

describe('floors that plan themselves (autoPlan)', () => {
  it('let a review file issues on that floor only', () => {
    expect(mayFileIssue({ kind: 'review' }, { autoPlan: true })).toBe(true);
    expect(mayFileIssue({ kind: 'review' }, { autoPlan: false })).toBe(false);
    for (const kind of ['onboard', 'triage'] as const) expect(mayFileIssue({ kind }, { autoPlan: true })).toBe(false);
    expect(mayFileIssue({ kind: 'plan' }, { autoPlan: false })).toBe(true);
    expect(mayFileIssue(null, { autoPlan: true })).toBe(false);
  });

  it('force a review when one runs low, unless the last review left it idle', () => {
    const floors = [
      { id: 'a', autoPlan: true, ready: 2, minReady: 5 },
      { id: 'b', autoPlan: true, ready: 5, minReady: 5 },
      { id: 'c', autoPlan: false, ready: 0, minReady: 5 },
      { id: 'd', autoPlan: true, ready: 0, minReady: 3 },
    ];
    expect(planReviewDue(floors, new Set())).toEqual(['a', 'd']);
    expect(planReviewDue(floors, new Set(['d']))).toEqual(['a']);
  });

  it('keep minReady between 1 and 20', () => {
    expect(parseMinReady(5)).toBe(5);
    expect(parseMinReady('8')).toBe(8);
    for (const bad of [0, 21, 2.5, 'lots', null, true]) expect(() => parseMinReady(bad)).toThrow(/minReady/);
  });

  it('are in the prompts: the exception, the floors to stock and the briefs to write', () => {
    const base = { name: 'Luna', company: 'Acme', manager: 'Sam', notesFile: 'notes.md', sessionLimit: 0, maxAgents: 10, scaling: 'approve' as const };
    expect(ceoSystemPrompt(base)).not.toContain('autoPlan');
    expect(ceoSystemPrompt({ ...base, autoPlan: true })).toContain('Exception: floors with autoPlan on');
    const review = ceoJobPrompt({ kind: 'review', at: 0 }, null, null, {
      autoPlan: [
        { floor: 2, fullName: 'acme/rtsm', clone: '/c/rtsm', ready: 1, minReady: 5 },
        { floor: 3, fullName: 'acme/site', clone: '/c/site', ready: 6, minReady: 5 },
      ],
      missingBriefs: [{ floor: 2, kind: 'pr', number: 42, title: 'Pricing page' }],
    });
    expect(review).toContain('floor 2 (acme/rtsm, clone at /c/rtsm): 1 ready to start, keep at least 5. File up to 4 for the current milestone');
    expect(review).toContain('floor 3 (acme/site, clone at /c/site): 6 ready to start, keep at least 5.\n');
    expect(review).toContain('- floor 2: PR #42 "Pricing page"');
    expect(review).toContain('file no issues'); // the other floors keep today's rule
  });
});

describe("the CEO's file_issue on a floor that plans itself", () => {
  it('is allowed in a review once autoPlan is on, and counts toward the 12-issue cap', async () => {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo');
    const internals = swarm as unknown as Internals & { state: { ceo: { job: { kind: string } | null } } };
    internals.ensureCeo([]);
    internals.ceoAsked = false;
    internals.state.ceo.job = { kind: 'review' };
    await expect(internals.fileIssue({ floor: 1, title: 'Next milestone', body: 'From the roadmap.' })).rejects.toThrow(NOT_ASKED);
    swarm.updateRepo('demo-co/pixel-todo', { autoPlan: true });
    for (let i = 0; i < 12; i++) await expect(internals.fileIssue({ floor: 1, title: `Roadmap item ${i}`, body: 'From the roadmap.' })).resolves.toMatch(/^Filed #\d+/);
    await expect(internals.fileIssue({ floor: 1, title: 'One too many', body: '' })).rejects.toThrow(/already filed 12 issues/);
  });
});
