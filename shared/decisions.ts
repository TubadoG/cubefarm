// The Decision room (docs/how-it-works.md): every open decision on every floor as a card the manager answers from the
// office or a phone. Its view, the manager's choices, its deep links (/decisions#owner/repo/number, used by the digest
// and the push alerts) and the countdown to the office's default. Pure, for the server and the client.
import type { Brief } from './brief.ts';

/** Where the Decision room lives in the office web app. */
export const DECISIONS_PATH = '/decisions';
/** On an issue the manager answered in the Decision room. */
export const DECIDED_MANAGER = 'decided:manager';

/** Why a decision waits for the manager: an issue labelled needs-input, a PR held after QA, or a stuck PR the CEO escalated. */
export type DecisionReason = 'needs-input' | 'held' | 'stuck';

/** One message in a card's thread: the manager's questions, the CEO's answers, what the office recorded. */
export interface DecisionMessage {
  from: 'manager' | 'ceo' | 'office';
  text: string;
  at: number;
}

export interface DecisionView {
  key: string; // decisionKeyOf(repoId, number)
  repoId: string;
  floor: number;
  kind: 'issue' | 'pr';
  reason: DecisionReason;
  number: number;
  title: string;
  url: string;
  brief: Brief | null; // null: none yet (or not read yet: briefRead)
  briefRead: boolean;
  deadline: number | null; // when the office applies the recommendation; null: never (or a stuck PR)
  answeredAt: number | null;
  answer: string | null; // what the manager chose, in words
  thread: DecisionMessage[];
  asking: boolean; // a question is with the CEO
}

/** What the manager can answer on a card. option: 1-based, as the brief lists them. */
export type DecisionChoice =
  | { choice: 'approve' }
  | { choice: 'option'; option: number }
  | { choice: 'send-back'; note: string }
  | { choice: 'close'; note?: string };

/** Most characters in a note or a question from the card. */
export const MAX_DECISION_TEXT = 1000;

export const decisionKeyOf = (repoId: string, number: number) => `${repoId}#${number}`;

/** A card's hash in the Decision room: "owner/repo/12". */
export const decisionHash = (repoId: string, number: number) => `${repoId}/${number}`;

/**
 * The deep link to a card, on the office's public address (Settings → Notifications → Office address for links, e.g.
 * https://foundry.example.com). An address with a path (an office behind a proxy at /office/) keeps it.
 */
export function decisionLink(officeUrl: string, repoId: string, number: number): string {
  const base = new URL(officeUrl);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const u = new URL(DECISIONS_PATH.slice(1), base);
  u.hash = decisionHash(repoId, number);
  return u.toString();
}

/** The card a hash points at ("#owner/repo/12", URL-encoded or not), or null. */
export function parseDecisionHash(hash: string | null | undefined): { repoId: string; number: number } | null {
  let h = (hash ?? '').replace(/^#/, '');
  try {
    h = decodeURIComponent(h);
  } catch {
    return null;
  }
  const m = /^([^/\s]+\/[^/\s]+)\/(\d+)$/.exec(h);
  return m ? { repoId: m[1], number: Number(m[2]) } : null;
}

/** Whether a location is the Decision room ("/decisions", or ".../decisions" behind a proxy's path). */
export const isDecisionsPath = (pathname: string) => /(^|\/)decisions\/?$/.test(pathname);

/** The office's own path for a Decision room location: what's left when the room is closed. */
export const officePath = (pathname: string) => pathname.replace(/decisions\/?$/, '') || '/';

/** The time left before the office applies the recommendation, in words: "1 d 4 h left", "35 min left", "overdue". */
export function countdown(deadline: number | null, now: number): { label: string; due: boolean; overdue: boolean } | null {
  if (deadline === null) return null;
  const left = deadline - now;
  if (left <= 0) return { label: 'overdue: the office applies the recommendation at its next check', due: true, overdue: true };
  const min = Math.ceil(left / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const label = d ? `${d} d ${h} h left` : h ? `${h} h ${m} min left` : `${m} min left`;
  return { label, due: left <= 24 * 3_600_000, overdue: false };
}

/** A choice from a request body. Throws a message on bad input. */
export function parseDecisionChoice(body: unknown): DecisionChoice {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (b.choice === 'approve') return { choice: 'approve' };
  if (b.choice === 'option') {
    const n = Number(b.option);
    if (!Number.isInteger(n) || n < 1) throw new Error('option must be the number of an option on the card (1, 2, …)');
    return { choice: 'option', option: n };
  }
  if (b.choice === 'send-back') {
    const note = text(b.note);
    if (!note) throw new Error('Write a note: it tells the team what to do instead.');
    if (note.length > MAX_DECISION_TEXT) throw new Error(`The note is too long (at most ${MAX_DECISION_TEXT} characters).`);
    return { choice: 'send-back', note };
  }
  if (b.choice === 'close') {
    const note = text(b.note);
    if (note.length > MAX_DECISION_TEXT) throw new Error(`The note is too long (at most ${MAX_DECISION_TEXT} characters).`);
    return note ? { choice: 'close', note } : { choice: 'close' };
  }
  throw new Error('choice must be approve, option, send-back or close');
}
