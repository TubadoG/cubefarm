import { describe, expect, it } from 'vitest';
import { buildDigest, digestDay, digestDue, excerpt, mergedSince, needsInputIssues, waitingPulls, type DigestFloor } from './digest.ts';
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
    const d = buildDigest(
      [
        floor('o/web', {
          waiting: [{ number: 12, title: 'Dark mode', url: 'https://github.com/o/web/pull/12', why: 'QA passed; auto-merge is off' }],
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
    expect(d.text).toContain('- #12 Dark mode (QA passed; auto-merge is off)\n  https://github.com/o/web/pull/12');
    expect(d.text).toContain('- #7 Which palette?\n  https://github.com/o/web/issues/7\n  > Sunrise or Harbour?');
    expect(d.text).toContain('Merged in the last 24 hours:\n- #10 Fix count');
    expect(d.text).toContain('Open the office: https://office.example.com');
    expect(d.html).toContain('<a href="https://github.com/o/web/pull/12">#12</a> Dark mode');
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
