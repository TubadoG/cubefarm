// How a status looks everywhere it shows (status pills, Kanban cards, the whiteboard, name tags, chips, toasts): one
// of six kinds, each with its own shape or icon, and colours from the chosen palette. The standard palette is the
// office's own colours; the colour-blind ones are tuned (and tested) to stay apart for deuteranopia, protanopia and
// tritanopia. Pure: the DOM side (CSS variables) is a11y.ts, the canvas side passes a StatusLook to draw.ts.

import type { AgentStatus, PreviewStatus, QaStatus } from '../../../shared/types';
import type { CardTone } from '../qaCard';

export const PALETTES = ['standard', 'deuteranopia', 'protanopia', 'tritanopia'] as const;
export type Palette = (typeof PALETTES)[number];

export const PALETTE_LABELS: Record<Palette, string> = {
  standard: 'Standard',
  deuteranopia: 'Deuteranopia (green-weak)',
  protanopia: 'Protanopia (red-weak)',
  tritanopia: 'Tritanopia (blue-yellow)',
};

export const STATUS_KINDS = ['idle', 'waiting', 'busy', 'ok', 'attention', 'bad'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

/** The shape each kind carries, so colour is never the only cue. */
export const KIND_ICON: Record<StatusKind, string> = { idle: '○', waiting: '⏳', busy: '▶', ok: '✓', attention: '!', bad: '✕' };

/** Words for screen readers and tooltips. */
export const KIND_WORD: Record<StatusKind, string> = { idle: 'idle', waiting: 'waiting', busy: 'busy', ok: 'done', attention: 'needs attention', bad: 'failed' };

export type StatusName = AgentStatus | PreviewStatus | QaStatus;

export const STATUS_KIND: Record<StatusName, StatusKind> = {
  idle: 'idle',
  unconfigured: 'idle',
  stopped: 'idle',
  preparing: 'waiting',
  installing: 'waiting',
  starting: 'waiting',
  queued: 'waiting',
  working: 'busy',
  testing: 'busy',
  fixing: 'busy',
  done: 'ok',
  running: 'ok',
  passed: 'ok',
  'needs-human': 'attention',
  error: 'bad',
  failed: 'bad',
};

export const TONE_KIND: Record<CardTone, StatusKind> = { good: 'ok', warn: 'attention', bad: 'bad' };

export interface KindColors {
  /** Backgrounds with dark text on them: status pills, cards, whiteboard notes. */
  fill: string;
  /** Dots, badges, borders and coloured text. */
  strong: string;
}

// The colour-blind palettes: kinds told apart by hue along the axis that still works, and by lightness.
const RED_GREEN: Record<StatusKind, KindColors> = {
  idle: { fill: '#d9d9d9', strong: '#8c8c8c' },
  waiting: { fill: '#f3e3a1', strong: '#c49a6c' },
  busy: { fill: '#a9d4f5', strong: '#56b4e9' },
  ok: { fill: '#6aa7e0', strong: '#0060b0' },
  attention: { fill: '#ffd94a', strong: '#f0c800' },
  bad: { fill: '#e89a5c', strong: '#a34400' },
};

export const CVD_PALETTES: Record<Exclude<Palette, 'standard'>, Record<StatusKind, KindColors>> = {
  deuteranopia: RED_GREEN,
  // Reds look darker without red cones: a lighter orange keeps "bad" from sinking towards "ok".
  protanopia: { ...RED_GREEN, bad: { fill: '#f0a070', strong: '#b84a00' } },
  tritanopia: {
    idle: { fill: '#d9d9d9', strong: '#8c8c8c' },
    waiting: { fill: '#ffd3a8', strong: '#9a5a20' },
    busy: { fill: '#8fd6d6', strong: '#008c8c' },
    ok: { fill: '#2fa58a', strong: '#004d3c' },
    attention: { fill: '#ff9ec8', strong: '#e0408a' },
    bad: { fill: '#ff7a6e', strong: '#c4161c' },
  },
};

// The standard palette: exactly the colours the office has always used.
const STANDARD_FILL: Record<StatusName, string> = {
  idle: '#DCE3EA',
  unconfigured: '#DCE3EA',
  stopped: '#CDD6E0',
  preparing: '#F5EDD8',
  installing: '#F5EDD8',
  starting: '#F5EDD8',
  queued: '#F5EDD8',
  working: '#DDE8F4',
  testing: '#DDE8F4',
  fixing: '#DDE8F4',
  done: '#E4F1EA',
  running: '#E4F1EA',
  passed: '#E4F1EA',
  'needs-human': '#F5DEDC',
  error: '#F5DEDC',
  failed: '#F5DEDC',
};
// attention is the crit ink, matching its crit fill and standing apart from waiting's amber; shapes (⏳ and !) carry the meaning.
const STANDARD_STRONG: Record<StatusKind, string> = { idle: '#8A96A3', waiting: '#C9A24B', busy: '#6699CC', ok: '#4C9A76', attention: '#8C3A34', bad: '#C25B54' };
/** Kanban card backgrounds in the panel, and sticky colours on the 3D whiteboard (a step stronger: they sit on a white board). */
const STANDARD_TONE: Record<'card' | 'board', Record<CardTone, string>> = {
  card: { warn: '#F5EDD8', bad: '#F5DEDC', good: '#E4F1EA' },
  board: { warn: '#EBDDB8', bad: '#EDCBC8', good: '#CFE6DA' },
};

/** A status's background colour. */
export function statusFill(status: StatusName, palette: Palette): string {
  return palette === 'standard' ? STANDARD_FILL[status] : CVD_PALETTES[palette][STATUS_KIND[status]].fill;
}

/** A kind's strong colour (dots, badges, borders). */
export function kindStrong(kind: StatusKind, palette: Palette): string {
  return palette === 'standard' ? STANDARD_STRONG[kind] : CVD_PALETTES[palette][kind].strong;
}

/** A Kanban card's tone colour, on the panel's cards or the whiteboard's stickies. */
export function toneFill(tone: CardTone, palette: Palette, surface: 'card' | 'board'): string {
  return palette === 'standard' ? STANDARD_TONE[surface][tone] : CVD_PALETTES[palette][TONE_KIND[tone]].fill;
}

/** What the canvases (whiteboard, name tags) need to know: the palette, and whether to draw shapes beside colours. */
export interface StatusLook {
  palette: Palette;
  shapes: boolean;
}

export const STANDARD_LOOK: StatusLook = { palette: 'standard', shapes: false };

/**
 * The CSS custom properties for a palette: one --st-<status> per status, --tone-<tone> for Kanban cards, --kind-<kind>
 * for status dots, and the office's --good / --bad / --warn. Empty for the standard palette, so the stylesheet's own
 * colours apply untouched.
 */
export function paletteVars(palette: Palette): Record<string, string> {
  if (palette === 'standard') return {};
  const vars: Record<string, string> = {};
  for (const s of Object.keys(STATUS_KIND) as StatusName[]) vars[`--st-${s}`] = statusFill(s, palette);
  for (const t of Object.keys(TONE_KIND) as CardTone[]) vars[`--tone-${t}`] = toneFill(t, palette, 'card');
  for (const k of STATUS_KINDS) vars[`--kind-${k}`] = kindStrong(k, palette);
  vars['--good'] = kindStrong('ok', palette);
  vars['--bad'] = kindStrong('bad', palette);
  vars['--warn'] = kindStrong('attention', palette);
  return vars;
}

/** Every custom property paletteVars can set, so switching back to standard clears them all. */
export const PALETTE_VAR_NAMES = Object.keys(paletteVars('deuteranopia'));
