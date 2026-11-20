// Settings → Teams' rules (docs/teams.md), shared by the server (validation, the daily cap) and the settings card. The
// office reads one Teams channel and the CEO posts in it as its own bot; who counts as the manager, which bots are
// colleagues and how often the CEO may post are checked by the office, not by the prompt.
import type { TeamsColleague, TeamsSettings } from './types.ts';

export type { TeamsColleague, TeamsSettings };

export const DEFAULT_SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
export const DEFAULT_POLL_SECONDS = 60;
export const MIN_POLL_SECONDS = 30;
export const MAX_POLL_SECONDS = 3600;
export const DEFAULT_POSTS_PER_DAY = 40;
export const MAX_POSTS_PER_DAY = 200;
/** Most Entra users whose messages count as the manager's. */
export const MAX_MANAGERS = 10;
/** Most colleague bots. */
export const MAX_TEAMS_COLLEAGUES = 10;
export const MAX_TEAMS_NAME = 60;
/** At most this many CEO replies to bots in one thread: two agents can't talk each other into a loop. */
export const BOT_REPLIES_PER_THREAD = 3;
export const TEAMS_DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_TEAMS: TeamsSettings = {
  enabled: false,
  teamId: '',
  channelId: '',
  serviceUrl: DEFAULT_SERVICE_URL,
  pollSeconds: DEFAULT_POLL_SECONDS,
  managers: [],
  colleagues: [],
  postsPerDay: DEFAULT_POSTS_PER_DAY,
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A channel id as Graph and the Bot Framework know it: 19:<id>@thread.tacv2 (or the older thread.skype).
const CHANNEL = /^19:[A-Za-z0-9_-]{6,128}@thread\.(tacv2|skype)$/;
// The bot's token goes to this URL, so only Microsoft's Bot Framework hosts are allowed.
const SERVICE_HOST = /^(smba\.trafficmanager\.net|smba\.infra\.(gcc|gov)\.teams\.microsoft\.(com|us)|[a-z0-9-]+\.botframework\.(com|us|azure\.us))$/;

/** A GUID, trimmed and lowercased, or null. */
export function guid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return GUID.test(s) ? s : null;
}

/** A channel id, trimmed (URL-decoded when pasted from a Teams link), or null. */
export function channelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.includes('%3')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  return CHANNEL.test(s) ? s : null;
}

/** A Bot Framework service URL on a Microsoft host, with one trailing slash, or null. */
export function serviceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port || !SERVICE_HOST.test(u.hostname)) return null;
  return `${u.origin}${u.pathname.replace(/\/*$/, '/')}`;
}

const wholeIn = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

/** The manager's ids from a patch, or null when it isn't a valid list. */
function managerList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_MANAGERS) return null;
  const out: string[] = [];
  for (const m of raw as unknown[]) {
    const id = guid(m);
    if (!id) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Colleague bots from a patch, or null when it isn't a valid list. Each needs a name; the app id is optional. */
function colleagueList(raw: unknown): TeamsColleague[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TEAMS_COLLEAGUES) return null;
  const out: TeamsColleague[] = [];
  for (const c of raw as unknown[]) {
    const x = (c && typeof c === 'object' ? c : {}) as { name?: unknown; appId?: unknown };
    const name = typeof x.name === 'string' ? x.name.replace(/\s+/g, ' ').trim().slice(0, MAX_TEAMS_NAME) : '';
    const appId = x.appId === undefined || x.appId === '' ? '' : guid(x.appId);
    if (!name || appId === null) return null;
    if (out.some((o) => (appId && o.appId === appId) || o.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name, appId });
  }
  return out;
}

/** What's wrong with a Teams settings patch, in words Settings → Teams can show; null when nothing is. `base`: the settings now. */
export function teamsProblem(patch: unknown, base: TeamsSettings = DEFAULT_TEAMS): string | null {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof TeamsSettings, unknown>>;
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') return 'Teams is on or off.';
  if (p.teamId !== undefined && p.teamId !== '' && !guid(p.teamId)) return "The team id must be the team's group id, e.g. 44ffe347-85e3-4917-88c2-176352e79788.";
  if (p.channelId !== undefined && p.channelId !== '' && !channelId(p.channelId)) return 'The channel id looks like 19:…@thread.tacv2 (from “Get link to channel”).';
  if (p.serviceUrl !== undefined && !serviceUrl(p.serviceUrl)) return 'The service URL must be a Bot Framework address on a Microsoft host, e.g. https://smba.trafficmanager.net/amer/.';
  if (p.pollSeconds !== undefined && !wholeIn(p.pollSeconds, MIN_POLL_SECONDS, MAX_POLL_SECONDS)) return `Check the channel every ${MIN_POLL_SECONDS} to ${MAX_POLL_SECONDS} seconds.`;
  if (p.postsPerDay !== undefined && !wholeIn(p.postsPerDay, 1, MAX_POSTS_PER_DAY)) return `The CEO's daily posts must be a whole number from 1 to ${MAX_POSTS_PER_DAY}.`;
  if (p.managers !== undefined) {
    if (!Array.isArray(p.managers)) return 'The list of your Teams ids is missing.';
    if (p.managers.length > MAX_MANAGERS) return `At most ${MAX_MANAGERS} ids can count as yours.`;
    const bad = (p.managers as unknown[]).find((m) => !guid(m));
    if (bad !== undefined) return `"${String(bad)}" isn't an Entra object id (a GUID).`;
  }
  if (p.colleagues !== undefined) {
    if (!Array.isArray(p.colleagues)) return 'The list of colleague bots is missing.';
    if (p.colleagues.length > MAX_TEAMS_COLLEAGUES) return `At most ${MAX_TEAMS_COLLEAGUES} colleague bots fit on the list.`;
    for (const c of p.colleagues as { name?: unknown; appId?: unknown }[]) {
      if (typeof c?.name !== 'string' || !c.name.trim()) return 'Each colleague bot needs a name.';
      if (c.appId !== undefined && c.appId !== '' && !guid(c.appId)) return `"${String(c.appId)}" isn't an app id (a GUID).`;
    }
  }
  const next = teamsSettings(base, patch);
  if (p.enabled === true && (!next.teamId || !next.channelId)) return 'Set the team id and the channel id first.';
  return null;
}

/** Teams settings from a saved state or a PATCH /api/settings, field by field; anything invalid keeps `base`. */
export function teamsSettings(base: TeamsSettings | undefined, patch: unknown): TeamsSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof TeamsSettings, unknown>>;
  const b = { ...DEFAULT_TEAMS, ...base };
  const teamId = p.teamId === '' ? '' : (guid(p.teamId) ?? b.teamId);
  const channel = p.channelId === '' ? '' : (channelId(p.channelId) ?? b.channelId);
  return {
    enabled: (typeof p.enabled === 'boolean' ? p.enabled : b.enabled) && !!teamId && !!channel,
    teamId,
    channelId: channel,
    serviceUrl: serviceUrl(p.serviceUrl) ?? serviceUrl(b.serviceUrl) ?? DEFAULT_SERVICE_URL,
    pollSeconds: wholeIn(p.pollSeconds, MIN_POLL_SECONDS, MAX_POLL_SECONDS) ? p.pollSeconds : wholeIn(b.pollSeconds, MIN_POLL_SECONDS, MAX_POLL_SECONDS) ? b.pollSeconds : DEFAULT_POLL_SECONDS,
    managers: p.managers === undefined ? (managerList(b.managers) ?? []) : (managerList(p.managers) ?? managerList(b.managers) ?? []),
    colleagues: p.colleagues === undefined ? (colleagueList(b.colleagues) ?? []) : (colleagueList(p.colleagues) ?? colleagueList(b.colleagues) ?? []),
    postsPerDay: wholeIn(p.postsPerDay, 1, MAX_POSTS_PER_DAY) ? p.postsPerDay : wholeIn(b.postsPerDay, 1, MAX_POSTS_PER_DAY) ? b.postsPerDay : DEFAULT_POSTS_PER_DAY,
  };
}

/** The CEO's posts that count toward the daily cap: those in the last 24 hours. */
export function postsToday(posts: readonly number[], now: number): number {
  return posts.filter((at) => now - at < TEAMS_DAY_MS && at <= now).length;
}
