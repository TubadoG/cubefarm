import { describe, expect, it } from 'vitest';
import { OFFICE_MARK, renderBrief, type Brief } from '../shared/brief.ts';
import {
  alertStep,
  BRIEF_GRACE_MS,
  clockStep,
  deadlineOf,
  defaultComment,
  dueSoon,
  managerReply,
  parseTimeoutHours,
  REOPEN_GRACE_MS,
  trackDecisions,
  whenLabel,
  type DecisionRecord,
} from './decisionClock.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-11-09T08:00:00Z');
const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({ repoId: 'o/r', kind: 'issue', number: 7, firstSeen: T0, answeredAt: null, appliedAt: null, alerted: null, ...over });
const brief = (recommendation = 'Build Harbour.'): Brief => ({ background: 'b', decision: 'd?', options: ['a', 'b'], recommendation, risk: 'r', ifNoReply: '' });

describe('deadlines', () => {
  it('is first seen plus the timeout, or never at 0', () => {
    expect(deadlineOf(T0, 48)).toBe(T0 + 48 * H);
    expect(deadlineOf(T0, 0)).toBeNull();
  });

  it('flags decisions due within 24 hours, and overdue ones', () => {
    const deadline = T0 + 48 * H;
    expect(dueSoon(deadline, T0)).toBe(false);
    expect(dueSoon(deadline, T0 + 24 * H)).toBe(true);
    expect(dueSoon(deadline, T0 + 60 * H)).toBe(true);
    expect(dueSoon(null, T0)).toBe(false);
  });

  it('takes 0 to 720 whole hours', () => {
    expect(parseTimeoutHours(48)).toBe(48);
    expect(parseTimeoutHours('0')).toBe(0);
    expect(parseTimeoutHours(12.4)).toBe(12);
    for (const bad of [-1, 721, 'soon', true, null, NaN]) expect(() => parseTimeoutHours(bad)).toThrow(/decisionTimeoutHours/);
  });

  it('words a deadline in local time', () => {
    expect(whenLabel(new Date(2026, 10, 11, 8, 5).getTime())).toBe('Wed 11 Nov 08:05');
  });
});

describe('trackDecisions', () => {
  const open = () => true;

  it('starts the clock on new decisions and keeps the first sighting', () => {
    const first = trackDecisions([], [{ repoId: 'o/r', kind: 'issue', number: 7 }], open, T0);
    expect(first).toEqual([rec()]);
    expect(trackDecisions(first, [{ repoId: 'o/r', kind: 'issue', number: 7 }], open, T0 + 5 * H)).toEqual([rec()]);
  });

  it('drops a decision that no longer waits (a human removed the label) or closed', () => {
    expect(trackDecisions([rec()], [], open, T0 + H)).toEqual([]);
    expect(trackDecisions([rec()], [{ repoId: 'o/r', kind: 'issue', number: 7 }], () => false, T0 + H)).toEqual([]);
  });

  it('keeps one the office decided while it is open, and restarts an issue whose needs-input came back', () => {
    const applied = rec({ appliedAt: T0 + 48 * H });
    expect(trackDecisions([applied], [], open, T0 + 49 * H)).toEqual([applied]);
    const w = [{ repoId: 'o/r', kind: 'issue' as const, number: 7 }];
    expect(trackDecisions([applied], w, open, T0 + 48 * H + REOPEN_GRACE_MS / 2)).toEqual([applied]); // the stale listing
    expect(trackDecisions([applied], w, open, T0 + 60 * H)).toEqual([rec({ firstSeen: T0 + 60 * H })]);
  });

  it('never restarts a PR the office already acted on', () => {
    const pr = rec({ kind: 'pr', number: 12, appliedAt: T0 + 48 * H });
    expect(trackDecisions([pr], [{ repoId: 'o/r', kind: 'pr', number: 12 }], open, T0 + 100 * H)).toEqual([pr]);
  });
});

describe('managerReply', () => {
  const at = (h: number) => new Date(T0 + h * H).toISOString();
  it("finds the manager's first comment after the clock started", () => {
    const comments = [
      { body: 'Old question', createdAt: at(-1), author: 'sam' },
      { body: `QA report ${OFFICE_MARK}`, createdAt: at(1), author: 'sam' },
      { body: renderBrief(brief()), createdAt: at(2), author: 'sam' },
      { body: 'Looks good', createdAt: at(3), author: 'renovate[bot]' },
      { body: 'Go with Sunrise.', createdAt: at(4), author: 'sam' },
    ];
    expect(managerReply(comments, T0)).toBe(T0 + 4 * H);
    expect(managerReply(comments.slice(0, 4), T0)).toBeNull();
  });
});

describe('clockStep', () => {
  const late = T0 + 49 * H;
  it('waits before the deadline, after a reply, at timeout 0, and without a brief', () => {
    expect(clockStep({ record: rec(), hours: 48, brief: brief(), now: T0 + 47 * H }).do).toBe('wait');
    expect(clockStep({ record: rec({ answeredAt: T0 + H }), hours: 48, brief: brief(), now: late }).do).toBe('wait');
    expect(clockStep({ record: rec(), hours: 0, brief: brief(), now: late }).do).toBe('wait');
    expect(clockStep({ record: rec(), hours: 48, brief: null, now: late })).toEqual({ do: 'wait', why: 'no brief with a recommendation yet' });
    expect(clockStep({ record: rec({ appliedAt: late }), hours: 48, brief: brief(), now: late }).do).toBe('wait');
  });

  it('proceeds with an issue past its deadline', () => {
    expect(clockStep({ record: rec(), hours: 48, brief: brief(), now: late })).toEqual({ do: 'proceed-issue', recommendation: 'Build Harbour.' });
  });

  it('merges a held PR only when the brief says merge and QA and the checks are green', () => {
    const pr = rec({ kind: 'pr', number: 12 });
    const green = { qaPassed: true, checks: 'passing', mergeable: 'MERGEABLE' };
    expect(clockStep({ record: pr, hours: 48, brief: brief('Merge it.'), now: late, pr: green })).toEqual({ do: 'merge', recommendation: 'Merge it.' });
    expect(clockStep({ record: pr, hours: 48, brief: brief('Merge it.'), now: late, pr: { ...green, checks: 'none' } }).do).toBe('merge');
    expect(clockStep({ record: pr, hours: 48, brief: brief('Merge it.'), now: late, pr: { ...green, checks: 'failing' } })).toEqual({ do: 'send-back', note: 'Merge it.' });
    expect(clockStep({ record: pr, hours: 48, brief: brief('Merge it.'), now: late, pr: { ...green, mergeable: 'CONFLICTING' } }).do).toBe('send-back');
    expect(clockStep({ record: pr, hours: 48, brief: brief('Merge it.'), now: late, pr: { ...green, qaPassed: false } }).do).toBe('send-back');
    expect(clockStep({ record: pr, hours: 48, brief: brief('Rename the plan to Pro, then merge.'), now: late, pr: green }).do).toBe('send-back');
    expect(clockStep({ record: pr, hours: 48, brief: brief('Do not merge: use the MIT licence.'), now: late, pr: green })).toEqual({ do: 'send-back', note: 'Do not merge: use the MIT licence.' });
  });
});

describe('alertStep', () => {
  it('alerts once with the brief, or after the grace period without one', () => {
    expect(alertStep(rec(), true, T0)).toBe('brief');
    expect(alertStep(rec(), false, T0)).toBeNull();
    expect(alertStep(rec(), false, T0 + BRIEF_GRACE_MS)).toBe('no-brief');
    expect(alertStep(rec({ alerted: 'no-brief' }), false, T0 + 5 * H)).toBeNull();
    expect(alertStep(rec({ alerted: 'no-brief' }), true, T0 + 5 * H)).toBe('brief'); // the brief arrived later
    expect(alertStep(rec({ alerted: 'brief' }), true, T0 + 5 * H)).toBeNull();
    expect(alertStep(rec({ answeredAt: T0 }), true, T0)).toBeNull();
  });
});

describe('defaultComment', () => {
  it('says what the office did and is marked as the office’s', () => {
    const c = defaultComment(48, 'Build  Harbour.', 'proceeds');
    expect(c).toMatch(/^No reply within 48 h, so the office proceeds with the recommendation: Build Harbour\./);
    expect(c).toContain(OFFICE_MARK);
    expect(managerReply([{ body: c, createdAt: new Date(T0 + H).toISOString(), author: 'sam' }], T0)).toBeNull();
  });
});
