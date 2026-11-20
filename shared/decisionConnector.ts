// The decision connector's rules (docs/decision-connector.md), shared by the server and Settings → Decision connector:
// its settings, the fixed quiet hours (midnight to 5 am Eastern, DST-aware), how often the office checks the Azure
// table, and when a queued answer is too old to apply. Pure.
import type { DecisionConnectorSettings } from './types.ts';

export type { DecisionConnectorSettings };

export const DEFAULT_RECEIPTS_PER_DAY = 30;
export const MIN_RECEIPTS_PER_DAY = 1;
export const MAX_RECEIPTS_PER_DAY = 100;

export const DEFAULT_DECISION_CONNECTOR: DecisionConnectorSettings = { enabled: false, tableEndpoint: '', receiptsPerDay: DEFAULT_RECEIPTS_PER_DAY };

/** Quiet hours: no push, no poll, and answers asked in them are refused. Fixed in version one. */
export const QUIET_TZ = 'America/New_York';
export const QUIET_END_HOUR = 5; // from midnight until 05:00
export const QUIET_LABEL = 'midnight to 5 am Eastern';

/** The poll schedule (brief section 5). */
export const POLL_IDLE_MS = 5 * 60_000; // no open decisions
export const POLL_OPEN_MS = 30_000; // decisions open
export const POLL_SESSION_MS = 3_000; // a voice session is active
/** A "session active" row younger than this means Bryan's Claude is calling the connector now. */
export const SESSION_FRESH_MS = 10 * 60_000;
/** An answer older than this when the office picks it up is refused, not applied. */
export const STALE_ANSWER_MS = 30 * 60_000;
/** The snapshot's heartbeat, written even when nothing changed. */
export const HEARTBEAT_MS = 60 * 60_000;

/** The only tools the connector has. Nothing else (close, send back, hold, merge in order) is ever applied. */
export const CONNECTOR_TOOLS = ['approve_recommendation', 'choose_option', 'retry_qa'] as const;
export type ConnectorTool = (typeof CONNECTOR_TOOLS)[number];
export const isConnectorTool = (t: unknown): t is ConnectorTool => typeof t === 'string' && (CONNECTOR_TOOLS as readonly string[]).includes(t);

/** A receipt's subject, or a reply to one ("Re: Decision recorded: …"): the inbox never reads these (mailInbox.ts). */
export const RECEIPT_SUBJECT = /^\s*((re|fw|fwd|aw|sv|wg)\s*:\s*)*decision recorded:/i;

// Azure storage account names: 3-24 lowercase letters and digits.
const TABLE_HOST = /^[a-z0-9]{3,24}\.table\.core\.windows\.net$/;

/** The table endpoint as https://<account>.table.core.windows.net ('' = not set), or null when it isn't one. */
export function tableEndpointOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/') || u.port) return null;
    return TABLE_HOST.test(u.hostname) ? `https://${u.hostname}` : null;
  } catch {
    return null;
  }
}

/** A table SAS token (with or without its leading "?"), or null when it doesn't look like one. */
export function sasTokenOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^\?/, '');
  if (s.length < 20 || s.length > 2048 || /\s/.test(s)) return null;
  const keys = new Set(s.split('&').map((p) => p.split('=')[0]));
  return keys.has('sig') && keys.has('sv') ? s : null;
}

const validReceipts = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= MIN_RECEIPTS_PER_DAY && n <= MAX_RECEIPTS_PER_DAY;

/** What's wrong with a settings patch, worded for the settings page; null when nothing is. */
export function decisionConnectorProblem(patch: unknown): string | null {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof DecisionConnectorSettings, unknown>>;
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') return 'The connector is on or off.';
  if (p.tableEndpoint !== undefined && tableEndpointOf(p.tableEndpoint) === null) return 'The table endpoint must be https://<account>.table.core.windows.net';
  if (p.receiptsPerDay !== undefined && !validReceipts(p.receiptsPerDay)) return `Receipts per day must be a whole number from ${MIN_RECEIPTS_PER_DAY} to ${MAX_RECEIPTS_PER_DAY}.`;
  return null;
}

/** The settings from a saved state or a patch over `base`; anything invalid keeps what base had. */
export function decisionConnectorSettings(base: Partial<DecisionConnectorSettings> | undefined, patch: unknown): DecisionConnectorSettings {
  const b = { ...DEFAULT_DECISION_CONNECTOR, ...base };
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof DecisionConnectorSettings, unknown>>;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : b.enabled === true,
    tableEndpoint: p.tableEndpoint === undefined ? (tableEndpointOf(b.tableEndpoint) ?? '') : (tableEndpointOf(p.tableEndpoint) ?? b.tableEndpoint),
    receiptsPerDay: validReceipts(p.receiptsPerDay) ? p.receiptsPerDay : validReceipts(b.receiptsPerDay) ? b.receiptsPerDay : DEFAULT_RECEIPTS_PER_DAY,
  };
}

// ---------- quiet hours ----------

const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: QUIET_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The wall clock in Eastern time (EST or EDT, whichever is in force at `at`), in seconds since midnight. */
export function easternSeconds(at: number): number {
  const parts = Object.fromEntries(clockFmt.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
}

/** Whether `at` falls in quiet hours (00:00 to 05:00 America/New_York). */
export function inQuietHours(at: number): boolean {
  return easternSeconds(at) < QUIET_END_HOUR * 3600;
}

/** How long until quiet hours end (0 outside them), right across a DST change that night. */
export function msUntilQuietEnds(at: number): number {
  if (!inQuietHours(at)) return 0;
  const sub = at % 1000;
  let end = at - sub + (QUIET_END_HOUR * 3600 - easternSeconds(at)) * 1000;
  // A DST change between now and 05:00 moves the wall clock by an hour: correct by what 05:00 actually reads as.
  for (let i = 0; i < 2; i++) {
    const off = easternSeconds(end) - QUIET_END_HOUR * 3600;
    if (off === 0 || Math.abs(off) > 2 * 3600) break;
    end -= off * 1000;
  }
  return Math.max(1000, end - at);
}

/** "2026-11-20 20:28 UTC (3:28 PM Eastern)". */
export function bothZones(at: number): string {
  const d = new Date(at);
  const utc = `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
  const et = new Intl.DateTimeFormat('en-US', { timeZone: QUIET_TZ, hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(d);
  return `${utc} (${et} Eastern)`;
}

// ---------- the poll schedule ----------

/**
 * When the office next checks the table, in ms; null: not at all (switched off, or not set up). Quiet hours: nothing
 * until they end. A voice session (its row under 10 minutes old): every 3 s. Decisions open: 30 s. Otherwise 5 min.
 */
export function pollDelay(o: { enabled: boolean; configured: boolean; now: number; open: number; sessionAt: number | null }): number | null {
  if (!o.enabled || !o.configured) return null;
  if (inQuietHours(o.now)) return msUntilQuietEnds(o.now);
  if (o.sessionAt !== null && Math.abs(o.now - o.sessionAt) < SESSION_FRESH_MS) return POLL_SESSION_MS;
  return o.open > 0 ? POLL_OPEN_MS : POLL_IDLE_MS;
}
