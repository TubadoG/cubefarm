import { describe, expect, it } from 'vitest';
import { decisionLines, decisionNote, heldWhy, orList, readyDecision, stuckPrDecision, stuckPrPick } from './decision.ts';

const pr = { number: 12, title: 'Add visit schedule', url: 'https://github.com/o/rtsm/pull/12' };

describe('heldWhy', () => {
  it('words each kind of hold', () => {
    expect(heldWhy('label swarm:hold')).toBe('it has the swarm:hold label');
    expect(heldWhy('not routine: it changes dependencies (package.json)')).toBe("it isn't routine: it changes dependencies (package.json)");
    expect(heldWhy('server/payments/x.ts')).toBe('it changes server/payments/x.ts, which is on your hold list');
  });
});

describe('readyDecision', () => {
  it('asks to merge, recommends it and says why it waits', () => {
    const d = readyDecision('rtsm', pr, 'not routine: it changes dependencies (package.json)');
    expect(d.question).toBe('Merge PR #12 on rtsm?');
    expect(d.pick).toBe('merge it');
    expect(decisionLines(d)).toEqual([
      'Add visit schedule.',
      'Options: merge it, send it back with a note or close it.',
      "Recommended: merge it. QA passed, and it waits for you only because it isn't routine: it changes dependencies (package.json).",
      'To approve, open Approvals and tap Merge.',
    ]);
  });

  it('says auto-merge is off when nothing holds it', () => {
    expect(readyDecision('rtsm', pr, null).why).toBe('QA passed; auto-merge is off on this floor.');
  });
});

describe('stuckPrPick', () => {
  it('retries when sessions failed, not the code', () => {
    expect(stuckPrPick("its desk couldn't be set up").pick).toBe('retry QA');
    expect(stuckPrPick('QA ended without a usable report 3 times in a row').pick).toBe('retry QA');
    expect(stuckPrPick("Kim's session got stuck on it twice").pick).toBe('retry QA');
  });

  it('sends it back when fixes keep failing', () => {
    expect(stuckPrPick('2 fix sessions in a row failed').pick).toBe('send it back with a note');
    expect(stuckPrPick('it still conflicts with main after 5 fixes').pick).toBe('send it back with a note');
    expect(stuckPrPick('it failed QA 3 times, the most QA rounds a PR gets (3)').pick).toBe('send it back with a note');
  });

  it('makes no pick when it can’t tell', () => {
    expect(stuckPrPick(null)).toEqual({ pick: null, why: "The office can't tell what went wrong; the QA report has the details." });
  });
});

describe('stuckPrDecision and decisionNote', () => {
  it('reads as one plain paragraph with the pick and the button to tap', () => {
    const n = decisionNote(stuckPrDecision('rtsm', pr, 'it still fails its checks after 5 fixes'));
    expect(n.title).toBe('PR #12 on rtsm is stuck: it still fails its checks after 5 fixes. What next?');
    expect(n.body).toBe(
      'Add visit schedule. Options: retry QA, send it back with a note, merge it anyway or close it. Recommended: send it back with a note. Agents tried several times; a line from you on what to change usually unsticks it. To approve, open Approvals and tap Send back.',
    );
    expect(n.line).toBe(`${n.title} Recommended: send it back with a note.`);
  });

  it('asks the manager to choose when there is no pick', () => {
    const lines = decisionLines(stuckPrDecision('rtsm', pr, null));
    expect(lines[2]).toMatch(/^No recommendation\./);
    expect(lines[3]).toBe('Open Approvals to choose.');
  });
});

describe('orList', () => {
  it('joins with commas and or', () => {
    expect(orList(['a'])).toBe('a');
    expect(orList(['a', 'b', 'c'])).toBe('a, b or c');
  });
});
