import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KIMAI, kimaiSettings } from '../shared/kimai.ts';
import type { KimaiSettings, KimaiView } from '../shared/types.ts';
import { emptyKimai, KimaiSync, loadKimai, MAX_TRIES, redact, type KimaiRequest, type KimaiResponse, type KimaiState } from './kimai.ts';
import type { WorkSession } from './timesheets.ts';

// Time tracking's sender (docs/kimai.md) with a fake transport: each session posted once (across a restart too),
// 5xx retried, 4xx parked with Kimai's reason, dry-run silent, and the token kept out of everything but the secrets file.
const T0 = Date.UTC(2026, 10, 17, 15, 0, 0);
const TOKEN = 'kimai-secret-token-0123456789';

const LIVE: KimaiSettings = kimaiSettings(DEFAULT_KIMAI, {
  mode: 'live',
  url: 'https://time.example.com',
  timezone: 'UTC',
  projects: { r1: 11 },
  activities: { issue: 21, qa: 22, fix: 23, planning: 24 },
});

function session(over: Partial<WorkSession> = {}): WorkSession {
  return { key: `ada:${T0}`, agentId: 'ada', agentName: 'Ada', repoId: 'r1', repo: 'acme/shop', work: 'issue', issue: 12, pr: 34, title: 'Add a cart', model: 'm', cli: 'claude', begin: T0, end: T0 + 30 * 60_000, ...over };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function rig(opts: { settings?: KimaiSettings; state?: KimaiState; answer?: (req: KimaiRequest) => KimaiResponse | Promise<KimaiResponse>; token?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimai-'));
  dirs.push(dir);
  const secretsFile = path.join(dir, 'secrets.json');
  if (opts.token !== false) await fs.writeFile(secretsFile, JSON.stringify({ kimai: { token: TOKEN } }));
  const requests: KimaiRequest[] = [];
  const logs: string[] = [];
  const views: KimaiView[] = [];
  let now = T0 + 60 * 60_000;
  let id = 500;
  const state = opts.state ?? emptyKimai();
  let settings = opts.settings ?? LIVE;
  const sync = new KimaiSync({
    transport: {
      request: async (req) => {
        requests.push(req);
        return opts.answer ? opts.answer(req) : { status: 200, body: req.method === 'GET' ? [] : { id: ++id } };
      },
    },
    secretsFile,
    state: () => state,
    settings: () => settings,
    persist: async () => undefined,
    changed: (v) => views.push(v),
    log: (l) => logs.push(l),
    now: () => now,
  });
  await sync.init();
  return {
    sync,
    state,
    requests,
    logs,
    views,
    posts: () => requests.filter((r) => r.method === 'POST'),
    advance: (ms: number) => (now += ms),
    set: (k: KimaiSettings) => (settings = k),
    secretsFile,
  };
}

describe('KimaiSync', () => {
  it('posts a finished session once, even when it is reported twice', async () => {
    const r = await rig();
    r.sync.record(session());
    r.sync.record(session({ end: T0 + 31 * 60_000 }));
    await r.sync.flush();
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]).toMatchObject({ url: 'https://time.example.com/api/timesheets', token: TOKEN, body: { begin: '2026-11-17T15:00:00', end: '2026-11-17T15:30:00', project: 11, activity: 21 } });
    expect(r.state.entries).toMatchObject([{ status: 'sent', kimaiId: 501 }]);
  });

  it('sends what was waiting at a restart once, looking it up first when a post may have gone out', async () => {
    const first = await rig({ answer: () => Promise.reject(new Error('socket hang up')) });
    first.sync.record(session());
    await first.sync.flush();
    expect(first.state.entries[0]).toMatchObject({ status: 'waiting', tries: 1 });
    // The office stopped with the post in flight: the next one finds it in Kimai instead of posting it again.
    first.state.entries[0].attempted = true;
    const saved = loadKimai(JSON.parse(JSON.stringify(first.state)));
    const found = await rig({
      state: saved,
      answer: (req) => (req.method === 'GET' ? { status: 200, body: [{ id: 777, begin: '2026-11-17T15:00:00+0000', description: '[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 30m actual · m via claude' }] } : { status: 200, body: { id: 1 } }),
    });
    await found.sync.flush();
    expect(found.posts()).toHaveLength(0);
    expect(found.state.entries[0]).toMatchObject({ status: 'sent', kimaiId: 777 });
    await found.sync.flush();
    expect(found.requests).toHaveLength(1);
  });

  it('a waiting entry that never reached Kimai is posted once after a restart', async () => {
    const before = await rig({ settings: { ...LIVE, mode: 'live' }, token: false });
    before.sync.record(session());
    const after = await rig({ state: loadKimai(JSON.parse(JSON.stringify(before.state))) });
    await after.sync.flush();
    await after.sync.flush();
    expect(after.posts()).toHaveLength(1);
    expect(after.state.entries[0].status).toBe('sent');
  });

  it('retries a 5xx with backoff, and gives up after the last try', async () => {
    const r = await rig({ answer: () => ({ status: 503, body: { message: 'Service Unavailable' } }) });
    r.sync.record(session());
    await r.sync.flush();
    expect(r.state.entries[0]).toMatchObject({ status: 'waiting', tries: 1, error: 'Kimai answered 503: Service Unavailable' });
    await r.sync.flush();
    expect(r.posts()).toHaveLength(1); // not due yet
    for (let i = 1; i < MAX_TRIES; i++) {
      r.advance(2 * 60 * 60_000);
      await r.sync.flush();
    }
    expect(r.posts()).toHaveLength(MAX_TRIES);
    expect(r.state.entries[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Gave up after 8 tries/) });
  });

  it('parks a 4xx with Kimai’s reason, and retries it once the manager asks', async () => {
    let refuse = true;
    const r = await rig({
      answer: () => (refuse ? { status: 400, body: { code: 400, message: 'Validation Failed', errors: { children: { activity: { errors: ['This value is not valid.'] } } } } } : { status: 200, body: { id: 9 } }),
    });
    r.sync.record(session());
    await r.sync.flush();
    expect(r.state.entries[0]).toMatchObject({ status: 'failed', error: 'Kimai answered 400: Validation Failed: activity: This value is not valid.' });
    r.advance(24 * 60 * 60_000);
    await r.sync.flush();
    expect(r.posts()).toHaveLength(1); // parked: not retried on its own
    refuse = false;
    r.sync.retryFailed();
    await r.sync.flush();
    expect(r.state.entries[0]).toMatchObject({ status: 'sent', kimaiId: 9 });
  });

  it('parks a floor with no project without sending anything', async () => {
    const r = await rig();
    r.sync.record(session({ repoId: 'r2', repo: 'acme/blog' }));
    await r.sync.flush();
    expect(r.requests).toHaveLength(0);
    expect(r.state.entries[0]).toMatchObject({ status: 'failed', error: 'No Kimai project for acme/blog' });
  });

  it('dry-run builds the entry and makes no request; off records nothing', async () => {
    const r = await rig({ settings: { ...LIVE, mode: 'dry-run' } });
    r.sync.record(session());
    await r.sync.flush();
    expect(r.requests).toHaveLength(0);
    expect(r.sync.view().entries[0]).toMatchObject({ status: 'dry-run', payload: { project: 11, activity: 21 } });
    r.set({ ...LIVE, mode: 'off' });
    r.sync.record(session({ key: 'bo:1', agentId: 'bo' }));
    expect(r.state.entries).toHaveLength(1);
  });

  it('logs nothing for a floor marked "Don\'t log"', async () => {
    const r = await rig({ settings: { ...LIVE, skip: { r2: true } } });
    r.sync.record(session({ repoId: 'r2', repo: 'acme/blog' }));
    r.sync.notLogged(session({ key: 'bo:1', repoId: 'r2' }), 'cut off');
    r.sync.record(session());
    await r.sync.flush();
    expect(r.state.entries.map((e) => e.session.repoId)).toEqual(['r1']);
    expect(r.posts()).toHaveLength(1);
  });

  it('subtracts a wait on the usage limit, splitting the entry around it', async () => {
    const r = await rig();
    r.sync.limitWait('ada', T0 + 10 * 60_000, T0 + 20 * 60_000);
    r.sync.limitWait('bo', T0, T0 + 30 * 60_000); // someone else's wait changes nothing here
    r.sync.record(session());
    await r.sync.flush();
    expect(r.posts().map((p) => [(p.body as { begin: string }).begin, (p.body as { end: string }).end])).toEqual([
      ['2026-11-17T15:00:00', '2026-11-17T15:10:00'],
      ['2026-11-17T15:20:00', '2026-11-17T15:30:00'],
    ]);
    expect(r.state.entries.map((e) => e.key)).toEqual([`ada:${T0}#1`, `ada:${T0}#2`]);
    r.sync.record(session());
    expect(r.state.entries).toHaveLength(2);
  });

  it('shows a cut-off session it cannot time as not logged, and never sends it', async () => {
    const r = await rig();
    r.sync.notLogged(session(), 'Not logged: end unknown');
    await r.sync.flush();
    expect(r.requests).toHaveLength(0);
    expect(r.sync.view().entries[0]).toMatchObject({ status: 'not-logged', error: 'Not logged: end unknown' });
  });

  it('keeps the token out of the state, the view, the logs and errors', async () => {
    const r = await rig({ answer: () => ({ status: 401, body: `<html>bad token ${TOKEN}</html>` }) });
    r.sync.record(session());
    await r.sync.flush();
    await expect(r.sync.test()).rejects.toThrow(/Kimai refused the API token/);
    const leaked = JSON.stringify({ state: r.state, view: r.sync.view(), views: r.views, logs: r.logs });
    expect(leaked).not.toContain(TOKEN);
    expect(leaked).toContain('***');
    expect(JSON.parse(await fs.readFile(r.secretsFile, 'utf8'))).toEqual({ kimai: { token: TOKEN } });
    expect(redact(`x ${TOKEN} y`, TOKEN)).toBe('x *** y');
  });

  it('saves the token to the secrets file and answers only that it is set', async () => {
    const r = await rig({ token: false });
    expect(r.sync.view().tokenSet).toBe(false);
    const v = await r.sync.setToken({ token: ` ${TOKEN} ` });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(v.tokenSet).toBe(true);
    await expect(r.sync.setToken({ token: 'short' })).rejects.toThrow(/API token/);
    expect((await r.sync.removeToken()).tokenSet).toBe(false);
    expect(JSON.parse(await fs.readFile(r.secretsFile, 'utf8'))).toEqual({});
  });

  it('tests the connection: version and who the token signs in as', async () => {
    const r = await rig({ answer: (req) => (req.url.endsWith('/api/version') ? { status: 200, body: { semver: '2.26.0' } } : { status: 200, body: { username: 'bryan', alias: 'Bryan' } }) });
    await expect(r.sync.test()).resolves.toEqual({ version: '2.26.0', user: 'Bryan' });
  });
});

describe('the office and the token', () => {
  it('never writes the token to the state file or the snapshot', async () => {
    vi.resetModules();
    const { createDemoBackend } = await import('./demo.ts');
    const { Swarm } = await import('./swarm.ts');
    const { STATE_FILE } = await import('./config.ts');
    const swarm = new Swarm(createDemoBackend());
    const internals = swarm as unknown as { writeState(): Promise<void> };
    await swarm.kimai.setToken({ token: TOKEN });
    swarm.updateSettings({ kimai: { ...LIVE, mode: 'dry-run' } });
    swarm.kimai.record(session());
    await internals.writeState();
    const file = await fs.readFile(STATE_FILE, 'utf8');
    expect(file).toContain('"kimai"');
    expect(file).not.toContain(TOKEN);
    expect(JSON.stringify(swarm.snapshot())).not.toContain(TOKEN);
    expect(swarm.snapshot().kimai).toMatchObject({ tokenSet: true });
    await swarm.kimai.removeToken();
  });
});

describe('sessions a restart cut off', () => {
  it('are logged once, up to the last state write, or shown as not logged', async () => {
    vi.resetModules();
    const { createDemoBackend } = await import('./demo.ts');
    const { Swarm } = await import('./swarm.ts');
    const swarm = new Swarm(createDemoBackend());
    const internals = swarm as unknown as { state: { repos: unknown[]; settings: { kimai: KimaiSettings } }; logCutOff(a: unknown, at: number): void };
    internals.state.repos.push({ id: 'r1', fullName: 'acme/shop' });
    internals.state.settings.kimai = { ...LIVE, mode: 'dry-run' };
    const agent = { id: 'ada', name: 'Ada', role: 'agent', repoId: 'r1', task: 'fix', issueNumber: null, prNumber: 34, issueTitle: 'Add a cart', startedAt: T0, model: '', sessionCli: 'claude' };
    internals.logCutOff(agent, T0 + 20 * 60_000);
    internals.logCutOff(agent, T0 + 25 * 60_000);
    internals.logCutOff({ ...agent, id: 'bo', name: 'Bo', startedAt: T0 + 60_000 }, T0);
    const entries = swarm.kimai.view().entries;
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.agentName === 'Ada')).toMatchObject({ status: 'dry-run', end: T0 + 20 * 60_000, description: '[Fix] Ada · acme/shop PR #34 · Add a cart · 20m actual · claude (cut off by an office restart)' });
    expect(entries.find((e) => e.agentName === 'Bo')).toMatchObject({ status: 'not-logged', error: expect.stringMatching(/end time is unknown/) });
  });
});
