// Agents' finished sessions as Kimai timesheets (docs/kimai.md), pure: the working spans of a session (its wall-clock
// time, less any wait on Claude's usage limit), the description and tags, the time zone, and the mappings from floor,
// kind of work and agent to Kimai's project, activity and user. kimai.ts sends what this builds.
import type { KimaiSettings, KimaiWork } from '../shared/types.ts';
import { WORK_LABEL } from '../shared/kimai.ts';

/** One finished session, as the office saw it. Everything a timesheet needs, so a retry can rebuild it later. */
export interface WorkSession {
  key: string; // `${agentId}:${startedAt}`: a session starts once, so it is logged once
  agentId: string;
  agentName: string;
  repoId: string | null; // the floor; null for the CEO's jobs that aren't about one
  repo: string; // owner/name, '' when none
  work: KimaiWork;
  issue: number | null;
  pr: number | null;
  title: string | null;
  model: string;
  cli: string;
  begin: number;
  end: number;
  cutOff?: boolean; // ended by an office restart: end is when the office last saved its state
}

/** What POST /api/timesheets gets. begin and end are local times in the Kimai user's zone, to the second. */
export interface KimaiTimesheet {
  begin: string;
  end: string;
  project: number;
  activity: number;
  description: string;
  tags: string;
  billable: boolean;
  user?: number;
}

/** A wait on Claude's usage limit, by one agent: not working time. */
export interface LimitWait {
  agentId: string;
  from: number;
  to: number;
}

export const AI_TAG = 'ai-agent';
export const OFFICE_TAG = 'cubefarm';

/** The office server's own time zone, the default when the setting is ''. */
export function serverZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** `ms` as Kimai's local date-time (YYYY-MM-DDTHH:mm:ss) in `zone`. */
export function localDateTime(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone || serverZone(),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
}

/**
 * The working spans of [begin, end]: the session less the waits that overlap it, each span at least `minMs` long.
 * Whole seconds, so what's shown and what's sent agree.
 */
export function workSpans(begin: number, end: number, waits: { from: number; to: number }[], minMs: number): [number, number][] {
  const start = Math.floor(begin / 1000) * 1000;
  const stop = Math.floor(end / 1000) * 1000;
  let spans: [number, number][] = stop > start ? [[start, stop]] : [];
  for (const w of [...waits].sort((x, y) => x.from - y.from)) {
    const next: [number, number][] = [];
    for (const [s, e] of spans) {
      if (w.to <= s || w.from >= e) next.push([s, e]);
      else {
        if (w.from > s) next.push([s, Math.floor(w.from / 1000) * 1000]);
        if (w.to < e) next.push([Math.ceil(w.to / 1000) * 1000, e]);
      }
    }
    spans = next;
  }
  return spans.filter(([s, e]) => e - s >= Math.max(1000, minMs));
}

/** "<Agent> · <Build|QA|Fix> · <repo> #<issue> / PR #<pr> · <title>", or the planning job's label. */
export function describe(s: WorkSession): string {
  const refs = [s.issue ? `#${s.issue}` : '', s.pr ? `PR #${s.pr}` : ''].filter(Boolean).join(' / ');
  const where = [s.repo || (s.work === 'planning' ? 'office' : ''), refs].filter(Boolean).join(' ');
  const text = [s.agentName, WORK_LABEL[s.work], where, s.title?.trim() ?? ''].filter(Boolean).join(' · ');
  return (s.cutOff ? `${text} (cut off by an office restart)` : text).slice(0, 1000);
}

/** ai-agent and cubefarm on every entry, then the model and the CLI. Commas would split a tag in Kimai. */
export function tags(s: WorkSession): string[] {
  const clean = (t: string) => t.replace(/,/g, ' ').trim().slice(0, 100);
  return [...new Set([AI_TAG, OFFICE_TAG, clean(s.model), clean(s.cli)].filter(Boolean))];
}

/** The timesheet for one span of a session, or why it can't be built (a missing mapping, worded for the manager). */
export function timesheet(s: WorkSession, span: [number, number], k: KimaiSettings): { payload: KimaiTimesheet } | { error: string } {
  const project = s.repoId ? k.projects[s.repoId] : k.planningProject;
  if (!project) return { error: s.repoId ? `No Kimai project for ${s.repo || s.repoId}` : 'No Kimai project for the CEO’s office-wide jobs' };
  const activity = k.activities[s.work];
  if (!activity) return { error: `No Kimai activity for ${WORK_LABEL[s.work]}` };
  const user = k.users[s.agentId];
  return {
    payload: {
      begin: localDateTime(span[0], k.timezone),
      end: localDateTime(span[1], k.timezone),
      project,
      activity,
      description: describe(s),
      tags: tags(s).join(','),
      billable: s.repoId ? k.billable[s.repoId] !== false : true,
      ...(user ? { user } : {}),
    },
  };
}

/** The entry key of span `i` of `n`: the session's own key when it isn't split. */
export function spanKey(key: string, i: number, n: number): string {
  return n > 1 ? `${key}#${i + 1}` : key;
}
