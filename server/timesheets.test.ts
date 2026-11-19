import { describe, expect, it } from 'vitest';
import { DEFAULT_KIMAI, kimaiProblem, kimaiSettings } from '../shared/kimai.ts';
import type { KimaiSettings } from '../shared/types.ts';
import { describe as describeSession, localDateTime, shortCount, spanSession, tags, timesheet, workSpans, type WorkSession } from './timesheets.ts';

// Finished sessions as Kimai timesheets (docs/kimai.md): the payload per kind of work and mapping, the time zone, and
// the working spans (less waits on Claude's usage limit, nothing under the shortest task).
const T0 = Date.UTC(2026, 10, 17, 15, 0, 0); // 2026-11-17 15:00:00 UTC

const settings: KimaiSettings = kimaiSettings(DEFAULT_KIMAI, {
  mode: 'live',
  url: 'https://time.example.com',
  timezone: 'America/Chicago',
  projects: { r1: 11 },
  billable: { r1: false },
  activities: { issue: 21, qa: 22, fix: 23, planning: 24 },
  users: { ada: 5 },
  planningProject: 99,
});

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    key: `ada:${T0}`,
    agentId: 'ada',
    agentName: 'Ada',
    repoId: 'r1',
    repo: 'acme/shop',
    work: 'issue',
    issue: 12,
    pr: 34,
    title: 'Add a cart',
    model: 'claude-opus-5-5',
    cli: 'claude',
    begin: T0,
    end: T0 + 45 * 60_000,
    ...over,
  };
}

describe('timesheet', () => {
  it('builds the build task: project, activity, user, local times, tags, billable', () => {
    expect(timesheet(session(), [T0, T0 + 45 * 60_000], settings)).toEqual({
      payload: {
        begin: '2026-11-17T09:00:00',
        end: '2026-11-17T09:45:00',
        project: 11,
        activity: 21,
        description: '[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 45m actual · claude-opus-5-5 via claude',
        tags: 'ai-agent',
        billable: false,
        user: 5,
      },
    });
  });

  it('maps QA and Fix to their activities, and leaves the user out when the agent has none', () => {
    const qa = timesheet(session({ work: 'qa', agentId: 'bo', agentName: 'Bo', issue: null }), [T0, T0 + 60_000], settings);
    expect(qa).toMatchObject({ payload: { activity: 22, description: '[QA] Bo · acme/shop PR #34 · Add a cart · 1m actual · claude-opus-5-5 via claude' } });
    expect('payload' in qa && 'user' in qa.payload).toBe(false);
    expect(timesheet(session({ work: 'fix' }), [T0, T0 + 60_000], settings)).toMatchObject({ payload: { activity: 23 } });
  });

  it('sends agents without a user of their own to the default user', () => {
    const k = { ...settings, defaultUser: 4 };
    expect(timesheet(session({ agentId: 'new-hire' }), [T0, T0 + 60_000], k)).toMatchObject({ payload: { user: 4 } });
    expect(timesheet(session(), [T0, T0 + 60_000], k)).toMatchObject({ payload: { user: 5 } });
  });

  it('logs the CEO’s office-wide jobs as planning, on the planning project', () => {
    const ceo = session({ agentId: 'ceo', agentName: 'Marcus', repoId: null, repo: '', work: 'planning', issue: null, pr: null, title: 'Weekly review' });
    expect(timesheet(ceo, [T0, T0 + 60_000], settings)).toMatchObject({ payload: { project: 99, activity: 24, billable: true, description: '[Planning] Marcus · office · Weekly review · 1m actual · claude-opus-5-5 via claude' } });
  });

  it('parks a floor with no project, naming the repo', () => {
    expect(timesheet(session({ repoId: 'r2', repo: 'acme/blog' }), [T0, T0 + 60_000], settings)).toEqual({ error: 'No Kimai project for acme/blog' });
    expect(timesheet(session(), [T0, T0 + 60_000], { ...settings, activities: { ...settings.activities, issue: null } })).toEqual({ error: 'No Kimai activity for Build' });
  });

  it('marks a session a restart cut off, and sends only the ai-agent tag', () => {
    expect(describeSession(session({ cutOff: true }), [T0, T0 + 47 * 60_000])).toBe('[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 47m actual · claude-opus-5-5 via claude (cut off by an office restart)');
    expect(tags()).toEqual(['ai-agent']);
  });

  it('says how many tokens a Claude session used and what it would cost on the API', () => {
    const tokens = { input: 5_000, output: 40_000, cacheWrite: 775_000, cacheRead: 13_100_000 };
    expect(timesheet(session({ tokens, costUsd: 4.1234 }), [T0, T0 + 45 * 60_000], settings)).toMatchObject({
      payload: { description: '[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 45m actual · 820k tokens + 13.1M cache reads · $4.12 API-equivalent · claude-opus-5-5 via claude' },
    });
    // No cache reads, no cost: only what there is.
    expect(describeSession(session({ tokens: { input: 300, output: 600, cacheWrite: 0, cacheRead: 0 } }), [T0, T0 + 60_000])).toBe('[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 1m actual · 900 tokens · claude-opus-5-5 via claude');
    expect(describeSession(session({ costUsd: 0.5 }), [T0, T0 + 60_000])).toBe('[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 1m actual · $0.50 API-equivalent · claude-opus-5-5 via claude');
  });

  it('leaves tokens and cost out for CLIs that report none, and for sessions saved before they were recorded', () => {
    const codex = session({ model: 'gpt-5.5', cli: 'codex', costUsd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } });
    expect(describeSession(codex, [T0, T0 + 60_000])).toBe('[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 1m actual · gpt-5.5 via codex');
    const old = JSON.parse(JSON.stringify(session())) as WorkSession;
    expect(describeSession(old, [T0, T0 + 60_000])).toBe('[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 1m actual · claude-opus-5-5 via claude');
  });

  it('keeps the tokens and cost for the first span of a split session', () => {
    const s = session({ tokens: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }, costUsd: 1 });
    expect(spanSession(s, 0)).toBe(s);
    expect(spanSession(s, 1)).not.toHaveProperty('tokens');
    expect(spanSession(s, 1)).not.toHaveProperty('costUsd');
    expect(spanSession(s, 1)).toMatchObject({ key: s.key, agentName: 'Ada' });
  });
});

describe('shortCount', () => {
  it('writes counts as they are under a thousand, in k, then in M with one decimal', () => {
    expect(shortCount(0)).toBe('0');
    expect(shortCount(999)).toBe('999');
    expect(shortCount(1_000)).toBe('1k');
    expect(shortCount(820_400)).toBe('820k');
    expect(shortCount(999_499)).toBe('999k');
    expect(shortCount(999_500)).toBe('1.0M');
    expect(shortCount(1_234_567)).toBe('1.2M');
    expect(shortCount(13_100_000)).toBe('13.1M');
  });
});

describe('localDateTime', () => {
  it('writes the time in the Kimai user’s zone, to the second, across DST', () => {
    expect(localDateTime(T0 + 7_000, 'America/Chicago')).toBe('2026-11-17T09:00:07');
    expect(localDateTime(T0, 'Europe/Berlin')).toBe('2026-11-17T16:00:00');
    expect(localDateTime(Date.UTC(2026, 6, 1, 15, 0, 0), 'America/Chicago')).toBe('2026-07-01T10:00:00');
    expect(localDateTime(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC')).toBe('2026-01-01T00:00:00');
  });
});

describe('workSpans', () => {
  it('is the whole session when nothing interrupts it', () => {
    expect(workSpans(T0 + 400, T0 + 30 * 60_000 + 900, [], 60_000)).toEqual([[T0, T0 + 30 * 60_000]]);
  });

  it('splits around a wait on the usage limit, and drops the pieces under the minimum', () => {
    const waits = [{ from: T0 + 10 * 60_000, to: T0 + 40 * 60_000 }];
    expect(workSpans(T0, T0 + 60 * 60_000, waits, 60_000)).toEqual([
      [T0, T0 + 10 * 60_000],
      [T0 + 40 * 60_000, T0 + 60 * 60_000],
    ]);
    expect(workSpans(T0, T0 + 10 * 60_000 + 30_000, [{ from: T0 + 30_000, to: T0 + 10 * 60_000 }], 60_000)).toEqual([]);
  });

  it('logs nothing for a task shorter than the minimum', () => {
    expect(workSpans(T0, T0 + 59_000, [], 60_000)).toEqual([]);
    expect(workSpans(T0, T0 + 59_000, [], 0)).toEqual([[T0, T0 + 59_000]]);
  });
});

describe('kimai settings', () => {
  it('keeps what was there when a patch is invalid, and explains why', () => {
    expect(kimaiProblem({ url: 'ftp://x' })).toMatch(/http\(s\)/);
    expect(kimaiProblem({ timezone: 'Mars/Olympus' })).toMatch(/time zone/);
    expect(kimaiProblem({ mode: 'sometimes' })).toMatch(/off, dry-run or live/);
    const k = kimaiSettings(settings, { projects: { r1: 'x', r2: '7' }, url: 'https://time.example.com/api/' });
    expect(k.projects).toEqual({ r2: 7 });
    expect(k.url).toBe('https://time.example.com');
  });
});
