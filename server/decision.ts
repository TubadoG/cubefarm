// A PR that waits for the manager, as a decision in plain words: what is being decided, the options, the office's
// pick and why in one line, and how to approve it. The phone's notifications (push, ntfy, desktop) and the daily digest
// both word their asks with these, so the manager can decide from the alert alone. Pure.
import { HOLD_LABEL } from '../shared/issues.ts';
import { NOT_ROUTINE } from '../shared/holds.ts';

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

/** The office's pick for a stuck PR, from why it got stuck (swarm.ts stuck()). */
export function stuckPrPick(stuckWhy: string | null): { pick: string | null; why: string } {
  const w = stuckWhy ?? '';
  if (/desk couldn't be set up|session got stuck|without a usable report/.test(w)) return { pick: 'retry QA', why: 'The sessions failed, not the code, so another QA run usually clears it.' };
  if (/fix sessions/.test(w)) return { pick: 'send it back with a note', why: 'The fix sessions failed, not the code, so another fix usually goes through.' };
  if (/conflicts with|fails its checks|failed QA/.test(w)) return { pick: 'send it back with a note', why: 'Agents tried several times; a line from you on what to change usually unsticks it.' };
  return { pick: null, why: "The office can't tell what went wrong; the QA report has the details." };
}

/** A PR the office can't move on its own (needs-human). */
export function stuckPrDecision(floor: string, pr: Pr, stuckWhy: string | null): Decision {
  const { pick, why } = stuckPrPick(stuckWhy);
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
