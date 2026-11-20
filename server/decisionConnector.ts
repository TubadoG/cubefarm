// The office's half of the decision connector (docs/decision-connector.md): Bryan's voice Claude answers Decision room
// cards through a small MCP server on Azure, which only keeps a snapshot of the open cards and a queue of answers in
// Azure Table storage. The office reaches those tables itself, outbound HTTPS with a table SAS token (secrets.json,
// `decisionConnector`, never logged or sent anywhere else): it pushes the snapshot when it changes (plus an hourly
// heartbeat), pulls queued answers, re-checks each one and applies it through the Room's own answerDecision / sendToQa,
// then writes the result back, audits it and emails Bryan a receipt. Nothing reaches the office from outside, and the
// connector can only approve a recommendation, choose an option or retry QA. The interface is the contract in
// projects/decision_room_connector/contract.md (Marcus's repo); the pure rules are in shared/decisionConnector.ts.
import crypto from 'node:crypto';
import { usableBrief } from '../shared/brief.ts';
import type { DecisionView } from '../shared/decisions.ts';
import {
  bothZones,
  CONNECTOR_TOOLS,
  HEARTBEAT_MS,
  inQuietHours,
  isConnectorTool,
  msUntilQuietEnds,
  pollDelay,
  QUIET_LABEL,
  sasTokenOf,
  STALE_ANSWER_MS,
} from '../shared/decisionConnector.ts';
import type { DecisionConnectorResultView, DecisionConnectorSettings, DecisionConnectorView } from '../shared/types.ts';
import { answerPlan, type AnswerOptions, type AnswerPlan } from './decisionAnswer.ts';
import type { AuditRow } from './decisionAudit.ts';
import type { OutgoingEmail } from './graphMail.ts';
import { HttpError } from './httpError.ts';
import { mergeSecrets, readSecrets } from './secrets.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const oneLine = (s: unknown) => (s instanceof Error ? s.message : String(s)).replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (n <= 0 ? '' : s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const iso = (ms: number) => new Date(ms).toISOString();

// ---------- the snapshot (pure) ----------

/** What an option does, by answerPlan: merge the PR, send it back with a note, or unblock the issue (decided:manager). */
export type Effect = 'merge' | 'send_back' | 'unblock';

export interface SnapshotOption {
  label: string;
  effect: Effect;
  note: string | null; // the send-back note
}

export interface LastResult {
  answerId: string;
  status: 'applied' | 'refused';
  detail: string;
  at: string;
}

/** One card in `snapshot.decisions` (contract.md). */
export interface SnapshotCard {
  key: string; // "<repo>#<number>"
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  brief: string; // at most BRIEF_CHARS
  recommendation: string; // '' when the brief has none
  /** What approving does, by the same answerPlan as the options; null when there is no recommendation to approve. */
  recommendationEffect: Effect | null;
  recommendationNote: string | null; // the send-back note
  options: SnapshotOption[];
  headSha: string | null;
  openedAt: string | null;
  lastResult: LastResult | null;
}

export const BRIEF_CHARS = 600;
/**
 * The most characters of `decisions` (contract: "max ~60 KB"). A table string property holds 64 KiB of UTF-16, so 30,000
 * characters is about 60 KB stored, whatever the text.
 */
export const DECISIONS_MAX_CHARS = 30_000;

function effectOf(plan: AnswerPlan): { effect: Effect; note: string | null } {
  if (plan.pr?.do === 'merge') return { effect: 'merge', note: null };
  if (plan.pr?.do === 'send-back') return { effect: 'send_back', note: plan.pr.note };
  return { effect: 'unblock', note: null };
}

/** A Room card as the snapshot has it, each option's effect computed by the Room's own answerPlan. */
export function snapshotCard(v: DecisionView, o: { headSha: string | null; openedAt: number | null; by: string }): SnapshotCard {
  const brief = v.brief && usableBrief(v.brief) ? v.brief : null;
  const options = (brief?.options ?? []).map((label, i): SnapshotOption => {
    const plan = answerPlan({ kind: v.kind, reason: v.reason, brief, by: o.by, via: 'connector' }, { choice: 'option', option: i + 1 });
    return { label: oneLine(label), ...effectOf(plan) };
  });
  let rec: { effect: Effect | null; note: string | null } = { effect: null, note: null };
  if (brief?.recommendation) {
    try {
      rec = effectOf(answerPlan({ kind: v.kind, reason: v.reason, brief, by: o.by, via: 'connector' }, { choice: 'approve' }));
    } catch {
      // no recommendation to approve: approving is refused, and the snapshot says so with null
    }
  }
  const text = brief ? [brief.decision, brief.background ? `Background: ${brief.background}` : ''].filter(Boolean).join(' ') : '';
  return {
    key: `${v.repoId}#${v.number}`,
    repo: v.repoId,
    number: v.number,
    kind: v.kind,
    title: v.title,
    brief: cut(oneLine(text), BRIEF_CHARS),
    recommendation: brief ? oneLine(brief.recommendation) : '',
    recommendationEffect: rec.effect,
    recommendationNote: rec.note,
    options,
    headSha: v.kind === 'pr' ? o.headSha : null,
    openedAt: o.openedAt ? iso(o.openedAt) : null,
    lastResult: null,
  };
}

/** `decisions` as written: shorter briefs first, then shorter texts, then fewer cards, until it fits. */
export function decisionsJson(cards: SnapshotCard[], max = DECISIONS_MAX_CHARS): string {
  for (const n of [BRIEF_CHARS, 200, 0]) {
    const json = JSON.stringify(cards.map((c) => ({ ...c, brief: cut(c.brief, n) })));
    if (json.length <= max) return json;
  }
  let list = cards.map((c) => ({
    ...c,
    brief: '',
    title: cut(c.title, 120),
    recommendation: cut(c.recommendation, 200),
    recommendationNote: c.recommendationNote === null ? null : cut(c.recommendationNote, 200),
    options: c.options.map((x) => ({ ...x, label: cut(x.label, 200), note: x.note === null ? null : cut(x.note, 200) })),
    lastResult: c.lastResult && { ...c.lastResult, detail: cut(c.lastResult.detail, 200) },
  }));
  while (list.length && JSON.stringify(list).length > max) list = list.slice(0, -1);
  return JSON.stringify(list);
}

/** One office result in `snapshot.results` (contract.md), so an applied answer shows after its card has closed. */
export interface SnapshotResult {
  answerId: string;
  key: string;
  tool: string;
  status: 'applied' | 'refused';
  detail: string;
  at: string;
}

export const RESULTS_SHOWN = 20;
export const RESULTS_MAX_CHARS = 6_000;

/** `results` as written: the newest RESULTS_SHOWN, newest first, details shortened, then the oldest dropped, to fit. */
export function resultsJson(results: SnapshotResult[], max = RESULTS_MAX_CHARS): string {
  let list = results.slice(0, RESULTS_SHOWN);
  for (const n of [Infinity, 300, 120]) {
    const json = JSON.stringify(list.map((r) => ({ ...r, detail: n === Infinity ? r.detail : cut(r.detail, n) })));
    if (json.length <= max) return json;
  }
  list = list.map((r) => ({ ...r, detail: cut(r.detail, 120) }));
  while (list.length && JSON.stringify(list).length > max) list = list.slice(0, -1);
  return JSON.stringify(list);
}

// ---------- the tables ----------

export interface TableEntity {
  PartitionKey: string;
  RowKey: string;
  [property: string]: unknown;
}

export interface TableRow {
  entity: TableEntity;
  etag: string;
}

/** The four calls the office makes (contract.md: query, add, update; never delete). */
export interface Tables {
  get(table: string, pk: string, rk: string): Promise<TableRow | null>;
  /** Insert or replace the whole entity. */
  upsert(table: string, entity: TableEntity): Promise<void>;
  /** Merge into an existing entity if its etag still is `ifMatch` ('*': any). false: it changed or is gone. */
  merge(table: string, entity: TableEntity, ifMatch: string): Promise<boolean>;
  query(table: string, filter: string): Promise<TableRow[]>;
}

/** The real one is Azure Table storage's REST API; the demo's (and the tests') keeps the tables in memory. */
export interface TablesTransport {
  open(endpoint: string, sas: string): Tables;
}

/** `text` with the SAS token (and its signature on its own) cut out, wherever an error echoed it. */
export function redactSas(text: string, sas: string | null): string {
  if (!sas) return text;
  let out = text.split(sas).join('***');
  const sig = /(?:^|&)sig=([^&]+)/.exec(sas)?.[1];
  for (const s of sig ? [sig, decodeURIComponent(sig)] : []) if (s.length >= 8) out = out.split(s).join('***');
  return out;
}

const API_VERSION = '2019-02-02';
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const quoteKey = (s: string) => encodeURIComponent(s.replace(/'/g, "''"));
const entityPath = (table: string, pk: string, rk: string) => `${table}(PartitionKey='${quoteKey(pk)}',RowKey='${quoteKey(rk)}')`;

/** An entity without OData's annotations. */
function plain(raw: Record<string, unknown>): TableEntity {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith('odata.') && !k.includes('@odata.')) out[k] = v;
  return out as TableEntity;
}

/** Azure's error code from its JSON error body, if any (never its message, which can quote the request). */
function tableCode(text: string): string {
  try {
    const code = (JSON.parse(text) as { 'odata.error'?: { code?: unknown } })['odata.error']?.code;
    return typeof code === 'string' ? ` (${code})` : '';
  } catch {
    return '';
  }
}

/**
 * Azure Table storage over REST, signed by the table SAS token in the query string. Outbound HTTPS only; the URL (which
 * carries the token) never goes into an error. Get Entity (GET), Insert Or Replace (PUT), Merge Entity (MERGE, with
 * If-Match) and Query Entities (GET with $filter, following continuation tokens).
 */
export function azureTables(fetchFn: typeof fetch = fetch): TablesTransport {
  return {
    open(endpoint, sas) {
      const call = async (method: string, path: string, o: { body?: unknown; ifMatch?: string; query?: Record<string, string> } = {}) => {
        const qs = [sas, ...Object.entries(o.query ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)].join('&');
        const headers: Record<string, string> = {
          Accept: 'application/json;odata=minimalmetadata',
          'x-ms-version': API_VERSION,
          'x-ms-date': new Date().toUTCString(),
          DataServiceVersion: '3.0;NetFx',
          MaxDataServiceVersion: '3.0;NetFx',
        };
        if (o.body !== undefined) headers['Content-Type'] = 'application/json';
        if (o.ifMatch) headers['If-Match'] = o.ifMatch;
        let res: Response;
        try {
          res = await fetchFn(`${endpoint}/${path}?${qs}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (err) {
          const cause = (err as { cause?: unknown }).cause;
          throw new Error(redactSas(`The table endpoint couldn't be reached: ${oneLine(err)}${cause ? ` (${oneLine(cause)})` : ''}`, sas));
        }
        return { status: res.status, headers: res.headers, text: await res.text().catch(() => '') };
      };
      const fail = (what: string, r: { status: number; text: string }) =>
        new Error(r.status === 403 ? `Azure refused the SAS token for ${what} (403${tableCode(r.text)}): it may have expired or lack a permission.` : `Azure Table ${what} answered ${r.status}${tableCode(r.text)}.`);
      return {
        async get(table, pk, rk) {
          const r = await call('GET', entityPath(table, pk, rk));
          if (r.status === 404) return null;
          if (r.status !== 200) throw fail(`a read of ${table}`, r);
          const body = JSON.parse(r.text) as Record<string, unknown>;
          return { entity: plain(body), etag: r.headers.get('etag') ?? String(body['odata.etag'] ?? '*') };
        },
        async upsert(table, entity) {
          const r = await call('PUT', entityPath(table, entity.PartitionKey, entity.RowKey), { body: entity });
          if (r.status !== 204 && r.status !== 200) throw fail(`a write to ${table}`, r);
        },
        async merge(table, entity, ifMatch) {
          const r = await call('MERGE', entityPath(table, entity.PartitionKey, entity.RowKey), { body: entity, ifMatch });
          if (r.status === 412 || r.status === 404) return false;
          if (r.status !== 204 && r.status !== 200) throw fail(`an update of ${table}`, r);
          return true;
        },
        async query(table, filter) {
          const out: TableRow[] = [];
          let next: Record<string, string> | null = {};
          for (let page = 0; next && page < MAX_PAGES; page++) {
            const r = await call('GET', `${table}()`, { query: { $filter: filter, ...next } });
            if (r.status !== 200) throw fail(`a query of ${table}`, r);
            const body = JSON.parse(r.text) as { value?: Record<string, unknown>[] };
            for (const e of body.value ?? []) out.push({ entity: plain(e), etag: String(e['odata.etag'] ?? '*') });
            const npk = r.headers.get('x-ms-continuation-nextpartitionkey');
            const nrk = r.headers.get('x-ms-continuation-nextrowkey');
            next = npk ? { NextPartitionKey: npk, ...(nrk ? { NextRowKey: nrk } : {}) } : null;
          }
          return out;
        },
      };
    },
  };
}

/** `Field eq 'value' and …`, the only filters the office sends. */
function parseFilter(filter: string): [string, string][] {
  return filter.split(' and ').map((part) => {
    const m = /^\s*(\w+) eq '((?:[^']|'')*)'\s*$/.exec(part);
    if (!m) throw new Error(`unsupported filter: ${filter}`);
    return [m[1], m[2].replace(/''/g, "'")];
  });
}

export interface MemoryTables extends TablesTransport {
  /** Every call made, e.g. "query answers", for tests that check nothing was pushed or polled. */
  calls: string[];
  /** An entity as stored, or null. */
  read(table: string, pk: string, rk: string): TableEntity | null;
  /** Writes as the connector would (a queued answer, the session row). */
  put(table: string, entity: TableEntity): void;
}

/** Tables in memory: the demo office's (no network) and the tests' fake backend, with Azure's etag semantics. */
export function memoryTables(): MemoryTables {
  const tables = new Map<string, Map<string, TableRow>>();
  let seq = 0;
  const tbl = (t: string) => {
    let m = tables.get(t);
    if (!m) tables.set(t, (m = new Map()));
    return m;
  };
  const id = (pk: string, rk: string) => `${pk}\u0000${rk}`;
  const etag = () => `W/"datetime'${++seq}'"`;
  const calls: string[] = [];
  const put = (t: string, e: TableEntity) => void tbl(t).set(id(e.PartitionKey, e.RowKey), { entity: { ...e }, etag: etag() });
  const api: Tables = {
    async get(t, pk, rk) {
      calls.push(`get ${t}`);
      const r = tbl(t).get(id(pk, rk));
      return r ? { entity: { ...r.entity }, etag: r.etag } : null;
    },
    async upsert(t, e) {
      calls.push(`upsert ${t}`);
      put(t, e);
    },
    async merge(t, e, ifMatch) {
      calls.push(`merge ${t}`);
      const r = tbl(t).get(id(e.PartitionKey, e.RowKey));
      if (!r || (ifMatch !== '*' && ifMatch !== r.etag)) return false;
      tbl(t).set(id(e.PartitionKey, e.RowKey), { entity: { ...r.entity, ...e }, etag: etag() });
      return true;
    },
    async query(t, filter) {
      calls.push(`query ${t}`);
      const conds = parseFilter(filter);
      return [...tbl(t).values()].filter((r) => conds.every(([k, v]) => String(r.entity[k]) === v)).map((r) => ({ entity: { ...r.entity }, etag: r.etag }));
    },
  };
  return { open: () => api, calls, read: (t, pk, rk) => tbl(t).get(id(pk, rk))?.entity ?? null, put };
}

// ---------- receipts (pure) ----------

export interface ReceiptFacts {
  repo: string;
  number: number;
  title: string;
  choice: string;
  status: 'applied' | 'refused';
  did: string; // what the office did ("merged", …), or why it refused
  short: string; // the same in a few words, for the subject
  headSha: string | null;
  askedAt: number | null;
  at: number;
  answerId: string;
  company: string;
}

/** The receipt: "Decision recorded: <repo> #N, <what happened>", and the facts, one per line. */
export function receiptEmail(f: ReceiptFacts): { subject: string; text: string } {
  const subject = cut(`Decision recorded: ${f.repo} #${f.number}, ${f.short}`, 180);
  const lines = [
    f.title || `${f.repo} #${f.number}`,
    '',
    `Choice: ${f.choice}`,
    `What the office did: ${f.status === 'applied' ? f.did : `refused it. ${f.did}`}`,
    `Head SHA: ${f.headSha ?? 'none (an issue, or not read)'}`,
    `Asked: ${f.askedAt === null ? 'unknown' : bothZones(f.askedAt)}`,
    `${f.status === 'applied' ? 'Applied' : 'Refused'}: ${bothZones(f.at)}`,
    `Via: connector (answer ${f.answerId})`,
    '',
    '-- ',
    `A receipt from ${f.company.trim() || 'the company'}'s cubefarm office for an answer given through the decision connector.`,
    "Replies to this email aren't read and never count as an answer.",
  ];
  return { subject, text: lines.join('\n') };
}

// ---------- the connector ----------

/** One answer the office picked up, with what the receipt and the card need. */
export interface ConnectorResult extends DecisionConnectorResultView {
  repo: string;
  number: number;
  title: string;
  short: string;
  headSha: string | null;
}

/** The connector's part of the state file. */
export interface ConnectorState {
  version: number; // the snapshot's, +1 on each change
  hash: string; // of the last snapshot written ('' = write the next one)
  lastPushAt: number | null;
  lastHeartbeatAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  offWritten: boolean; // the enabled=false snapshot went out after switching off
  enabledAt: number | null; // answers asked before this were asked while it was off
  results: ConnectorResult[]; // the latest KEEP_RESULTS, oldest first
  receipts: number[]; // when each receipt of the last 24 hours went out
}

const KEEP_RESULTS = 100;
const SHOWN = 20;
/** Switched off with the enabled=false row not written yet (an error): try again this often. */
const OFF_RETRY_MS = 60_000;

export function emptyConnector(): ConnectorState {
  return { version: 0, hash: '', lastPushAt: null, lastHeartbeatAt: null, lastPollAt: null, lastError: null, offWritten: true, enabledAt: null, results: [], receipts: [] };
}

export function loadConnector(raw: unknown): ConnectorState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<ConnectorState>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    version: num(s.version) ?? 0,
    hash: typeof s.hash === 'string' ? s.hash : '',
    lastPushAt: num(s.lastPushAt),
    lastHeartbeatAt: num(s.lastHeartbeatAt),
    lastPollAt: num(s.lastPollAt),
    lastError: typeof s.lastError === 'string' ? s.lastError : null,
    offWritten: s.offWritten !== false,
    enabledAt: num(s.enabledAt),
    results: Array.isArray(s.results) ? s.results.filter((r) => r && typeof r.answerId === 'string').slice(-KEEP_RESULTS) : [],
    receipts: Array.isArray(s.receipts) ? s.receipts.filter((t): t is number => typeof t === 'number') : [],
  };
}

/** What swarm.ts answerDecision did, for the result and the receipt. */
export interface AppliedAnswer {
  answer: string; // the summary: "approved the recommendation: …"
  effect: Effect;
  note: string | null;
  headSha: string | null;
}

export interface ConnectorDeps {
  transport: TablesTransport;
  secretsFile: string;
  state(): ConnectorState;
  settings(): DecisionConnectorSettings;
  /** The open cards now (swarm.ts connectorCards). */
  cards(): SnapshotCard[];
  /** The Room's answerDecision with via=connector. Throws why not. */
  answer(repoId: string, number: number, body: { choice: 'approve' } | { choice: 'option'; option: number }, opts: AnswerOptions): Promise<AppliedAnswer>;
  /** The Room's sendToQa, behind the same lock and head check, plus its GitHub comment. Throws why not. */
  retryQa(repoId: string, number: number, expectedHeadSha: string): Promise<{ headSha: string }>;
  /** When the manager answered this card, if they did. */
  answeredAt(repoId: string, number: number): number | null;
  /** Where receipts go and come from, or why they can't go. */
  receiptTo(): { from: string; to: string; toName: string; company: string } | string;
  send(msg: OutgoingEmail): Promise<void>;
  audit(row: AuditRow): void;
  /** Save the state file soon. */
  persist(): void;
  changed(view: DecisionConnectorView): void;
  log(line: string): void;
  now?(): number;
}

const DID: Record<Effect, string> = { merge: 'merged', send_back: 'sent back', unblock: 'unblocked' };

function choiceWords(tool: string, option: string): string {
  if (tool === 'approve_recommendation') return 'approve the recommendation';
  if (tool === 'choose_option') return `option "${option}"`;
  if (tool === 'retry_qa') return 'retry QA';
  return tool || '(none)';
}

const sameLabel = (a: string, b: string) => oneLine(a).toLowerCase() === oneLine(b).toLowerCase();

export class DecisionConnector {
  private sas: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dueAt: number | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private recovered = false; // rows a stopped run left as "picked" were looked for
  private sessionAt: number | null = null;
  private open = 0;

  constructor(private deps: ConnectorDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  async init() {
    const s = await readSecrets(this.deps.secretsFile);
    const c = s.decisionConnector as { sas?: unknown } | null | undefined;
    this.sas = sasTokenOf(c?.sas);
  }

  start() {
    this.stopped = false;
    this.soon(5_000);
  }

  stop() {
    this.stopped = true;
    this.clear();
  }

  /** Both the endpoint and the SAS token are set. */
  get configured() {
    return !!this.deps.settings().tableEndpoint && !!this.sas;
  }

  /** The SAS token, for the journal's secret filter only. */
  secret(): string | null {
    return this.sas;
  }

  /** Settings → Decision connector saved: switching on starts now, switching off writes enabled=false once. */
  settingsChanged(prev: DecisionConnectorSettings) {
    const s = this.deps.settings();
    const st = this.deps.state();
    if (s.enabled && !prev.enabled) Object.assign(st, { enabledAt: this.now(), offWritten: false, hash: '', lastError: null });
    if (!s.enabled && prev.enabled) Object.assign(st, { offWritten: false, lastError: null });
    if (s.tableEndpoint !== prev.tableEndpoint) st.hash = '';
    this.deps.persist();
    this.soon(0);
    this.changed();
  }

  /** The Room's cards changed: push soon (only if the snapshot did change, and never in quiet hours). */
  decisionsChanged() {
    if (this.deps.settings().enabled && this.configured && !inQuietHours(this.now())) this.soon(2_000);
  }

  /** When the next check is due, in ms from now; null: none (off, written off, or not set up). */
  nextDelay(): number | null {
    const s = this.deps.settings();
    const now = this.now();
    if (!s.enabled) {
      if (this.deps.state().offWritten || !this.configured) return null;
      return inQuietHours(now) ? msUntilQuietEnds(now) : OFF_RETRY_MS;
    }
    return pollDelay({ enabled: true, configured: this.configured, now, open: this.open, sessionAt: this.sessionAt });
  }

  /** One check now: the off row, or (on, set up, outside quiet hours) the session row, queued answers and the snapshot. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.clear();
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.tick();
      } else this.reschedule();
    });
    return this.running;
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = null;
  }

  private soon(ms: number) {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.dueAt !== null && this.dueAt <= this.now() + ms) return;
    this.at(ms);
  }

  private at(ms: number) {
    this.clear();
    this.dueAt = this.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dueAt = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
  }

  private reschedule() {
    if (this.stopped) return;
    const d = this.nextDelay();
    if (d === null) this.clear();
    else this.at(d);
    this.changed();
  }

  private async run() {
    const s = this.deps.settings();
    const st = this.deps.state();
    const now = this.now();
    if (inQuietHours(now)) return; // no publishing or polling overnight, not even the off row
    if (!s.enabled) {
      if (!st.offWritten) await this.writeOff();
      return;
    }
    if (!this.configured) {
      this.error('Set the table endpoint and the SAS token, then the office starts checking.');
      return;
    }
    const tables = this.deps.transport.open(s.tableEndpoint, this.sas!);
    try {
      st.lastPollAt = now;
      const session = await tables.get('session', 'session', 'active');
      const at = Date.parse(String(session?.entity.lastCallAt ?? ''));
      this.sessionAt = Number.isFinite(at) ? at : null;
      const rows = await tables.query('answers', "PartitionKey eq 'answer' and status eq 'queued'");
      if (!this.recovered) rows.push(...(await tables.query('answers', "PartitionKey eq 'answer' and status eq 'picked'")));
      this.recovered = true;
      rows.sort((a, b) => String(a.entity.askedAt ?? '').localeCompare(String(b.entity.askedAt ?? '')));
      for (const row of rows) await this.handle(tables, row);
      await this.push(tables);
      st.lastError = null;
    } catch (err) {
      this.error(oneLine(err));
    }
    this.deps.persist();
  }

  private error(text: string) {
    const st = this.deps.state();
    const clean = redactSas(text, this.sas);
    if (st.lastError !== clean) this.deps.log(`decision connector: ${clean}`);
    st.lastError = clean;
    this.deps.persist();
  }

  private async writeOff() {
    const st = this.deps.state();
    if (!this.configured) {
      st.offWritten = true; // nowhere to write it: the connector never saw this office on
      return;
    }
    const now = this.now();
    try {
      const tables = this.deps.transport.open(this.deps.settings().tableEndpoint, this.sas!);
      await tables.upsert('snapshot', { PartitionKey: 'office', RowKey: 'current', version: st.version + 1, writtenAt: iso(now), heartbeatAt: iso(now), enabled: false, decisions: '[]', results: '[]' });
      Object.assign(st, { version: st.version + 1, offWritten: true, hash: '', lastPushAt: now, lastError: null });
    } catch (err) {
      this.error(`Couldn't tell the connector it is off: ${oneLine(err)}`);
    }
    this.deps.persist();
  }

  /** The card's last result, as the connector shows it. */
  private lastResult(key: string): LastResult | null {
    const r = [...this.deps.state().results].reverse().find((x) => x.key === key);
    return r ? { answerId: r.answerId, status: r.status, detail: r.detail, at: iso(r.at) } : null;
  }

  /** A new snapshot when the cards, a head or a result changed; otherwise the hourly heartbeat, when it's due. */
  private async push(tables: Tables) {
    const st = this.deps.state();
    const now = this.now();
    const cards = this.deps.cards();
    this.open = cards.length;
    const decisions = decisionsJson(cards.map((c) => ({ ...c, lastResult: this.lastResult(c.key) })));
    const results = resultsJson(
      [...st.results]
        .reverse()
        .map((r) => ({ answerId: r.answerId, key: r.key, tool: r.tool, status: r.status, detail: r.detail, at: iso(r.at) })),
    );
    const hash = crypto.createHash('sha256').update(decisions).update('\u0000').update(results).digest('hex'); // a new result is a change too
    if (hash !== st.hash) {
      const version = st.version + 1;
      await tables.upsert('snapshot', { PartitionKey: 'office', RowKey: 'current', version, writtenAt: iso(now), heartbeatAt: iso(now), enabled: true, decisions, results });
      Object.assign(st, { version, hash, lastPushAt: now, lastHeartbeatAt: now });
    } else if (st.lastHeartbeatAt === null || now - st.lastHeartbeatAt >= HEARTBEAT_MS) {
      if (await tables.merge('snapshot', { PartitionKey: 'office', RowKey: 'current', heartbeatAt: iso(now) }, '*')) st.lastHeartbeatAt = now;
      else {
        st.hash = ''; // the row is gone: write it whole
        await this.push(tables);
      }
    }
  }

  /** One answer row: picked (if nobody changed it meanwhile), checked, applied or refused, written back, audited, receipted. */
  private async handle(tables: Tables, row: TableRow) {
    const st = this.deps.state();
    const id = row.entity.RowKey;
    const known = st.results.find((r) => r.answerId === id);
    if (known) return this.writeBack(tables, known); // done before the office stopped: only the write-back is missing
    let res: ConnectorResult;
    if (row.entity.status === 'picked') {
      // Picked by a run that stopped before recording what it did: never applied a second time.
      res = this.result(row.entity, this.now(), 'refused', 'The office stopped while handling it, so it may or may not have been applied: check the card before answering again.');
    } else {
      if (!(await tables.merge('answers', { PartitionKey: 'answer', RowKey: id, status: 'picked', pickedAt: iso(this.now()) }, row.etag))) return;
      res = await this.apply(row.entity);
    }
    st.results.push(res);
    if (st.results.length > KEEP_RESULTS) st.results.splice(0, st.results.length - KEEP_RESULTS);
    this.deps.persist();
    this.deps.audit({
      at: iso(this.now()),
      via: 'connector',
      tool: String(row.entity.tool ?? ''),
      repo: res.repo,
      number: res.number,
      choice: res.choice,
      result: res.status,
      detail: res.detail,
      answerId: id,
      askedAt: res.askedAt === null ? null : iso(res.askedAt),
      appliedAt: iso(res.at),
      askedBy: typeof row.entity.askedBy === 'string' ? row.entity.askedBy : null,
      expectedHeadSha: typeof row.entity.expectedHeadSha === 'string' && row.entity.expectedHeadSha ? row.entity.expectedHeadSha : null,
      actualHeadSha: res.headSha,
    });
    await this.writeBack(tables, res);
    await this.receipt(res);
    this.changed();
  }

  private async writeBack(tables: Tables, res: ConnectorResult) {
    await tables.merge('answers', { PartitionKey: 'answer', RowKey: res.answerId, status: res.status, resultAt: iso(res.at), detail: cut(res.detail, 1000) }, '*');
  }

  private result(e: TableEntity, at: number, status: 'applied' | 'refused', detail: string, more: Partial<ConnectorResult> = {}): ConnectorResult {
    const repo = typeof e.repo === 'string' ? e.repo : '';
    const number = Number(e.number);
    const asked = Date.parse(typeof e.askedAt === 'string' ? e.askedAt : '');
    const tool = typeof e.tool === 'string' ? e.tool : '';
    return {
      answerId: e.RowKey,
      key: `${repo}#${Number.isFinite(number) ? number : '?'}`,
      repo,
      number: Number.isFinite(number) ? number : 0,
      tool,
      choice: choiceWords(tool, typeof e.option === 'string' ? e.option : ''),
      status,
      detail,
      askedAt: Number.isFinite(asked) ? asked : null,
      at,
      receipt: '',
      title: '',
      short: status === 'refused' ? `refused: ${cut(detail.replace(/\.$/, ''), 70)}` : '',
      headSha: null,
      ...more,
    };
  }

  /** Everything the office re-checks before it applies an answer, then the Room's own action. */
  private async apply(e: TableEntity): Promise<ConnectorResult> {
    const st = this.deps.state();
    const now = this.now();
    const refuse = (detail: string, more: Partial<ConnectorResult> = {}) => this.result(e, this.now(), 'refused', detail, more);
    const tool = typeof e.tool === 'string' ? e.tool : '';
    const repo = typeof e.repo === 'string' ? e.repo : '';
    const number = Number(e.number);
    const option = typeof e.option === 'string' ? e.option : '';
    const expected = typeof e.expectedHeadSha === 'string' && e.expectedHeadSha.trim() ? e.expectedHeadSha.trim() : null;
    const asked = Date.parse(typeof e.askedAt === 'string' ? e.askedAt : '');
    if (!isConnectorTool(tool)) return refuse(`The connector can't do "${tool || 'that'}": only ${CONNECTOR_TOOLS.join(', ')}.`);
    if (!repo || !Number.isInteger(number) || number < 1) return refuse('The answer names no card.');
    if (!Number.isFinite(asked)) return refuse('The answer has no time it was asked.');
    if (now - asked > STALE_ANSWER_MS) return refuse(`It was asked ${Math.round((now - asked) / 60_000)} minutes before the office picked it up; answers older than 30 minutes are refused.`);
    if (inQuietHours(asked)) return refuse(`It was asked during quiet hours (${QUIET_LABEL}).`);
    if (!this.deps.settings().enabled || (st.enabledAt !== null && asked < st.enabledAt)) return refuse('It was asked while the connector was switched off.');
    const card = this.deps.cards().find((c) => c.repo === repo && c.number === number);
    if (!card) return refuse(this.deps.answeredAt(repo, number) !== null ? 'This decision was already answered.' : 'This card no longer waits for a decision.');
    const more = { title: card.title };
    if (card.kind === 'pr' && !expected) return refuse('A PR answer must name the head SHA it was given on.', more);
    try {
      if (tool === 'retry_qa') {
        if (card.kind !== 'pr') return refuse('Retry QA is only for PRs.', more);
        const r = await this.deps.retryQa(repo, number, expected!);
        return this.result(e, this.now(), 'applied', 'queued for QA', { ...more, short: 'queued for QA', headSha: r.headSha });
      }
      let body: { choice: 'approve' } | { choice: 'option'; option: number };
      if (tool === 'approve_recommendation') body = { choice: 'approve' };
      else {
        const i = card.options.findIndex((o) => sameLabel(o.label, option));
        if (i < 0) return refuse(`The card has no option "${option}".`, more);
        body = { choice: 'option', option: i + 1 };
      }
      const r = await this.deps.answer(repo, number, body, card.kind === 'pr' ? { via: 'connector', expectedHeadSha: expected! } : { via: 'connector' });
      const did = r.effect === 'merge' ? 'merged' : r.effect === 'send_back' ? `sent back to a developer with this note: ${r.note ?? ''}` : 'unblocked the issue (decided:manager)';
      return this.result(e, this.now(), 'applied', did, { ...more, choice: r.answer, short: DID[r.effect], headSha: r.headSha });
    } catch (err) {
      const msg = oneLine(err);
      const headSha = typeof (err as { headSha?: unknown }).headSha === 'string' ? (err as { headSha: string }).headSha : null;
      return refuse(/no longer waits/.test(msg) && this.deps.answeredAt(repo, number) !== null ? 'This decision was already answered.' : msg, { ...more, headSha });
    }
  }

  /** One receipt per answer, ever, within its own daily cap (not the CEO's). */
  private async receipt(res: ConnectorResult) {
    if (res.receipt) return;
    const st = this.deps.state();
    const now = this.now();
    st.receipts = st.receipts.filter((t) => now - t < DAY_MS);
    const cap = this.deps.settings().receiptsPerDay;
    const to = this.deps.receiptTo();
    if (st.receipts.length >= cap) res.receipt = `not sent: the ${cap} receipts a day are used up`;
    else if (typeof to === 'string') res.receipt = `not sent: ${to}`;
    if (res.receipt) return this.deps.persist();
    const facts = typeof to === 'string' ? null : to;
    res.receipt = 'sending';
    st.receipts.push(now);
    this.deps.persist(); // counted and marked before it goes: a restart never sends it twice
    const mail = receiptEmail({ ...res, did: res.detail, short: res.short || res.status, company: facts!.company });
    try {
      await this.deps.send({ from: facts!.from, to: facts!.to, toName: facts!.toName, subject: mail.subject, text: mail.text });
      res.receipt = 'sent';
    } catch (err) {
      res.receipt = `not sent: ${oneLine(err)}`;
    }
    this.deps.persist();
  }

  // ---------- settings ----------

  /** PUT /api/decision-connector/sas: saves the token (write-only) and answers only whether it's set. */
  async setSas(body: unknown): Promise<DecisionConnectorView> {
    const sas = sasTokenOf((body as { sas?: unknown } | null)?.sas);
    if (!sas) throw new HttpError(400, 'Paste the table SAS token: it has sv=… and sig=… in it.');
    await mergeSecrets(this.deps.secretsFile, { decisionConnector: { sas } });
    this.sas = sas;
    Object.assign(this.deps.state(), { hash: '', lastError: null });
    this.deps.persist();
    this.soon(0);
    return this.changed();
  }

  /** DELETE /api/decision-connector/sas. */
  async removeSas(): Promise<DecisionConnectorView> {
    await mergeSecrets(this.deps.secretsFile, { decisionConnector: undefined });
    this.sas = null;
    this.clear();
    return this.changed();
  }

  /** POST /api/decision-connector/check: a check now (Settings' "Check now"), within the same rules. */
  async checkNow(): Promise<DecisionConnectorView> {
    await this.tick();
    return this.view();
  }

  view(): DecisionConnectorView {
    const st = this.deps.state();
    const now = this.now();
    const day = st.results.filter((r) => now - r.at < DAY_MS);
    return {
      sasSet: !!this.sas,
      quiet: inQuietHours(now),
      lastPush: st.lastPushAt,
      lastHeartbeat: st.lastHeartbeatAt,
      lastPoll: st.lastPollAt,
      lastError: st.lastError,
      nextPollAt: this.dueAt,
      pickedToday: day.length,
      appliedToday: day.filter((r) => r.status === 'applied').length,
      refusedToday: day.filter((r) => r.status === 'refused').length,
      receiptsToday: st.receipts.filter((t) => now - t < DAY_MS).length,
      results: st.results
        .slice(-SHOWN)
        .reverse()
        .map((r) => ({ answerId: r.answerId, key: r.key, tool: r.tool, choice: r.choice, status: r.status, detail: r.detail, askedAt: r.askedAt, at: r.at, receipt: r.receipt })),
    };
  }

  private lastView = '';

  private changed(): DecisionConnectorView {
    const v = this.view();
    const json = JSON.stringify(v);
    if (json !== this.lastView) {
      this.lastView = json;
      this.deps.changed(v);
    }
    return v;
  }
}
