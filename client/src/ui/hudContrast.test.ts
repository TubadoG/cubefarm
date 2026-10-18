import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToRgb, rgbToHex } from './colorMath';

// The HUD floats over the 3D view, whose colours change with the room and the time of day, so its text never sits on
// the view itself: each piece has its own backing. These are the pairs styles.css uses (kept in step by hand), checked
// against WCAG AA: 4.5:1 for text, 3:1 for large text.
const INK = '#26394D';
const PAPER = '#FFFFFF';
const PAGE = '#EEF3F8';
const MUTED = '#436688';
const MUTED_HIGH_CONTRAST = '#3D454D';
/** styles.css captions: rgba(27, 39, 50, var(--caption-bg)), 0.75 by default (a11yPrefs.ts). */
const CAPTION_BG = '#1B2732';
const CAPTION_ALPHA = 0.75;
/** The floors' colours, kept in step with server/swarm.ts FLOOR_COLORS. */
const FLOOR_COLORS = ['#6699CC', '#5FA8A0', '#8C9FD9', '#7FB7D9', '#9C8FC4', '#86B39A', '#AABFD5', '#B4A7D6'];
const ON_ACCENT = '#1B2732';

/** A translucent colour over a background, as the eye sees it. */
function over(rgb: string, alpha: number, bg: string) {
  const [a, b] = [hexToRgb(rgb), hexToRgb(bg)];
  return rgbToHex([0, 1, 2].map((i) => a[i] * alpha + b[i] * (1 - alpha)) as [number, number, number]);
}

describe('HUD text against what is behind it', () => {
  it('reads on the paper cards and the page (floor card, workers list, hints, phone button, panel bodies)', () => {
    expect(contrastRatio(INK, PAPER)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(INK, PAGE)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(MUTED, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(MUTED, PAGE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(MUTED_HIGH_CONTRAST, '#ffffff')).toBeGreaterThanOrEqual(7);
  });

  it('reads on the key hints: an opaque card, so the 3D view behind them does not matter', () => {
    expect(contrastRatio(INK, PAPER)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps captions readable at the default background, over any view', () => {
    for (const view of ['#000000', '#ffffff', '#E2C26E', '#CFE0F0']) expect(contrastRatio('#ffffff', over(CAPTION_BG, CAPTION_ALPHA, view))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#EDD596', over(CAPTION_BG, CAPTION_ALPHA, '#ffffff'))).toBeGreaterThanOrEqual(4.5); // .caption-alarm
    expect(contrastRatio('#C5D8EC', over(CAPTION_BG, CAPTION_ALPHA, '#ffffff'))).toBeGreaterThanOrEqual(4.5); // .caption-speech b
  });

  it('keeps text on the accent readable on every floor colour', () => {
    for (const c of FLOOR_COLORS) expect(contrastRatio(ON_ACCENT, c)).toBeGreaterThanOrEqual(4.5); // .floor-num, .floor-badge, avatars
    expect(contrastRatio('#ffffff', '#6699CC')).toBeLessThan(3.5); // why text on the accent is dark, not white
  });

  it('keeps the signal inks readable on their surfaces', () => {
    expect(contrastRatio('#3D6B54', '#E4F1EA')).toBeGreaterThanOrEqual(4.5); // --good-ink on --good-surface
    expect(contrastRatio('#7A5F22', '#F5EDD8')).toBeGreaterThanOrEqual(4.5); // --warn-ink on --warn-surface
    expect(contrastRatio('#8C3A34', '#F5DEDC')).toBeGreaterThanOrEqual(4.5); // --bad-ink on --bad-surface
  });

  it('keeps the primary button and the dark surfaces readable', () => {
    expect(contrastRatio('#ffffff', '#26394D')).toBeGreaterThanOrEqual(7); // .btn-big, .btn-good, outgoing bubbles
    expect(contrastRatio('#EAF0F6', '#26394D')).toBeGreaterThanOrEqual(7); // --text-on-dark
    expect(contrastRatio('#AABFD5', '#26394D')).toBeGreaterThanOrEqual(4.5); // phone and pocket tab bars, inactive
  });
});
