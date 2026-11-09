import { describe, expect, it } from 'vitest';
import { buildDigest, decisionInfoLines, digestDay, digestDue, excerpt, floorSummary, mergedSince, needsInputIssues, NO_BRIEF, waitingPulls, type DigestFloor } from './digest.ts';
import { whenLabel } from './decisionClock.ts';
import type { Brief } from '../shared/brief.ts';
import { readyDecision } from './decision.ts';
import type { IssueInfo, PullInfo } from '../shared/types.ts';

const pull = (number: number, over: Partial<PullInfo> = {}): PullInfo => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  headRefName: `swarm/${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  closesIssues: [],
  createdAt: '2026-10-01T00:00:00Z',
  mergedAt: null,
  additions: 1,
  deletions: 1,
  checks: 'passing',
  headSha: 'abc',
  mergeState: 'CLEAN',
  failedChecks: [],
  pendingChecks: [],
  ...over,
});

const issue = (number: number, labels: string[] = [], body = 'Body'): IssueInfo => ({ number, title: `Issue ${number}`, body, url: `https://github.com/o/r/issues/${number}`, labels, createdAt: '2026-10-01T00:00:00Z' });

const floor = (name: string, over: Partial<DigestFloor> = {}): DigestFloor => ({ name, waiting: [], needsInput: [], merged: [], ...over });

describe('waitingPulls', () => {
  const qa = [
    { prNumber: 3, status: 'passed' as const },
    { prNumber: 4, status: 'testing' as const },
    { prNumber: 5, status: 'passed' as const },
  ];

  it('lists open PRs QA passed when auto-merge is off', () => {
    const pulls = [pull(5), pull(3), pull(4), pull(6), pull(7, { state: 'MERGED' })];
    expect(waitingPulls(pulls, qa, false).map((p) => p.number)).toEqual([3, 5]);
    expect(waitingPulls(pulls, qa, false)[0].why).toBe('QA passed; auto-merge is off');
  });

  it('lists none while auto-merge is on: those merge by themselves', () => {
    expect(waitingPulls([pull(3), pull(5)], qa, true)).toEqual([]);
  });

  it('lists a held PR even while auto-merge is on, with what held it', () => {
    const held = [{ prNumber: 3, status: 'passed' as const, heldFor: 'db/migrations/0012.sql' }, { prNumber: 5, status: 'passed' as const, heldFor: null }];
    const w = waitingPulls([pull(3), pull(5)], held, true);
    expect(w.map((p) => p.number)).toEqual([3]);
    expect(w[0].why).toBe('held for you: db/migrations/0012.sql');
    expect(w[0].decision.pick).toBe('merge it');
  });

  it('lists a stuck PR once the CEO hands it on, with the office’s pick', () => {
    const stuck = [
      { prNumber: 3, status: 'needs-human' as const, escalated: true, stuckWhy: 'it still fails its checks after 5 fixes' },
      { prNumber: 5, status: 'needs-human' as const, escalated: false, stuckWhy: 'x' }, // the CEO is still on it
    ];
    const w = waitingPulls([pull(3), pull(5)], stuck, true, 'web');
    expect(w.map((p) => p.number)).toEqual([3]);
    expect(w[0].why).toBe('stuck: it still fails its checks after 5 fixes');
    expect(w[0].decision.question).toBe('PR #3 on web is stuck: it still fails its checks after 5 fixes. What next?');
    expect(w[0].decision.pick).toBe('send it back with a note');
  });

  it('skips a passed PR that is no longer open', () => {
    expect(waitingPulls([pull(3, { state: 'CLOSED' })], qa, false)).toEqual([]);
  });
});

describe('needsInputIssues and excerpt', () => {
  it('keeps issues labelled needs-input, in any case', () => {
    expect(needsInputIssues([issue(2, ['bug']), issue(9, ['Needs-Input']), issue(1, ['needs-input', 'swarm:skip'])]).map((i) => i.number)).toEqual([1, 9]);
  });

  it('puts text on one line and cuts it to 300 characters', () => {
    expect(excerpt('  a\n\nb  ')).toBe('a b');
    const long = excerpt('x'.repeat(400));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
    expect(excerpt('y'.repeat(300))).toBe('y'.repeat(300));
  });
});

describe('mergedSince', () => {
  it('keeps the last 24 hours, newest first', () => {
    const now = Date.parse('2026-10-21T08:00:00Z');
    const pulls = [
      { n: 1, mergedAt: '2026-10-20T07:59:00Z' },
      { n: 2, mergedAt: '2026-10-20T09:00:00Z' },
      { n: 3, mergedAt: '2026-10-21T07:00:00Z' },
      { n: 4, mergedAt: null },
    ];
    expect(mergedSince(pulls, now).map((p) => p.n)).toEqual([3, 2]);
  });
});

describe('buildDigest', () => {
  it('still goes out on a quiet day, as the all-clear', () => {
    const d = buildDigest([floor('o/a'), floor('o/b')]);
    expect(d.decisions).toBe(0);
    expect(d.subject).toBe('Office: nothing waits for you');
    expect(d.text).toContain('Nothing waits for you. No PR merged in the last 24 hours.');
  });

  it('counts decisions across floors and lists each floor that has something', () => {
    const dark = { number: 12, title: 'Dark mode', url: 'https://github.com/o/web/pull/12' };
    const d = buildDigest(
      [
        floor('o/web', {
          waiting: [{ ...dark, why: 'QA passed; auto-merge is off', decision: readyDecision('web', dark, null) }],
          needsInput: [{ number: 7, title: 'Which palette?', url: 'https://github.com/o/web/issues/7', excerpt: 'Sunrise or Harbour?' }],
          merged: [{ number: 10, title: 'Fix count', url: 'https://github.com/o/web/pull/10' }],
        }),
        floor('o/api', { needsInput: [{ number: 3, title: 'Rate limit <60>?', url: 'https://github.com/o/api/issues/3', excerpt: '' }] }),
        floor('o/quiet'),
      ],
      { officeUrl: 'https://office.example.com' },
    )!;
    expect(d.decisions).toBe(3);
    expect(d.subject).toBe('Office: 3 decisions waiting');
    expect(d.text).toContain('3 decisions wait for you across 2 floors.');
    expect(d.text.indexOf('o/api')).toBeLessThan(d.text.indexOf('o/web')); // floors by name
    expect(d.text).not.toContain('o/quiet');
    expect(d.text).toContain(
      [
        '- Merge PR #12 on web?',
        '  Dark mode.',
        '  Options: merge it, send it back with a note or close it.',
        '  Recommended: merge it. QA passed; auto-merge is off on this floor.',
        '  To approve, open Approvals and tap Merge.',
        '  https://github.com/o/web/pull/12',
      ].join('\n'),
    );
    expect(d.text).toContain('Open Approvals: https://office.example.com/?tab=approvals');
    expect(d.text).toContain('- #7 Which palette?\n  https://github.com/o/web/issues/7\n  > Sunrise or Harbour?');
    expect(d.text).toContain('Merged in the last 24 hours:\n- #10 Fix count');
    expect(d.text).toContain('Open the office: https://office.example.com');
    expect(d.html).toContain('<b>Merge PR #12 on web?</b><br><a href="https://github.com/o/web/pull/12">#12</a> Dark mode');
    expect(d.html).toContain('Rate limit &lt;60&gt;?');
  });

  it('says one decision in the singular', () => {
    const d = buildDigest([floor('o/web', { needsInput: [{ number: 7, title: 'Q', url: 'u', excerpt: 'e' }] })]);
    expect(d.subject).toBe('Office: 1 decision waiting');
    expect(d.text.split('\n')[0]).toBe('1 decision waits for you.');
  });

  it('says nothing waits when only merges happened', () => {
    const d = buildDigest([floor('o/web', { merged: [{ number: 10, title: 'Fix count', url: 'u' }, { number: 11, title: 'More', url: 'u' }] })]);
    expect(d.decisions).toBe(0);
    expect(d.subject).toBe('Office: nothing waits for you');
    expect(d.text.split('\n')[0]).toBe('Nothing waits for you. 2 PRs merged in the last 24 hours.');
  });
});

describe('digestDue', () => {
  const at = (h: number, m = 0, day = 21) => new Date(2026, 9, day, h, m);

  it('names the local day', () => {
    expect(digestDay(at(0, 5))).toBe('2026-10-21');
    expect(digestDay(new Date(2026, 0, 3, 23, 59))).toBe('2026-01-03');
  });

  it('is due on the first check at or after the hour', () => {
    expect(digestDue(at(7, 59), 8, null)).toBe(false);
    expect(digestDue(at(8, 0), 8, null)).toBe(true);
    expect(digestDue(at(15, 30), 8, '2026-10-20')).toBe(true);
  });

  it('is not due again the same day, so a restart does not resend it', () => {
    expect(digestDue(at(8, 1), 8, '2026-10-21')).toBe(false);
    expect(digestDue(at(23, 59), 8, '2026-10-21')).toBe(false);
    expect(digestDue(at(8, 0, 22), 8, '2026-10-21')).toBe(true);
  });

  it('handles midnight', () => {
    expect(digestDue(at(0, 0), 0, '2026-10-20')).toBe(true);
    expect(digestDue(at(23, 0), 23, null)).toBe(true);
  });
});

describe('decision briefs in the digest', () => {
  const now = Date.parse('2026-11-09T08:00:00Z');
  const H = 3_600_000;
  const brief: Brief = {
    background: 'Pricing is not in the spec.',
    decision: 'Free tier or 14-day trial?',
    options: ['Free tier: more sign-ups', 'Trial: more paid'],
    recommendation: 'Trial.',
    risk: 'Fewer sign-ups; revisit after a month.',
    ifNoReply: '',
  };

  it('renders a brief section by section, with the deadline, and flags one due within 24 hours', () => {
    const lines = decisionInfoLines({ brief, deadline: now + 10 * H }, now);
    expect(lines[0]).toBe(`Due within 24 hours: by ${whenLabel(now + 10 * H)}, the office applies the recommendation.`);
    expect(lines.slice(1)).toEqual([
      'Background: Pricing is not in the spec.',
      'The decision: Free tier or 14-day trial?',
      'Options: (1) Free tier: more sign-ups (2) Trial: more paid',
      'Recommendation: Trial.',
      'Risk and mitigation: Fewer sign-ups; revisit after a month.',
      `If no reply by ${whenLabel(now + 10 * H)}: the office applies the recommendation`,
    ]);
    expect(decisionInfoLines({ brief, deadline: now + 40 * H }, now)[0]).toBe('Background: Pricing is not in the spec.');
  });

  it('says when a brief is missing, and when the manager already replied', () => {
    expect(decisionInfoLines({ brief: null, deadline: null }, now)).toEqual([NO_BRIEF]);
    expect(decisionInfoLines({ brief, deadline: now + H, answered: true }, now)[0]).toBe('You replied, so the office will not decide this by default.');
    expect(decisionInfoLines({}, now)).toEqual([]); // not on the decision clock
  });

  it('opens each floor with an executive summary', () => {
    const f = floor('o/rtsm', {
      merged: [{ number: 10, title: 'Add the dose calculator', url: 'u' }],
      inProgress: ['Kit returns'],
      needsInput: [{ number: 7, title: 'Free tier or trial?', url: 'u', excerpt: '', brief: null, deadline: now + 10 * H }],
      milestone: { title: 'M2', open: 3, closed: 9 },
    });
    expect(floorSummary(f, now)).toEqual([
      'Merged in the last 24 hours: Add the dose calculator.',
      'In progress: Kit returns.',
      `Open decisions: 1 decision, 1 due within 24 hours: #7 Free tier or trial? (default applies ${whenLabel(now + 10 * H)}) (brief missing).`,
      'Milestone M2: 9 of 12 issues closed (75%).',
    ]);
    expect(floorSummary(floor('o/x', { inProgress: [] }), now)).toEqual(['Nothing merged in the last 24 hours.', 'Nothing in progress.', 'No decisions wait for you.']);
  });

  it('puts the brief in place of the excerpt and counts what is due in the subject', () => {
    const d = buildDigest(
      [
        floor('o/rtsm', {
          needsInput: [
            { number: 7, title: 'Free tier or trial?', url: 'u7', excerpt: 'old comment', brief, deadline: now + 10 * H },
            { number: 8, title: 'Product name', url: 'u8', excerpt: 'which name?', brief: null, deadline: now + 40 * H },
          ],
        }),
      ],
      { now },
    );
    expect(d.subject).toBe('Office: 2 decisions waiting (1 due within 24 hours)');
    expect(d.text).toContain('  Recommendation: Trial.');
    expect(d.text).not.toContain('> old comment');
    expect(d.text).toContain(`  > which name?\n  ${NO_BRIEF}`);
    expect(d.html).toContain('<b>Due within 24 hours: by ');
    expect(d.html).toContain('Recommendation: Trial.');
  });

  it('shows a held PR by its brief instead of the office’s own pick', () => {
    const [waiting] = waitingPulls([pull(3)], [{ prNumber: 3, status: 'passed', heldFor: 'label swarm:hold' }], true, 'web');
    const d = buildDigest([floor('o/web', { waiting: [{ ...waiting, brief: { ...brief, recommendation: 'Merge it.' }, deadline: now + 30 * H }] })], { now });
    expect(d.text).toContain('  Recommendation: Merge it.');
    expect(d.text).not.toContain('Options: merge it, send it back');
    const bare = buildDigest([floor('o/web', { waiting: [{ ...waiting, brief: null, deadline: now + 30 * H }] })], { now });
    expect(bare.text).toContain('Options: merge it, send it back with a note or close it.');
    expect(bare.text).toContain(NO_BRIEF);
  });
});

describe('Decision room links in the digest', () => {
  it('link every decision to its card', () => {
    const d = buildDigest([floor('o/rtsm', { needsInput: [{ number: 7, title: 'Plan name', url: 'u7', excerpt: '' }], waiting: waitingPulls([pull(3)], [{ prNumber: 3, status: 'passed', heldFor: 'label swarm:hold' }], true, 'rtsm') })], {
      officeUrl: 'https://office.example.com',
      now: 0,
    });
    expect(d.text).toContain('  Answer in the Decision room: https://office.example.com/decisions#o/rtsm/7');
    expect(d.text).toContain('  Answer in the Decision room: https://office.example.com/decisions#o/rtsm/3');
    expect(d.html).toContain('<a href="https://office.example.com/decisions#o/rtsm/7">Answer in the Decision room</a>');
    expect(buildDigest([floor('o/rtsm', { needsInput: [{ number: 7, title: 'Plan name', url: 'u7', excerpt: '' }] })]).text).not.toContain('Decision room');
  });
});
