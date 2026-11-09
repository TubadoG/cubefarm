import { describe, expect, it } from 'vitest';
import {
  boardView,
  isDigestMonday,
  changeSummary,
  KEEP_BOARD_DAYS,
  lastWeek,
  newOrder,
  orderRank,
  pruneBoardLog,
  undoLink,
  undoSteps,
  undoSummary,
  withMergeNote,
  withoutMergeNote,
  type BoardChange,
  type BoardEntry,
} from './boardLog.ts';

const DAY = 24 * 60 * 60_000;
const entry = (at: number, change: BoardChange, id = `e${at}`): BoardEntry => ({ id, repoId: 'acme/app', at, by: 'Quinn', change, undoneAt: null, undoError: null });

describe('undo, for each kind of board change', () => {
  it('reopens a closed issue', () => {
    expect(undoSteps({ kind: 'close', issue: 7, title: 'Old idea', note: 'Superseded by #9.' })).toEqual([{ do: 'reopen', issue: 7, comment: expect.stringContaining('the floor lead closed this issue') }]);
  });

  it('unmerges: reopens the duplicate and removes the note from the issue kept', () => {
    expect(undoSteps({ kind: 'merge', keep: 3, duplicate: 8, title: 'Dark mode too', note: 'Same ask.' })).toEqual([
      { do: 'reopen', issue: 8, comment: expect.stringContaining('merged this into #3') },
      { do: 'drop-merge-note', issue: 3, duplicate: 8 },
    ]);
  });

  it('relabels back: removes what was added, adds what was removed', () => {
    expect(undoSteps({ kind: 'relabel', issue: 4, added: ['bug'], removed: ['enhancement', 'ui'] })).toEqual([{ do: 'labels', issue: 4, add: ['enhancement', 'ui'], remove: ['bug'] }]);
  });

  it('restores the order', () => {
    expect(undoSteps({ kind: 'reorder', before: [5, 2], after: [9, 5, 2] })).toEqual([{ do: 'order', order: [5, 2] }]);
  });

  it('closes the split-off issues, then reopens the original', () => {
    expect(undoSteps({ kind: 'split', issue: 10, title: 'Big thing', parts: [21, 22] })).toEqual([
      { do: 'close', issue: 21, comment: expect.stringContaining('split #10 into this') },
      { do: 'close', issue: 22, comment: expect.stringContaining('split #10 into this') },
      { do: 'reopen', issue: 10, comment: expect.stringContaining('#21, #22') },
    ]);
  });

  it('sets dependencies back', () => {
    expect(undoSteps({ kind: 'depends', issue: 6, before: [2], after: [2, 4] })).toEqual([{ do: 'depends', issue: 6, deps: [2] }]);
  });

  it('holds a released issue again', () => {
    expect(undoSteps({ kind: 'release', issue: 6, was: 'held', pr: 40 })).toEqual([{ do: 'hold', issue: 6, was: 'held', pr: 40 }]);
  });

  it('marks every undo comment as the office’s', () => {
    for (const c of [undoSteps({ kind: 'close', issue: 1, title: '', note: '' })[0], undoSteps({ kind: 'split', issue: 1, title: '', parts: [2] })[0]]) {
      expect((c as { comment: string }).comment).toContain('<!-- cubefarm -->');
    }
  });
});

describe('the merge note', () => {
  const body = 'Add a dark theme.\n\nAcceptance: toggles in settings.';
  it('is added to the kept issue and removed again without touching the rest', () => {
    const merged = withMergeNote(body, { number: 8, title: 'Night mode' }, 'Also asks for a schedule.');
    expect(merged).toContain('**Also covers #8** ("Night mode")');
    expect(merged.startsWith(body)).toBe(true);
    expect(withoutMergeNote(merged, 8)).toBe(body);
  });
  it('keeps the notes of other duplicates', () => {
    const two = withMergeNote(withMergeNote(body, { number: 8, title: 'A' }, 'x'), { number: 9, title: 'B' }, 'y');
    const one = withoutMergeNote(two, 8);
    expect(one).not.toContain('#8');
    expect(one).toContain('**Also covers #9**');
    expect(withoutMergeNote(one, 9)).toBe(body);
  });
  it('leaves a body without the note alone', () => {
    expect(withoutMergeNote(body, 8)).toBe(body);
  });
});

describe('the backlog order', () => {
  const open = new Set([1, 2, 3, 4]);
  it('puts the named issues first, the rest after in their old order', () => {
    expect(newOrder([2, 3], [4, 1], open)).toEqual([4, 1, 2, 3]);
    expect(newOrder([2, 9, 3], [3], open)).toEqual([3, 2]); // a closed one drops out
  });
  it('refuses an issue that is not open, or a repeat', () => {
    expect(() => newOrder([], [5], open)).toThrow(/#5 isn't an open issue/);
    expect(() => newOrder([], [1, 1], open)).toThrow(/twice/);
  });
  it('ranks unordered issues after the ordered ones', () => {
    expect(orderRank([4, 1], 1)).toBe(1);
    expect(orderRank([4, 1], 3)).toBe(2);
  });
});

describe('the log', () => {
  const now = 100 * DAY;
  it('keeps a month, and lists the last week newest first', () => {
    const log = [entry(now - (KEEP_BOARD_DAYS + 1) * DAY, { kind: 'reorder', before: [], after: [1] }), entry(now - 8 * DAY, { kind: 'reorder', before: [], after: [2] }), entry(now - DAY, { kind: 'reorder', before: [], after: [3] }), entry(now - 2 * DAY, { kind: 'reorder', before: [], after: [4] })];
    expect(pruneBoardLog(log, now)).toHaveLength(3);
    expect(lastWeek(log, now).map((e) => e.at)).toEqual([now - DAY, now - 2 * DAY]);
  });
  it('says what each change did and what its undo does', () => {
    expect(changeSummary({ kind: 'merge', keep: 3, duplicate: 8, title: 'Night mode', note: 'Same ask.' })).toBe('Merged duplicate #8 "Night mode" into #3: Same ask.');
    expect(undoSummary({ kind: 'merge', keep: 3, duplicate: 8, title: '', note: '' })).toBe('Reopen #8 and remove the note on #3');
    expect(changeSummary({ kind: 'relabel', issue: 4, added: ['bug'], removed: ['ui'] })).toBe('Relabelled #4: added bug; removed ui');
    expect(undoSummary({ kind: 'split', issue: 10, title: '', parts: [21, 22] })).toBe('Close #21, #22 and reopen #10');
    expect(boardView(entry(5, { kind: 'close', issue: 7, title: 'Old', note: 'Stale.' }, 'abc'), 2)).toMatchObject({ id: 'abc', floor: 2, kind: 'close', summary: 'Closed #7 "Old": Stale.', undo: 'Reopen #7', undoneAt: null });
  });
  it('goes in the digest on Mondays only', () => {
    expect(isDigestMonday(new Date(2026, 10, 9, 8))).toBe(true); // Monday 9 Nov 2026
    expect(isDigestMonday(new Date(2026, 10, 10, 8))).toBe(false);
  });
  it('links each change to its line in the Decision room', () => {
    expect(undoLink('https://office.example.com', 'abc')).toBe('https://office.example.com/decisions#board-abc');
    expect(undoLink('https://example.com/office?x=1', 'abc')).toBe('https://example.com/office/decisions#board-abc');
  });
});
