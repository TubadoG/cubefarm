import { describe, expect, it } from 'vitest';
import { stuckButtons, stuckPickLine } from './stuckActions';

describe('stuckButtons', () => {
  it('puts the office pick first and highlights only it', () => {
    const b = stuckButtons({ action: 'send-back', why: 'x' });
    expect(b[0]).toEqual({ action: 'send-back', primary: true });
    expect(b.filter((x) => x.primary)).toHaveLength(1);
    expect(b.map((x) => x.action).sort()).toEqual(['close', 'merge', 'retry-qa', 'send-back']);
  });

  it('highlights Retry QA only when it is the pick', () => {
    expect(stuckButtons({ action: 'retry-qa', why: 'x' })[0]).toEqual({ action: 'retry-qa', primary: true });
    expect(stuckButtons({ action: 'close', why: 'x' }).find((x) => x.action === 'retry-qa')?.primary).toBe(false);
  });

  it('highlights nothing without a pick, and never defaults to Retry QA', () => {
    for (const pick of [null, undefined, { action: null, why: 'unknown' }]) {
      const b = stuckButtons(pick);
      expect(b.some((x) => x.primary)).toBe(false);
      expect(b[0].action).not.toBe('retry-qa');
    }
  });
});

describe('stuckPickLine', () => {
  it('says what is recommended and why', () => {
    expect(stuckPickLine({ action: 'close', why: 'It was rebuilt once.' })).toBe('Recommended: Close. It was rebuilt once.');
    expect(stuckPickLine({ action: null, why: "The office can't tell." })).toBe("The office can't tell.");
    expect(stuckPickLine(null)).toBeNull();
  });
});
