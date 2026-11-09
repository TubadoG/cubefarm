// The board-change log (docs/floor-lead.md): every change a floor lead makes to the board (closing a stale issue,
// merging a duplicate, relabelling, reordering, splitting, rewriting dependencies, putting a held issue back in line)
// is recorded with what it takes to undo it. The manager scans last week's in the Monday digest and undoes any of them
// in one tap in the Decision room; no approval is needed up front. Pure: the records, their undo steps and their words;
// swarm.ts makes the GitHub calls.
import { OFFICE_MARK } from '../shared/brief.ts';
import { DECISIONS_PATH } from '../shared/decisions.ts';
import type { BoardChangeView } from '../shared/types.ts';

/** How long changes stay in the log; the digest and the Decision room show the last week's. */
export const KEEP_BOARD_DAYS = 30;
export const BOARD_WEEK_MS = 7 * 24 * 60 * 60_000;

/** What a change did, with what its undo needs. */
export type BoardChange =
  | { kind: 'close'; issue: number; title: string; note: string } // a stale or superseded issue closed as not planned
  | { kind: 'merge'; keep: number; duplicate: number; title: string; note: string } // the duplicate closed, a note on the one kept
  | { kind: 'relabel'; issue: number; added: string[]; removed: string[] }
  | { kind: 'reorder'; before: number[]; after: number[] } // the floor's backlog order (issue numbers, first = next)
  | { kind: 'split'; issue: number; title: string; parts: number[] } // the original closed, its parts filed
  | { kind: 'depends'; issue: number; before: number[]; after: number[] }
  | { kind: 'release'; issue: number; was: 'held' | 'failing'; pr: number | null }; // back in auto-assign's line

export interface BoardEntry {
  id: string;
  repoId: string;
  at: number;
  by: string; // the lead's name
  change: BoardChange;
  undoneAt: number | null;
  undoError: string | null; // the last undo GitHub refused
}

/** One step of an undo, in order. */
export type UndoStep =
  | { do: 'reopen'; issue: number; comment: string }
  | { do: 'close'; issue: number; comment: string }
  | { do: 'drop-merge-note'; issue: number; duplicate: number }
  | { do: 'labels'; issue: number; add: string[]; remove: string[] }
  | { do: 'order'; order: number[] }
  | { do: 'depends'; issue: number; deps: number[] }
  | { do: 'hold'; issue: number; was: 'held' | 'failing'; pr: number | null };

const undone = (what: string) => `Undone by the manager from the office's board log: ${what}.\n${OFFICE_MARK}`;

/** How to undo a change. */
export function undoSteps(c: BoardChange): UndoStep[] {
  switch (c.kind) {
    case 'close':
      return [{ do: 'reopen', issue: c.issue, comment: undone('the floor lead closed this issue') }];
    case 'merge':
      return [
        { do: 'reopen', issue: c.duplicate, comment: undone(`the floor lead merged this into #${c.keep}`) },
        { do: 'drop-merge-note', issue: c.keep, duplicate: c.duplicate },
      ];
    case 'relabel':
      return [{ do: 'labels', issue: c.issue, add: c.removed, remove: c.added }];
    case 'reorder':
      return [{ do: 'order', order: c.before }];
    case 'split':
      return [
        ...c.parts.map((n) => ({ do: 'close' as const, issue: n, comment: undone(`the floor lead split #${c.issue} into this`) })),
        { do: 'reopen', issue: c.issue, comment: undone(`the floor lead split this into ${c.parts.map((n) => `#${n}`).join(', ')}`) },
      ];
    case 'depends':
      return [{ do: 'depends', issue: c.issue, deps: c.before }];
    case 'release':
      return [{ do: 'hold', issue: c.issue, was: c.was, pr: c.pr }];
  }
}

const list = (ns: number[]) => (ns.length ? ns.map((n) => `#${n}`).join(', ') : 'none');

/** The change in a line, for the digest and the Decision room. */
export function changeSummary(c: BoardChange): string {
  switch (c.kind) {
    case 'close':
      return `Closed #${c.issue} "${c.title}": ${c.note}`;
    case 'merge':
      return `Merged duplicate #${c.duplicate} "${c.title}" into #${c.keep}: ${c.note}`;
    case 'relabel':
      return `Relabelled #${c.issue}:${c.added.length ? ` added ${c.added.join(', ')}` : ''}${c.added.length && c.removed.length ? ';' : ''}${c.removed.length ? ` removed ${c.removed.join(', ')}` : ''}`;
    case 'reorder':
      return `Reordered the backlog: ${list(c.after.slice(0, 8))}${c.after.length > 8 ? ', …' : ''} first`;
    case 'split':
      return `Split #${c.issue} "${c.title}" into ${list(c.parts)}`;
    case 'depends':
      return `Set #${c.issue}'s dependencies to ${list(c.after)} (was ${list(c.before)})`;
    case 'release':
      return `Put #${c.issue} back in line${c.was === 'held' ? ` (its PR #${c.pr ?? '?'} was closed)` : ' (it had failed sessions)'}`;
  }
}

/** What an undo does, for its button and the confirmation. */
export function undoSummary(c: BoardChange): string {
  switch (c.kind) {
    case 'close':
      return `Reopen #${c.issue}`;
    case 'merge':
      return `Reopen #${c.duplicate} and remove the note on #${c.keep}`;
    case 'relabel':
      return `Put #${c.issue}'s labels back`;
    case 'reorder':
      return 'Restore the backlog order';
    case 'split':
      return `Close ${list(c.parts)} and reopen #${c.issue}`;
    case 'depends':
      return `Set #${c.issue}'s dependencies back to ${list(c.before)}`;
    case 'release':
      return `Hold #${c.issue} for you again`;
  }
}

// ---------- the merge note ----------

const noteStart = (dup: number) => `<!-- cubefarm:merged #${dup} -->`;
const noteEnd = (dup: number) => `<!-- /cubefarm:merged #${dup} -->`;

/** The kept issue's body with a note on the duplicate merged into it: its title, and what the lead says it adds. */
export function withMergeNote(body: string, dup: { number: number; title: string }, note: string): string {
  const block = [noteStart(dup.number), `**Also covers #${dup.number}** ("${dup.title}"), merged in as a duplicate: ${note.trim()}`, noteEnd(dup.number)].join('\n');
  return `${withoutMergeNote(body, dup.number).trimEnd()}\n\n${block}`;
}

/** The kept issue's body without the note for duplicate `dup`; the rest is left as it was. */
export function withoutMergeNote(body: string, dup: number): string {
  const start = body.indexOf(noteStart(dup));
  if (start < 0) return body;
  const endAt = body.indexOf(noteEnd(dup), start);
  const end = endAt < 0 ? body.length : endAt + noteEnd(dup).length;
  return `${body.slice(0, start).trimEnd()}${body.slice(end).replace(/^\s*\n/, '\n')}`.trimEnd();
}

// ---------- the log ----------

/** The log without entries older than KEEP_BOARD_DAYS. */
export const pruneBoardLog = (log: readonly BoardEntry[], now: number) => log.filter((e) => now - e.at < KEEP_BOARD_DAYS * 24 * 60 * 60_000);

/** The changes of the week before `now`, newest first. */
export const lastWeek = (log: readonly BoardEntry[], now: number) => log.filter((e) => now - e.at < BOARD_WEEK_MS && e.at <= now).sort((a, b) => b.at - a.at);

/** Where an entry's undo is, on the office's public address: its line in the Decision room. */
export function undoLink(officeUrl: string, id: string): string {
  const base = new URL(officeUrl);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const u = new URL(DECISIONS_PATH.slice(1), base);
  u.hash = `board-${id}`;
  return u.toString();
}

/** An entry as tabs see it. */
export function boardView(e: BoardEntry, floor: number): BoardChangeView {
  return { id: e.id, repoId: e.repoId, floor, at: e.at, by: e.by, kind: e.change.kind, summary: changeSummary(e.change), undo: undoSummary(e.change), undoneAt: e.undoneAt, undoError: e.undoError };
}

/** The Monday digest goes out on Mondays (local time): it carries last week's board changes. */
export const isDigestMonday = (now: Date) => now.getDay() === 1;

/** The backlog order with an issue's place: its index in the lead's order, or after every ordered one. */
export function orderRank(order: readonly number[], n: number): number {
  const i = order.indexOf(n);
  return i < 0 ? order.length : i;
}

/**
 * reorder_backlog's new order: the issues named first, in that order, then the rest of the old order. Throws a message
 * the lead can act on for an issue that isn't open, or a repeat.
 */
export function newOrder(before: readonly number[], first: readonly number[], open: ReadonlySet<number>): number[] {
  const seen = new Set<number>();
  for (const n of first) {
    if (!open.has(n)) throw new Error(`#${n} isn't an open issue on this floor.`);
    if (seen.has(n)) throw new Error(`#${n} is in the order twice.`);
    seen.add(n);
  }
  return [...first, ...before.filter((n) => !seen.has(n) && open.has(n))];
}
