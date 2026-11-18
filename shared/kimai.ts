// Settings → Time tracking's rules (docs/kimai.md), shared by the server (validation) and the settings page: agents'
// working time goes to Kimai as timesheets, off by default, with a dry-run that only shows what it would send.
import type { KimaiMode, KimaiSettings, KimaiWork } from './types.ts';

export type { KimaiMode, KimaiSettings, KimaiWork };

export const KIMAI_MODES: KimaiMode[] = ['off', 'dry-run', 'live'];
export const KIMAI_WORK: KimaiWork[] = ['issue', 'qa', 'fix', 'planning'];
/** How each kind of work is named in a description, and the activity it usually maps to in Kimai. */
export const WORK_LABEL: Record<KimaiWork, string> = { issue: 'Build', qa: 'QA', fix: 'Fix', planning: 'Planning' };
export const WORK_ACTIVITY_HINT: Record<KimaiWork, string> = { issue: 'Development', qa: 'QA', fix: 'Rework', planning: 'Planning' };
export const MAX_MIN_MINUTES = 60;

export const DEFAULT_KIMAI: KimaiSettings = {
  mode: 'off',
  url: '',
  timezone: '',
  minMinutes: 1,
  planning: false,
  projects: {},
  billable: {},
  skip: {},
  activities: { issue: null, qa: null, fix: null, planning: null },
  users: {},
  defaultUser: null,
  planningProject: null,
};

/** A Kimai id (a positive whole number), or null. */
export function kimaiId(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

/** The instance's base URL without a trailing slash or /api, or null when it isn't an http(s) address. */
export function kimaiUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return s;
  } catch {
    return null;
  }
}

/** An IANA time zone this runtime knows ('' = the server's), or null. */
export function timeZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return null;
  }
}

function idMap(raw: unknown, base: Record<string, number>): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    const id = kimaiId(v);
    if (id !== null && k) out[k] = id;
  }
  return out;
}

function boolMap(raw: unknown, base: Record<string, boolean>): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) if (typeof v === 'boolean' && k) out[k] = v;
  return out;
}

/** What's wrong with a settings patch, worded for the settings page; null when nothing is. */
export function kimaiProblem(patch: unknown): string | null {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof KimaiSettings, unknown>>;
  if (p.mode !== undefined && !KIMAI_MODES.includes(p.mode as KimaiMode)) return 'The mode must be off, dry-run or live.';
  if (p.url !== undefined && kimaiUrl(p.url) === null) return 'The Kimai URL must be an http(s) address, e.g. https://time.example.com';
  if (p.timezone !== undefined && timeZone(p.timezone) === null) return `"${String(p.timezone)}" isn't a time zone this server knows (e.g. America/Chicago).`;
  if (p.minMinutes !== undefined) {
    const n = Number(p.minMinutes);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MIN_MINUTES) return `The shortest task logged must be 0 to ${MAX_MIN_MINUTES} minutes.`;
  }
  if (p.mode === 'live' && p.url === '') return 'Set the Kimai URL before you switch to live.';
  return null;
}

/** The settings from a saved state or a patch over `base`; anything invalid keeps what base had. */
export function kimaiSettings(base: KimaiSettings | undefined, patch: unknown): KimaiSettings {
  const b = { ...DEFAULT_KIMAI, ...base, activities: { ...DEFAULT_KIMAI.activities, ...base?.activities } };
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof KimaiSettings, unknown>>;
  const url = p.url === undefined ? b.url : (kimaiUrl(p.url) ?? b.url);
  const tz = p.timezone === undefined ? b.timezone : (timeZone(p.timezone) ?? b.timezone);
  const minRaw = p.minMinutes === undefined ? b.minMinutes : Number(p.minMinutes);
  const minMinutes = Number.isFinite(minRaw) ? Math.max(0, Math.min(MAX_MIN_MINUTES, minRaw)) : b.minMinutes;
  const acts = (p.activities && typeof p.activities === 'object' ? p.activities : {}) as Partial<Record<KimaiWork, unknown>>;
  const activities = { ...b.activities };
  for (const w of KIMAI_WORK) if (acts[w] !== undefined) activities[w] = kimaiId(acts[w]);
  return {
    mode: KIMAI_MODES.includes(p.mode as KimaiMode) ? (p.mode as KimaiMode) : b.mode,
    url,
    timezone: tz,
    minMinutes,
    planning: typeof p.planning === 'boolean' ? p.planning : b.planning,
    projects: p.projects === undefined ? b.projects : idMap(p.projects, b.projects),
    billable: p.billable === undefined ? b.billable : boolMap(p.billable, b.billable),
    skip: p.skip === undefined ? b.skip : boolMap(p.skip, b.skip),
    activities,
    users: p.users === undefined ? b.users : idMap(p.users, b.users),
    defaultUser: p.defaultUser === undefined ? b.defaultUser : kimaiId(p.defaultUser),
    planningProject: p.planningProject === undefined ? b.planningProject : kimaiId(p.planningProject),
  };
}
