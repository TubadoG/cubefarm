// Time tracking's sender (docs/kimai.md): an outbox of finished sessions in the state file, posted to Kimai one at a
// time. Network errors and 5xx are retried with backoff; a 4xx parks the entry with Kimai's reason. An entry whose post
// may have reached Kimai (attempted, then the office stopped) is looked up there before it is posted again, so no
// session is logged twice. The API token is in the secrets file under `kimai`; only whether it's set leaves the server.
import type { KimaiEntryView, KimaiSettings, KimaiView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { mergeSecrets, readSecrets } from './secrets.ts';
import { spanKey, timesheet, workSpans, type KimaiTimesheet, type LimitWait, type WorkSession } from './timesheets.ts';

export interface KimaiRequest {
  method: 'GET' | 'POST';
  url: string;
  token: string;
  body?: unknown;
}

export interface KimaiResponse {
  status: number;
  body: unknown;
}

/** The real one is fetch; the demo's answers itself and never touches the network. */
export interface KimaiTransport {
  request(req: KimaiRequest): Promise<KimaiResponse>;
  /** The demo only: the settings a fresh demo office starts with (dry-run, made-up ids), given its floors. */
  demoSettings?(repoIds: string[]): KimaiSettings;
}

const TIMEOUT_MS = 15_000;

export const httpKimai: KimaiTransport = {
  async request(req) {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { Authorization: `Bearer ${req.token}`, Accept: 'application/json', ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (a proxy's error page): kept as text
    }
    return { status: res.status, body };
  },
};

/** One entry of the outbox, as saved in the state file. */
export interface KimaiEntry {
  key: string;
  session: WorkSession;
  span: [number, number];
  status: KimaiEntryView['status'];
  payload: KimaiTimesheet | null;
  kimaiId: number | null;
  error: string | null;
  tries: number;
  nextAt: number;
  attempted: boolean; // a post went out and its answer wasn't saved: look it up before posting again
  at: number;
}

/** The outbox's part of the state file. aliveAt: the office's last state write, the end of sessions a restart cut off. */
export interface KimaiState {
  entries: KimaiEntry[];
  waits: LimitWait[];
  aliveAt: number;
}

export function emptyKimai(): KimaiState {
  return { entries: [], waits: [], aliveAt: 0 };
}

export function loadKimai(raw: unknown): KimaiState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<KimaiState>;
  return {
    entries: Array.isArray(s.entries) ? s.entries.filter((e) => e && typeof e.key === 'string' && e.session) : [],
    waits: Array.isArray(s.waits) ? s.waits : [],
    aliveAt: typeof s.aliveAt === 'number' ? s.aliveAt : 0,
  };
}

export const MAX_TRIES = 8;
const KEEP_ENTRIES = 500;
const SHOWN = 50;
const WAIT_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

/** The wait before try `tries + 1`: 30 s, doubling, at most an hour. */
export function backoffMs(tries: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, tries - 1));
}

/** `text` with the token cut out, wherever an error or a proxy echoed it. */
export function redact(text: string, token: string | null): string {
  return token && token.length >= 4 ? text.split(token).join('***') : text;
}

/** Kimai's reason for a refusal, from its JSON error ({ message, errors: { children: { field: { errors } } } }). */
export function kimaiReason(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; errors?: { children?: Record<string, { errors?: unknown }> } };
  const fields = Object.entries(b.errors?.children ?? {})
    .filter(([, v]) => Array.isArray(v?.errors) && v.errors.length)
    .map(([k, v]) => `${k}: ${(v.errors as unknown[]).join(' ')}`);
  const msg = typeof b.message === 'string' ? b.message : typeof body === 'string' ? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  const why = status === 401 || status === 403 ? 'Kimai refused the API token' : `Kimai answered ${status}`;
  return [why, msg, fields.join('; ')].filter(Boolean).join(': ').slice(0, 400);
}

export interface KimaiDeps {
  transport: KimaiTransport;
  secretsFile: string;
  state(): KimaiState;
  settings(): KimaiSettings;
  /** Write the state file now (before a post goes out, so `attempted` survives a crash). */
  persist(): Promise<void>;
  changed(view: KimaiView): void;
  /** Server log lines, never the token. */
  log(line: string): void;
  now?(): number;
}

export class KimaiSync {
  private token: string | null = null;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: KimaiDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  async init() {
    const s = await readSecrets(this.deps.secretsFile);
    const k = s.kimai as { token?: unknown } | null | undefined;
    this.token = typeof k?.token === 'string' && k.token ? k.token : null;
    for (const e of this.deps.state().entries) if (e.status === 'waiting') e.nextAt = Math.min(e.nextAt, this.now());
  }

  /** Sends what's due every 20 seconds; stop() ends it. */
  start() {
    this.timer ??= setInterval(() => void this.flush(), 20_000);
    this.timer.unref?.();
    void this.flush();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get tokenSet() {
    return !!this.token;
  }

  view(): KimaiView {
    const entries = this.deps.state().entries;
    return {
      tokenSet: !!this.token,
      entries: entries
        .slice(-SHOWN)
        .reverse()
        .map((e) => ({
          key: e.key,
          status: e.status,
          agentName: e.session.agentName,
          repo: e.session.repo,
          work: e.session.work,
          begin: e.span[0],
          end: e.span[1],
          description: e.payload?.description ?? '',
          payload: e.payload ? { ...e.payload } : null,
          kimaiId: e.kimaiId,
          error: e.error,
          tries: e.tries,
          at: e.at,
        })),
      waiting: entries.filter((e) => e.status === 'waiting').length,
      failed: entries.filter((e) => e.status === 'failed').length,
    };
  }

  // ---------- recording ----------

  /** An agent waited on Claude's usage limit from `from` until `to`: that time isn't logged. */
  limitWait(agentId: string, from: number, to: number) {
    const st = this.deps.state();
    st.waits = st.waits.filter((w) => this.now() - w.to < WAIT_KEEP_MS);
    if (to > from) st.waits.push({ agentId, from, to });
  }

  /** The state is about to be written: sessions a restart cuts off end here. */
  alive() {
    this.deps.state().aliveAt = this.now();
  }

  /** Was this session recorded already (sent, waiting, shown or parked)? */
  has(key: string) {
    return this.deps.state().entries.some((e) => e.key === key || e.key.startsWith(`${key}#`));
  }

  /** A finished session: one entry per working span, built now and, in live mode, posted soon. Off: nothing. */
  record(s: WorkSession) {
    const k = this.deps.settings();
    if (k.mode === 'off' || this.has(s.key)) return;
    const waits = this.deps.state().waits.filter((w) => w.agentId === s.agentId);
    const spans = workSpans(s.begin, s.end, waits, k.minMinutes * 60_000);
    spans.forEach((span, i) => this.push(this.entry(s, span, spanKey(s.key, i, spans.length), k)));
    if (spans.length) this.changed();
    if (k.mode === 'live') void this.flush();
  }

  /** A session the office can't log (a restart cut it off and its end is unknown): shown, never sent. */
  notLogged(s: WorkSession, why: string) {
    if (this.deps.settings().mode === 'off' || this.has(s.key)) return;
    this.push({ key: s.key, session: s, span: [s.begin, s.begin], status: 'not-logged', payload: null, kimaiId: null, error: why, tries: 0, nextAt: 0, attempted: false, at: this.now() });
    this.changed();
  }

  private entry(s: WorkSession, span: [number, number], key: string, k: KimaiSettings): KimaiEntry {
    const built = timesheet(s, span, k);
    const base = { key, session: s, span, kimaiId: null, tries: 0, nextAt: this.now(), attempted: false, at: this.now() };
    if ('error' in built) return { ...base, status: 'failed', payload: null, error: built.error };
    return { ...base, status: k.mode === 'live' ? 'waiting' : 'dry-run', payload: built.payload, error: null };
  }

  private push(e: KimaiEntry) {
    const st = this.deps.state();
    st.entries.push(e);
    let extra = st.entries.length - KEEP_ENTRIES;
    if (extra > 0) st.entries = st.entries.filter((x) => x.status === 'waiting' || extra-- <= 0);
  }

  // ---------- sending ----------

  /** Posts every due entry, one at a time. Live mode with a URL and a token only; a call during a run waits for it. */
  flush(): Promise<void> {
    const k = this.deps.settings();
    if (this.running) return this.running;
    if (k.mode !== 'live' || !k.url || !this.token) return Promise.resolve();
    const run = async () => {
      for (;;) {
        const e = this.deps.state().entries.find((x) => x.status === 'waiting' && x.nextAt <= this.now());
        if (!e || this.deps.settings().mode !== 'live') break;
        await this.send(e);
        this.changed();
      }
    };
    // .finally runs after this assignment even when nothing is due, so `running` never sticks.
    this.running = run().finally(() => (this.running = null));
    return this.running;
  }

  private async send(e: KimaiEntry) {
    const k = this.deps.settings();
    const token = this.token;
    if (!token) return;
    // Rebuilt with today's mappings, so a fixed mapping and "Retry failed" is all a parked entry needs.
    const built = timesheet(e.session, e.span, k);
    if ('error' in built) return this.park(e, built.error);
    e.payload = built.payload;
    e.tries++;
    e.at = this.now();
    try {
      if (e.attempted) {
        const found = await this.lookUp(k.url, token, built.payload);
        if (found) return this.sent(e, found);
      }
      e.attempted = true;
      await this.deps.persist();
      const res = await this.deps.transport.request({ method: 'POST', url: `${k.url}/api/timesheets`, token, body: built.payload });
      if (res.status >= 200 && res.status < 300) {
        const id = (res.body as { id?: unknown } | null)?.id;
        return this.sent(e, typeof id === 'number' ? id : null);
      }
      e.attempted = false; // Kimai answered: nothing was created
      const reason = redact(kimaiReason(res.status, res.body), token);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return this.park(e, reason);
      this.retry(e, reason);
    } catch (err) {
      this.retry(e, redact(err instanceof Error ? err.message : String(err), token));
    }
  }

  /** A timesheet already in Kimai for this payload (same start and description), by id. */
  private async lookUp(url: string, token: string, p: KimaiTimesheet): Promise<number | null> {
    const q = new URLSearchParams({ begin: p.begin, end: p.end, size: '50', full: 'false' });
    if (p.user) q.set('user', String(p.user));
    const res = await this.deps.transport.request({ method: 'GET', url: `${url}/api/timesheets?${q}`, token });
    if (res.status >= 500) throw new Error(kimaiReason(res.status, res.body));
    const rows = Array.isArray(res.body) ? (res.body as { id?: unknown; begin?: unknown; description?: unknown }[]) : [];
    const hit = rows.find((r) => typeof r.begin === 'string' && r.begin.slice(0, 19) === p.begin && r.description === p.description);
    return typeof hit?.id === 'number' ? hit.id : null;
  }

  private sent(e: KimaiEntry, id: number | null) {
    Object.assign(e, { status: 'sent', kimaiId: id, error: null, attempted: false, at: this.now() });
  }

  private park(e: KimaiEntry, why: string) {
    Object.assign(e, { status: 'failed', error: why, attempted: false, at: this.now() });
    this.deps.log(`kimai: ${e.key} parked: ${why}`);
  }

  private retry(e: KimaiEntry, why: string) {
    if (e.tries >= MAX_TRIES) return this.park(e, `Gave up after ${e.tries} tries: ${why}`);
    Object.assign(e, { error: why, nextAt: this.now() + backoffMs(e.tries), at: this.now() });
  }

  /** "Retry failed": parked entries go back in line (live), or are rebuilt with today's mappings (dry-run). */
  retryFailed(): KimaiView {
    const k = this.deps.settings();
    if (k.mode === 'off') throw new HttpError(400, 'Time tracking is off. Switch it to dry-run or live first.');
    for (const e of this.deps.state().entries) {
      if (e.status !== 'failed') continue;
      const built = timesheet(e.session, e.span, k);
      if ('error' in built) Object.assign(e, { error: built.error, payload: null, at: this.now() });
      else Object.assign(e, { status: k.mode === 'live' ? 'waiting' : 'dry-run', payload: built.payload, error: null, tries: 0, nextAt: this.now(), at: this.now() });
    }
    void this.flush();
    return this.changed();
  }

  /** "Test connection": Kimai's version, and who the token logs in as. */
  async test(): Promise<{ version: string; user: string }> {
    const k = this.deps.settings();
    if (!k.url) throw new HttpError(400, 'Set the Kimai URL first.');
    if (!this.token) throw new HttpError(400, 'Save the API token first.');
    const token = this.token;
    try {
      const v = await this.deps.transport.request({ method: 'GET', url: `${k.url}/api/version`, token });
      if (v.status !== 200) throw new HttpError(400, redact(kimaiReason(v.status, v.body), token));
      const me = await this.deps.transport.request({ method: 'GET', url: `${k.url}/api/users/me`, token });
      if (me.status !== 200) throw new HttpError(400, redact(kimaiReason(me.status, me.body), token));
      const vb = (v.body ?? {}) as { version?: unknown; semver?: unknown };
      const mb = (me.body ?? {}) as { alias?: unknown; username?: unknown };
      return { version: String(vb.semver ?? vb.version ?? 'unknown'), user: String(mb.alias || mb.username || 'unknown') };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `Couldn't reach Kimai: ${redact(err instanceof Error ? err.message : String(err), token)}`);
    }
  }

  // ---------- the token ----------

  /** PUT /api/kimai/token: saves it, and answers only that it's set. */
  async setToken(body: unknown): Promise<KimaiView> {
    const t = (body as { token?: unknown } | null)?.token;
    if (typeof t !== 'string' || t.trim().length < 8 || t.trim().length > 512 || /\s/.test(t.trim())) throw new HttpError(400, 'Paste the API token from Kimai (your profile → API access).');
    await mergeSecrets(this.deps.secretsFile, { kimai: { token: t.trim() } });
    this.token = t.trim();
    void this.flush();
    return this.changed();
  }

  /** DELETE /api/kimai/token. */
  async removeToken(): Promise<KimaiView> {
    await mergeSecrets(this.deps.secretsFile, { kimai: undefined });
    this.token = null;
    return this.changed();
  }

  /** The token, for the journal's secret filter only. */
  secret(): string | null {
    return this.token;
  }

  private changed() {
    const v = this.view();
    this.deps.changed(v);
    return v;
  }
}
