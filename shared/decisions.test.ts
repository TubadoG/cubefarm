import { describe, expect, it } from 'vitest';
import { countdown, decisionHash, decisionKeyOf, decisionLink, isDecisionsPath, parseDecisionChoice, parseDecisionHash } from './decisions.ts';

const H = 3_600_000;

describe('deep links', () => {
  it('point at a card on the office address, and read back', () => {
    const url = decisionLink('https://office.example.com/', 'acme/open-rtsm', 30);
    expect(url).toBe('https://office.example.com/decisions#acme/open-rtsm/30');
    const u = new URL(url);
    expect(isDecisionsPath(u.pathname)).toBe(true);
    expect(parseDecisionHash(u.hash)).toEqual({ repoId: 'acme/open-rtsm', number: 30 });
  });

  it('ignore the office address path and survive URL-encoding', () => {
    expect(decisionLink('https://office.example.com/some/where?x=1', 'o/r', 2)).toBe('https://office.example.com/decisions#o/r/2');
    expect(parseDecisionHash('#o%2Fr%2F12')).toEqual({ repoId: 'o/r', number: 12 });
    expect(decisionHash('o/r', 7)).toBe('o/r/7');
    expect(decisionKeyOf('o/r', 7)).toBe('o/r#7');
  });

  it('refuse anything that is not owner/repo/number', () => {
    for (const bad of ['', '#', '#o/r', '#o/r/x', '#o/r/1/2', '#%E0%A4%A', null, undefined]) expect(parseDecisionHash(bad)).toBeNull();
    expect(isDecisionsPath('/decisions/')).toBe(true);
    expect(isDecisionsPath('/')).toBe(false);
    expect(isDecisionsPath('/decisions/x')).toBe(false);
  });
});

describe('countdown', () => {
  const now = Date.parse('2026-11-09T08:00:00Z');
  it('says the time left, and flags the last 24 hours', () => {
    expect(countdown(now + 47 * H + 30 * 60_000, now)).toEqual({ label: '1 d 23 h left', due: false, overdue: false });
    expect(countdown(now + 5 * H + 10 * 60_000, now)).toEqual({ label: '5 h 10 min left', due: true, overdue: false });
    expect(countdown(now + 59_000, now)).toEqual({ label: '1 min left', due: true, overdue: false });
    expect(countdown(now - 1, now)?.overdue).toBe(true);
    expect(countdown(null, now)).toBeNull();
  });
});

describe('parseDecisionChoice', () => {
  it('reads each choice', () => {
    expect(parseDecisionChoice({ choice: 'approve' })).toEqual({ choice: 'approve' });
    expect(parseDecisionChoice({ choice: 'option', option: '2' })).toEqual({ choice: 'option', option: 2 });
    expect(parseDecisionChoice({ choice: 'send-back', note: '  Use MIT. ' })).toEqual({ choice: 'send-back', note: 'Use MIT.' });
    expect(parseDecisionChoice({ choice: 'close' })).toEqual({ choice: 'close' });
    expect(parseDecisionChoice({ choice: 'close', note: 'Not now' })).toEqual({ choice: 'close', note: 'Not now' });
  });

  it('refuses what a card cannot send', () => {
    expect(() => parseDecisionChoice({ choice: 'option', option: 0 })).toThrow(/option/);
    expect(() => parseDecisionChoice({ choice: 'send-back', note: ' ' })).toThrow(/note/);
    expect(() => parseDecisionChoice({ choice: 'send-back', note: 'x'.repeat(1001) })).toThrow(/too long/);
    expect(() => parseDecisionChoice({ choice: 'merge' })).toThrow(/choice must be/);
    expect(() => parseDecisionChoice(null)).toThrow(/choice must be/);
  });
});
