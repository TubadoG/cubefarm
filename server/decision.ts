// A PR that waits for the manager, as a decision in plain words: what is being decided, the options, the office's
// pick and why in one line, and how to approve it. The phone's notifications (push, ntfy, desktop) and the daily digest
// both word their asks with these, so the manager can decide from the alert alone. Pure.
import { briefLines, type Brief } from '../shared/brief.ts';
import { HOLD_LABEL } from '../shared/issues.ts';
import { NOT_ROUTINE } from '../shared/holds.ts';
import type { StuckAction } from '../shared/types.ts';

export interface Decision {
  question: string; // "Merge PR #12 on openRTSM?"
  title: string; // the PR's title
  url: string; // the PR on GitHub
  options: string[];
  pick: string | null; // one of options; null when the office can't tell
  why: string; // one line: why that pick
  approve: string; // how to say yes to the pick
}

interface Pr {
  number: number;
  title: string;
  url: string;
}

const READY_OPTIONS = ['merge it', 'send it back with a note', 'close it'];
const STUCK_OPTIONS = ['retry QA', 'send it back with a note', 'merge it anyway', 'close it'];
/** The Approvals button that carries out each pick. */
const BUTTON: Record<string, string> = { 'merge it': 'Merge', 'retry QA': 'Retry QA', 'send it back with a note': 'Send back', 'merge it anyway': 'Merge anyway', 'close it': 'Close' };

const approveWith = (pick: string | null) => (pick ? `To approve, open Approvals and tap ${BUTTON[pick]}.` : 'Open Approvals to choose.');

/**
 * A draft PR that only holds a branch until the manager decides: a draft with the swarm:hold label, or a draft whose
 * issue still has needs-input. QA leaves it queued (there is nothing to test yet), so it never fails its way to
 * "needs you" as a second card for a decision the manager already has on the issue. It is tested once it is marked
 * ready, or once the hold comes off and the issue is decided.
 */
export function waitsOnDecision(pr: { isDraft: boolean; labels?: readonly string[]; closesIssues: readonly number[] }, needsInput: ReadonlySet<number>): boolean {
  if (!pr.isDraft) return false;
  return (pr.labels ?? []).some((l) => l.toLowerCase() === HOLD_LABEL) || pr.closesIssues.some((n) => needsInput.has(n));
}

/** Why a passed PR is held, as the end of "it waits for you only because …". */
export function heldWhy(held: string): string {
  if (held.toLowerCase() === `label ${HOLD_LABEL}`) return `it has the ${HOLD_LABEL} label`;
  if (held.startsWith(NOT_ROUTINE)) return `it isn't routine: ${held.slice(NOT_ROUTINE.length)}`;
  return `it changes ${held}, which is on your hold list`;
}

/** A PR QA passed that waits for the manager: held (shared/holds.ts), or on a floor with auto-merge off (held null). */
export function readyDecision(floor: string, pr: Pr, held: string | null): Decision {
  const pick = 'merge it';
  return {
    question: `Merge PR #${pr.number} on ${floor}?`,
    title: pr.title,
    url: pr.url,
    options: READY_OPTIONS,
    pick,
    why: held ? `QA passed, and it waits for you only because ${heldWhy(held)}.` : 'QA passed; auto-merge is off on this floor.',
    approve: approveWith(pick),
  };
}

/** The office's pick for a stuck PR, from why it got stuck (swarm.ts stuck()). parked: a rebuild that got stuck again (rebuild.ts). */
export function stuckPrPick(stuckWhy: string | null, parked = false): { pick: string | null; why: string } {
  if (parked) return { pick: 'close it', why: 'It was already rebuilt once and got stuck again; closing it keeps its issue open for later.' };
  const w = stuckWhy ?? '';
  if (/desk couldn't be set up|session got stuck|without a usable report/.test(w)) return { pick: 'retry QA', why: 'The sessions failed, not the code, so another QA run usually clears it.' };
  if (/fix sessions/.test(w)) return { pick: 'send it back with a note', why: 'The fix sessions failed, not the code, so another fix usually goes through.' };
  if (/conflicts with|fails its checks|failed QA/.test(w)) return { pick: 'send it back with a note', why: 'Agents tried several times; a line from you on what to change usually unsticks it.' };
  return { pick: null, why: "The office can't tell what went wrong; the QA report has the details." };
}

/** The button each stuck-PR pick is carried out with (shared/types.ts StuckAction). */
const PICK_ACTION: Record<string, StuckAction> = { 'retry QA': 'retry-qa', 'send it back with a note': 'send-back', 'merge it anyway': 'merge', 'close it': 'close' };

/** The pick as the card shows it: which button is highlighted, and the one-line why under it. */
export function stuckPickView(stuckWhy: string | null, parked = false): { action: StuckAction | null; why: string } {
  const { pick, why } = stuckPrPick(stuckWhy, parked);
  return { action: pick ? (PICK_ACTION[pick] ?? null) : null, why };
}

/** A PR the office can't move on its own (needs-human). */
export function stuckPrDecision(floor: string, pr: Pr, stuckWhy: string | null, parked = false): Decision {
  const { pick, why } = stuckPrPick(stuckWhy, parked);
  return {
    question: `PR #${pr.number} on ${floor} is stuck${stuckWhy ? `: ${stuckWhy}` : ''}. What next?`,
    title: pr.title,
    url: pr.url,
    options: STUCK_OPTIONS,
    pick,
    why,
    approve: approveWith(pick),
  };
}

/** "a, b or c". */
export const orList = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The decision as lines, in the order the manager reads them: the PR, the options, the pick and why, how to approve. */
export function decisionLines(d: Decision): string[] {
  return [
    /[.!?]$/.test(d.title) ? d.title : `${d.title}.`,
    `Options: ${orList(d.options)}.`,
    d.pick ? `Recommended: ${d.pick}. ${d.why}` : `No recommendation. ${d.why}`,
    d.approve,
  ].map(cap);
}

/** A notification's title, body (one paragraph) and summary line. The PR link goes with it separately. */
export function decisionNote(d: Decision): { title: string; body: string; line: string } {
  return { title: d.question, body: decisionLines(d).join(' '), line: `${d.question} ${d.pick ? `Recommended: ${d.pick}.` : ''}`.trim() };
}

// ---------- decision briefs ----------

/**
 * The phone's alert for a decision on the decision clock (decisionClock.ts): the brief, section by section, cut to
 * fit `room` characters with every section kept, or, without a brief, what waits and that the CEO is writing one.
 */
export function briefAlert(
  d: { kind: 'issue' | 'pr'; number: number; title: string; floor: string },
  brief: Brief | null,
  by: string | null,
  room = 600,
): { title: string; body: string } {
  const title = `Decide on ${d.floor}: ${d.kind === 'pr' ? 'PR ' : ''}#${d.number} ${d.title}`;
  if (!brief) {
    const what = d.kind === 'pr' ? 'This PR passed QA and waits for you.' : 'The team needs your answer before building this.';
    return { title, body: `${what} No decision brief yet: the CEO is writing it.` };
  }
  let body = '';
  for (let max = 200; max >= 20; max -= 10) {
    body = briefLines(brief, { by, max }).join('\n');
    if (body.length <= room) break;
  }
  return { title, body };
}
