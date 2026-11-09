import { describe, expect, it } from 'vitest';
import { parseBrief, usableBrief, renderBrief } from '../shared/brief.ts';
import { businessHold, closeComment, giveUpStep, issueComment, MAX_REBUILDS, parkBrief, parkDue, rebuildIssue, rebuildNote, rebuildSlug } from './rebuild.ts';

describe('businessHold', () => {
  const none = { labels: [], heldFor: null, hold: null, brief: false };
  it('finds no business hold on an ordinary PR', () => {
    expect(businessHold(none)).toBeNull();
  });
  it('treats the hold label, a brief, a held pass and hold paths as business', () => {
    expect(businessHold({ ...none, labels: ['bug', 'Swarm:Hold'] })).toBe('label swarm:hold');
    expect(businessHold({ ...none, brief: true })).toBe('it has a decision brief');
    expect(businessHold({ ...none, heldFor: 'server/payments/x.ts' })).toBe('server/payments/x.ts');
    expect(businessHold({ ...none, hold: 'server/payments/x.ts' })).toBe('server/payments/x.ts');
  });
  it('does not count work that is only "not routine" (size, dependencies, CI) as a business hold', () => {
    expect(businessHold({ ...none, hold: 'not routine: it changes dependencies (package.json)' })).toBeNull();
    expect(businessHold({ ...none, heldFor: 'not routine: it is a big change (812 lines; routine is up to 400)' })).toBeNull();
    // a real hold path still counts, even next to a not-routine pass hold
    expect(businessHold({ ...none, heldFor: 'not routine: it changes CI', hold: 'migrations/001.sql' })).toBe('migrations/001.sql');
  });
});

describe('giveUpStep', () => {
  const conflict = 'it still conflicts with main after 5 fixes';
  it('rebuilds a technical stuck PR instead of escalating', () => {
    expect(giveUpStep({ why: conflict, business: null, rebuilds: 0 })).toEqual({ do: 'rebuild' });
  });

  it('escalates business holds only', () => {
    expect(giveUpStep({ why: conflict, business: 'label swarm:hold', rebuilds: 0 })).toEqual({ do: 'escalate', brief: false });
  });

  it('rebuilds a PR stuck for an unknown reason instead of handing it to the manager', () => {
    expect(giveUpStep({ why: null, business: null, rebuilds: 0 })).toEqual({ do: 'rebuild' });
    expect(giveUpStep({ why: 'the manager stopped it', business: null, rebuilds: 0 })).toEqual({ do: 'rebuild' });
  });

  it('loop guard: a rebuild stuck again goes to the manager with a brief', () => {
    expect(giveUpStep({ why: conflict, business: null, rebuilds: MAX_REBUILDS })).toEqual({ do: 'escalate', brief: true });
    expect(giveUpStep({ why: conflict, business: null, rebuilds: MAX_REBUILDS + 3 })).toEqual({ do: 'escalate', brief: true });
  });
});

describe('the rebuild’s words', () => {
  const pr = { number: 46, title: 'Add visit schedule', branch: 'swarm/issue-12-kim' };

  it('closes the PR in plain words, keeps the branch and carries the office mark', () => {
    const c = closeComment(pr, 'it still conflicts with main after 5 fixes', 'main', [12], null);
    expect(c).toContain('building the change again from the current `main`');
    expect(c).toContain('#12 stays open');
    expect(c).toContain('`swarm/issue-12-kim` is kept');
    expect(c).toContain('<!-- cubefarm -->');
  });

  it('tells the next developer to start from main and reuse the old branch', () => {
    const c = issueComment(pr, 'it still conflicts with main after 5 fixes', 'main');
    expect(c).toContain('PR #46');
    expect(c).toContain('fresh branch from the current `main`');
    expect(c).toContain('git fetch origin swarm/issue-12-kim');
    expect(c).toContain('<!-- cubefarm -->');
    expect(rebuildNote({ pr: 46, branch: pr.branch, base: 'main' })).toContain('never push to it');
  });

  it('files an issue for a PR that linked none, describing it and linking the closed PR', () => {
    const i = rebuildIssue(pr, 'Adds the schedule.\n<!-- hidden -->', null, 'main');
    expect(i.title).toBe('Add visit schedule');
    expect(i.body).toContain('PR #46');
    expect(i.body).toContain('Adds the schedule.');
    expect(i.body).not.toContain('hidden');
  });

  it('gives a rebuild a fresh branch name, so the kept branch is never pushed over', () => {
    expect(rebuildSlug('kim', 0)).toBe('kim');
    expect(rebuildSlug('kim', 1)).toBe('kim-r2');
  });
});

describe('parkBrief', () => {
  it('is a usable brief in business words that recommends parking', () => {
    const b = parkBrief({ pr: 52, title: 'Add visit schedule', issues: [12], why: 'it still conflicts with main after 5 fixes', hours: 48 });
    expect(usableBrief(b)).toBe(true);
    expect(b.options).toHaveLength(3);
    expect(b.recommendation).toMatch(/^Park it/);
    expect(b.background).not.toMatch(/conflict|merge|rebase|CI/i);
    expect(b.ifNoReply).toBe('The office closes this PR and leaves #12 for later.');
    expect(parseBrief(renderBrief(b, 'Wed 11 Nov 08:00'))).toEqual(b);
  });

  it('says it waits when the floor never decides by default', () => {
    expect(parkBrief({ pr: 52, title: 't', issues: [], why: null, hours: 0 }).ifNoReply).toMatch(/waits for you/);
  });
});

describe('parkDue', () => {
  it('closes only after the deadline and only without a reply', () => {
    expect(parkDue({ deadline: 100, now: 99, replied: false })).toBe(false);
    expect(parkDue({ deadline: 100, now: 100, replied: false })).toBe(true);
    expect(parkDue({ deadline: 100, now: 200, replied: true })).toBe(false);
    expect(parkDue({ deadline: null, now: 200, replied: false })).toBe(false);
  });
});
