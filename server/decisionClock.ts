// The decision clock: when the office first saw each decision that waits for the manager (a needs-input issue, a PR
// held for them), its deadline (first seen + the floor's decisionTimeoutHours), whether the manager replied, and what
// the office does once the deadline passes with no reply: apply the brief's recommendation. Pure; swarm.ts keeps the
// records (state.json) and does the GitHub side.
import { recommendsMerge, usableBrief, OFFICE_MARK, BRIEF_HEADING, type Brief } from '../shared/brief.ts';

/** The floor setting's default: two days, then the office goes with the recommendation. 0 = never. */
export const DEFAULT_DECISION_TIMEOUT_HOURS = 48;
/** Longest timeout a floor may set (30 days). */
export const MAX_DECISION_TIMEOUT_HOURS = 720;
/** The digest flags decisions due within this long. */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;
/** How long the phone alert waits for a brief before it goes out without one. */
export const BRIEF_GRACE_MS = 60 * 60 * 1000;

/** After the office decides an issue, a needs-input label seen within this long is the stale listing, not a new question. */
export const REOPEN_GRACE_MS = 10 * 60_000;

export type DecisionKind = 'issue' | 'pr';

/** One decision the office is waiting on. Kept in state.json. */
export interface DecisionRecord {
  repoId: string;
  kind: DecisionKind;
  number: number;
  firstSeen: number; // ms: when the office first saw it waiting
  answeredAt: number | null; // the manager replied: the clock stops
  appliedAt: number | null; // the office applied the recommendation
  alerted: 'brief' | 'no-brief' | null; // the phone heard about it (with or without its brief)
}

export const decisionKey = (d: Pick<DecisionRecord, 'repoId' | 'kind' | 'number'>) => `${d.repoId}#${d.kind}#${d.number}`;

/** A floor's decisionTimeoutHours from a request body: a whole number of hours, 0 to MAX. Throws a message on bad input. */
export function parseTimeoutHours(value: unknown): number {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if ( !Number.isFinite(n) || n < 0 || n > MAX_DECISION_TIMEOUT_HOURS) throw new Error(`decisionTimeoutHours must be 0 (never) to ${MAX_DECISION_TIMEOUT_HOURS} hours`);
  return Math.round(n);
}

/** When the office applies the recommendation, or null when it never does (timeout 0). */
export const deadlineOf = (firstSeen: number, hours: number): number | null => (hours > 0 ? firstSeen + hours * 3_600_000 : null);

/** Due within DUE_SOON_MS (or already past it). */
export const dueSoon = (deadline: number | null, now: number) => deadline !== null && deadline - now <= DUE_SOON_MS;

/**
 * The records after a look at what waits now: new items start their clock, items no longer waiting go. An issue the
 * office already decided keeps its record (applied) until it closes; it starts a new clock if needs-input comes back.
 * A PR the office already acted on keeps its record while it is open, so a re-held PR is never defaulted twice.
 */
export function trackDecisions(
  records: readonly DecisionRecord[],
  waiting: readonly Pick<DecisionRecord, 'repoId' | 'kind' | 'number'>[],
  open: (r: Pick<DecisionRecord, 'repoId' | 'kind' | 'number'>) => boolean,
  now: number,
): DecisionRecord[] {
  const waits = new Set(waiting.map(decisionKey));
  const out: DecisionRecord[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const key = decisionKey(r);
    if (seen.has(key) || !open(r)) continue;
    seen.add(key);
    if (waits.has(key)) {
      // needs-input came back on an issue the office decided: a new question, a new clock.
      out.push(r.appliedAt !== null && r.kind === 'issue' && now - r.appliedAt > REOPEN_GRACE_MS ? { ...r, firstSeen: now, answeredAt: null, appliedAt: null, alerted: null } : r);
    } else if (r.appliedAt !== null) out.push(r);
  }
  for (const w of waiting) {
    const key = decisionKey(w);
    if (seen.has(key) || !open(w)) continue;
    seen.add(key);
    out.push({ repoId: w.repoId, kind: w.kind, number: w.number, firstSeen: now, answeredAt: null, appliedAt: null, alerted: null });
  }
  return out;
}

export interface Comment {
  body: string;
  createdAt: string; // ISO
  author: string;
}

/**
 * When the manager first replied after `since`: a comment that is not the office's (OFFICE_MARK), not a brief and not
 * a bot's. The office posts under the manager's own GitHub login, so the mark, not the author, tells them apart.
 */
export function managerReply(comments: readonly Comment[], since: number): number | null {
  for (const c of comments) {
    const at = Date.parse(c.createdAt);
    if (!Number.isFinite(at) || at <= since) continue;
    if (c.body.includes(OFFICE_MARK) || /\[bot\]$/i.test(c.author)) continue;
    if (new RegExp(`^\\s{0,3}#{2,6}\\s+${BRIEF_HEADING}`, 'im').test(c.body)) continue;
    return at;
  }
  return null;
}

/** What the office does about one decision now. */
export type ClockStep =
  | { do: 'wait'; why: string }
  | { do: 'proceed-issue'; recommendation: string }
  | { do: 'merge'; recommendation: string }
  | { do: 'send-back'; note: string };

/**
 * The decision clock's rule for one record. A PR is merged only when its brief recommends merging and it passed QA
 * with green checks and no conflicts; otherwise it goes back to a developer with the recommendation as the note.
 */
export function clockStep(x: {
  record: DecisionRecord;
  hours: number; // the floor's decisionTimeoutHours
  brief: Brief | null;
  now: number;
  pr?: { qaPassed: boolean; checks: string; mergeable: string } | null;
}): ClockStep {
  const r = x.record;
  if (r.appliedAt !== null) return { do: 'wait', why: 'already decided by the office' };
  if (r.answeredAt !== null) return { do: 'wait', why: 'the manager replied' };
  const deadline = deadlineOf(r.firstSeen, x.hours);
  if (deadline === null) return { do: 'wait', why: 'this floor never decides by default' };
  if (x.now < deadline) return { do: 'wait', why: 'not due yet' };
  if (!usableBrief(x.brief)) return { do: 'wait', why: 'no brief with a recommendation yet' };
  const recommendation = x.brief.recommendation;
  if (r.kind === 'issue') return { do: 'proceed-issue', recommendation };
  const p = x.pr;
  if (p && recommendsMerge(recommendation) && p.qaPassed && (p.checks === 'passing' || p.checks === 'none') && p.mergeable !== 'CONFLICTING') return { do: 'merge', recommendation };
  return { do: 'send-back', note: recommendation };
}

/** Whether to tell the phone about a decision now: with its brief, or, after BRIEF_GRACE_MS, without one. */
export function alertStep(r: DecisionRecord, hasBrief: boolean, now: number): 'brief' | 'no-brief' | null {
  if (r.appliedAt !== null || r.answeredAt !== null || r.alerted === 'brief') return null;
  if (hasBrief) return 'brief';
  if (r.alerted === null && now - r.firstSeen >= BRIEF_GRACE_MS) return 'no-brief';
  return null;
}

/** "Wed 11 Nov 08:00", in the office's local time. */
export function whenLabel(ms: number): string {
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${day} ${d.getDate()} ${month} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The comment the office posts when it applies the recommendation. hours: the floor's timeout. */
export function defaultComment(hours: number, recommendation: string, what: 'proceeds' | 'merges' | 'sends it back'): string {
  const rec = recommendation.replace(/\s+/g, ' ').trim();
  const verb = what === 'proceeds' ? 'proceeds with the recommendation' : what === 'merges' ? 'merges it, as recommended' : 'sends it back to a developer with the recommendation';
  return `No reply within ${hours} h, so the office ${verb}: ${rec}\n\nThis is reversible: reply here, or change it later.\n${OFFICE_MARK}`;
}
