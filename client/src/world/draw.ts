import type { LogLine, PreviewStatus, PreviewView, RepoView } from '../../../shared/types';
import type { Agent, KanbanCard, KanbanColumns } from '../store';
import { testingLabel } from '../qaCard';
import { officeNow } from '../officeTime';
import { chipRects } from '../ui/channels';
import { inkOn } from '../ui/colorMath';
import { KIND_ICON, kindStrong, STANDARD_LOOK, STATUS_KIND, TONE_KIND, toneFill, type StatusKind, type StatusLook } from '../ui/statusLook';
import { statsChips, type BoardStats } from './boardStats';
import type { Pair } from './whiteboard';

// 2D canvas painters for everything in the office that shows text: laptop terminals,
// the Kanban whiteboard, signs and name tags.

export const MONO = '"JetBrains Mono", Consolas, "Cascadia Mono", monospace';
/** Signs, tags, titles, scoreboards: Komet (400/700 only). */
export const SANS = '"komet", Mulish, "Segoe UI", system-ui, sans-serif';
/** Small multi-line text: note bodies, speech bubbles, browser copy, plaques' small print. */
export const BODY = 'Mulish, "Segoe UI", system-ui, sans-serif';

/** Light signs, tags and notes: opaque white, navy ink, the floor's or agent's colour as a stripe. */
export const PAPER_SIGN = { bg: '#FFFFFF', ink: '#26394D', sub: '#436688', hairline: '#E0E8F1', outline: '#AABFD5' } as const;

/** Dark screens (terminals, the app monitor, mission control); the signal tints are the on-dark ok/warn/crit. */
export const SCREEN = {
  bg: '#1B2732',
  bar: '#26394D',
  grid: 'rgba(170,191,213,0.08)',
  line: '#3D5470',
  title: '#8FB5DD',
  text: '#EAF0F6',
  dim: '#8A96A3',
  good: '#7FC4A0',
  warn: '#E2C26E',
  bad: '#E07A72',
  idle: '#4D6680',
  ceo: '#B4A7D6',
} as const;

/** Inverse signs (MANAGER, CEO, the lobby's company sign, floor numbers): Deep Navy, white text. */
export const INVERSE_SIGN = { bg: '#26394D', text: '#FFFFFF', eyebrow: '#AABFD5' } as const;

/** Text on a floor or agent colour: N900 or white, whichever reads better. */
export const inkOnColor = (bg: string) => inkOn(bg, '#1B2732', '#FFFFFF');

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** `text` in at most `maxLines` lines no wider than `maxWidth`, the last one cut short with … if it all doesn't fit. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

// ---------- terminal ----------

// the same colours as LiveTerminal, so a desk's laptop matches the terminal panel
const TERM = {
  bg: '#1B2732',
  bar: '#26394D',
  text: '#EAF0F6',
  tool: '#8FB5DD',
  result: '#8A96A3',
  system: '#B4A7D6',
  error: '#E07A72',
  manager: '#E2C26E',
  done: '#7FC4A0',
  thinking: '#AABFD5',
};

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Crafting', 'Pondering', 'Tinkering', 'Brewing', 'Noodling', 'Scheming', 'Assembling', 'Percolating'];

export function toolVerb(tool: string | null): string {
  if (!tool) return '';
  if (tool.startsWith('mcp__playwright__')) return 'Browsing';
  if (tool === 'Bash' || tool === 'PowerShell') return 'Running';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return 'Editing';
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return 'Reading';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Researching';
  return tool;
}

export function drawTerminal(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  agent: Agent,
  lines: LogLine[],
  shot: HTMLImageElement | null,
  showBrowser: boolean,
  now: number,
  program: string, // the coding agent's command, e.g. claude or codex
) {
  ctx.fillStyle = TERM.bg;
  ctx.fillRect(0, 0, w, h);

  // title bar
  const barH = 30;
  ctx.fillStyle = TERM.bar;
  ctx.fillRect(0, 0, w, barH);
  ['#AABFD5', '#8A96A3', '#6B7580'].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(18 + i * 20, barH / 2, 6, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#AABFD5';
  ctx.font = `600 14px ${MONO}`;
  ctx.textBaseline = 'middle';
  const job =
    agent.status === 'idle'
      ? 'idle'
      : agent.role === 'ceo'
        ? (agent.issueTitle ?? 'running the company').toLowerCase()
        : agent.task === 'qa'
          ? `testing PR #${agent.prNumber}`
          : agent.task === 'fix'
            ? `fixing PR #${agent.prNumber}`
            : agent.issueNumber
              ? `issue #${agent.issueNumber}`
              : 'idle';
  const host = agent.role === 'ceo' ? 'hq' : 'swarm';
  const title = `${agent.name.toLowerCase()}@${host} — ${job} — ${program}`;
  ctx.fillText(title, 84, barH / 2 + 1);

  const termW = showBrowser ? Math.round(w * 0.56) : w;

  if (agent.status === 'idle' && lines.length <= 1) {
    drawScreensaver(ctx, 0, barH, w, h - barH, agent, now);
    return;
  }

  // log lines, newest at the bottom
  const fontSize = 14;
  const lh = 17;
  ctx.font = `${fontSize}px ${MONO}`;
  const charW = ctx.measureText('M').width;
  const cols = Math.max(10, Math.floor((termW - 20) / charW));
  const footer = agent.status === 'working' || agent.status === 'preparing' ? 28 : 8;
  const maxRows = Math.floor((h - barH - 10 - footer) / lh);

  const rows: { text: string; kind: LogLine['kind'] }[] = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < maxRows; i--) {
    const l = lines[i];
    const chunks: string[] = [];
    const text = l.text || ' ';
    for (let p = 0; p < text.length; p += cols) chunks.push(text.slice(p, p + cols));
    for (let c = chunks.length - 1; c >= 0 && rows.length < maxRows; c--) rows.unshift({ text: chunks[c], kind: l.kind });
  }

  let y = barH + 10 + lh / 2;
  for (const r of rows) {
    if (r.kind === 'tool' && r.text.startsWith('⏺')) {
      ctx.fillStyle = TERM.done;
      ctx.fillText('⏺', 10, y);
      ctx.fillStyle = TERM.tool;
      ctx.fillText(r.text.slice(1), 10 + charW, y);
    } else if (r.kind === 'text' && r.text.startsWith('●')) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('●', 10, y);
      ctx.fillStyle = TERM.text;
      ctx.fillText(r.text.slice(1), 10 + charW, y);
    } else {
      ctx.fillStyle = TERM[r.kind] ?? TERM.text;
      ctx.fillText(r.text, 10, y);
    }
    y += lh;
  }

  if (agent.status === 'working' || agent.status === 'preparing') {
    const frame = Math.floor(now / 120) % SPINNER.length;
    const verb = agent.status === 'preparing' ? (agent.currentTool ?? 'Setting up worktree') : toolVerb(agent.currentTool) || VERBS[Math.floor(now / 6000) % VERBS.length];
    const secs = agent.startedAt ? Math.max(0, Math.floor((officeNow() - agent.startedAt) / 1000)) : 0;
    const mm = Math.floor(secs / 60);
    ctx.fillStyle = TERM.manager;
    ctx.font = `600 ${fontSize}px ${MONO}`;
    ctx.fillText(`${SPINNER[frame]} ${verb}… (${mm}m ${secs % 60}s)`, 10, h - 14);
  }

  if (showBrowser) drawBrowser(ctx, termW, barH, w - termW, h - barH, agent.browserUrl, shot);
}

function drawScreensaver(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, agent: Agent, now: number) {
  const t = now / 1000;
  ctx.fillStyle = SCREEN.bar;
  ctx.fillRect(x, y, w, h);
  const bx = x + w / 2 + Math.sin(t * 0.7) * w * 0.25;
  const by = y + h / 2 + Math.cos(t * 0.9) * h * 0.18;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#6699CC';
  ctx.font = `64px ${SANS}`;
  ctx.fillText('✻', bx, by - 20);
  ctx.fillStyle = SCREEN.text;
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText(`${agent.name} is free`, bx, by + 34);
  ctx.fillStyle = '#AABFD5';
  ctx.font = `18px ${BODY}`;
  ctx.fillText(agent.role === 'ceo' ? 'thinking about the company…' : 'waiting for work…', bx, by + 62);
  ctx.textAlign = 'left';
}

function drawBrowser(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, url: string | null, shot: HTMLImageElement | null) {
  ctx.fillStyle = '#EEF3F8';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#DCE3EA';
  ctx.fillRect(x, y, w, 34);
  roundRect(ctx, x + 10, y + 6, w - 20, 22, 6);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.fillStyle = '#3D454D';
  ctx.font = `13px ${BODY}`;
  ctx.textBaseline = 'middle';
  const u = (url ?? 'about:blank').replace(/^https?:\/\//, '');
  ctx.fillText(`🔒 ${u.length > 42 ? `${u.slice(0, 41)}…` : u}`, x + 20, y + 18);
  const area = { x: x + 4, y: y + 38, w: w - 8, h: h - 42 };
  if (shot && shot.complete && shot.naturalWidth > 0) {
    const s = Math.min(area.w / shot.naturalWidth, area.h / shot.naturalHeight);
    const dw = shot.naturalWidth * s;
    const dh = shot.naturalHeight * s;
    ctx.drawImage(shot, area.x + (area.w - dw) / 2, area.y, dw, dh);
  } else {
    ctx.fillStyle = '#8A96A3';
    ctx.textAlign = 'center';
    ctx.font = `16px ${BODY}`;
    ctx.fillText('🌐 loading page…', area.x + area.w / 2, area.y + area.h / 2);
    ctx.textAlign = 'left';
  }
}

// ---------- kanban whiteboard ----------

const COLS: { key: keyof KanbanColumns; title: string; chip: string; note: string }[] = [
  { key: 'backlog', title: '📋 Backlog', chip: '#AEB8C2', note: '#EEF3F8' },
  { key: 'progress', title: '🔨 In progress', chip: '#6699CC', note: '#DDE8F4' },
  { key: 'qa', title: '🔍 In QA', chip: '#4D7399', note: '#E3EAF2' },
  { key: 'ready', title: '✅ Ready to merge', chip: '#4C9A76', note: '#E4F1EA' },
  { key: 'merged', title: '🎉 Merged', chip: '#26394D', note: '#DCE3EA' },
];

/** The whiteboard's columns, left to right. */
export const KANBAN_KEYS: (keyof KanbanColumns)[] = COLS.map((c) => c.key);

/** Where drawKanban puts column `ci` on a canvas `w` pixels wide: its left edge and width. */
export function kanbanColumnSpan(ci: number, w: number) {
  const colW = (w - 80) / COLS.length;
  return { x0: 40 + ci * colW, colW };
}

const NOTE = { top: 96, h: 104, gap: 12, perCol: 2 };

/** How many notes fit in a column on a canvas `h` pixels tall (one slot goes to "+N more" when there are more). */
export const kanbanCapacity = (h: number) => Math.floor((h - NOTE.top - 70) / (NOTE.h + NOTE.gap)) * NOTE.perCol;

/** Where drawKanban puts the `i`th note of column `ci` on a `w` × `h` canvas. */
export function kanbanNoteRect(ci: number, i: number, w: number) {
  const { x0, colW } = kanbanColumnSpan(ci, w);
  const nw = (colW - 48) / 2;
  return { x: x0 + 16 + (i % NOTE.perCol) * (nw + 16), y: NOTE.top + 68 + Math.floor(i / NOTE.perCol) * (NOTE.h + NOTE.gap), w: nw, h: NOTE.h };
}

/** A column's sticky-note colour. */
export const kanbanNoteColor = (key: keyof KanbanColumns) => COLS.find((c) => c.key === key)?.note ?? '#EEF3F8';

/** A card's sticky colour where it is: its tone's (in the viewer's status palette), else its column's. */
export const kanbanCardColor = (card: KanbanCard, key: keyof KanbanColumns, look: StatusLook = STANDARD_LOOK) => (card.tone ? toneFill(card.tone, look.palette, 'board') : kanbanNoteColor(key));

/** A status shape in a filled circle (the colour-blind-safe cue beside a status colour), centred at x, y. */
function drawStatusBadge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, kind: StatusKind, look: StatusLook) {
  const fill = kindStrong(kind, look.palette);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.strokeStyle = '#26394D';
  ctx.stroke();
  ctx.fillStyle = inkOn(fill, '#1B2732');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(r * 1.25)}px ${SANS}`;
  ctx.fillText(KIND_ICON[kind], x, y + r * 0.08);
  ctx.restore();
}

/** A loose sticky (StickyNotes.tsx's atlas): the note colour, its number big, a darker edge for the toon outline. */
export function drawSticky(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, color: string) {
  ctx.clearRect(x, y, w, h);
  ctx.fillStyle = shadeHex(color, -0.35);
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
  ctx.fillStyle = 'rgba(27,39,50,0.07)';
  ctx.fillRect(x + 4, y + 4, w - 8, h * 0.14);
  ctx.fillStyle = '#26394D';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(h * 0.42)}px ${SANS}`;
  ctx.fillText(label, x + w / 2, y + h * 0.56, w - 16);
  ctx.textAlign = 'left';
}

function shadeHex(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** What the board shows besides the cards: "Depends on" strings between stickies, the stats corner, and the status palette and shapes. */
export interface KanbanExtras {
  strings?: readonly Pair[];
  stats?: BoardStats | null;
  look?: StatusLook;
}

export function drawKanban(ctx: CanvasRenderingContext2D, w: number, h: number, repo: RepoView, cols: KanbanColumns, extras: KanbanExtras = {}) {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  // faint marker smudges
  ctx.fillStyle = 'rgba(170,191,213,0.06)';
  for (let i = 0; i < 6; i++) ctx.fillRect((i * 431) % w, (i * 97) % h, 260, 40);

  ctx.textBaseline = 'middle';
  const statsLeft = extras.stats ? drawStatsCorner(ctx, w - 40, 48, extras.stats) : w - 40;
  ctx.font = `400 26px ${SANS}`;
  const synced = repo.lastSync ? `synced ${new Date(repo.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'syncing…';
  const status = `${repo.autoAssign ? '⚡ auto-assign on · ' : ''}${synced}`;
  const statusW = ctx.measureText(status).width;
  ctx.font = `700 46px ${SANS}`;
  const nameW = Math.min(ctx.measureText(repo.fullName).width, statsLeft - 40 - 40);
  ctx.fillStyle = '#26394D';
  ctx.fillText(fitText(ctx, repo.fullName, nameW), 40, 48);
  // the sync line beside the name, when the stats corner leaves room for it
  if (40 + nameW + 28 + statusW <= statsLeft - 28) {
    ctx.font = `400 26px ${SANS}`;
    ctx.fillStyle = '#436688';
    ctx.fillText(status, 40 + nameW + 28, 52);
  }

  const top = NOTE.top;
  const now = officeNow(); // a testing card's elapsed time: it only moves on when the board repaints anyway
  COLS.forEach((c, ci) => {
    const { x0, colW } = kanbanColumnSpan(ci, w);
    const cards = cols[c.key];
    roundRect(ctx, x0 + 8, top, colW - 16, 52, 26);
    ctx.fillStyle = c.chip;
    ctx.fill();
    ctx.fillStyle = inkOnColor(c.chip);
    ctx.font = `700 30px ${SANS}`;
    ctx.fillText(`${c.title}  ${cards.length}`, x0 + 30, top + 27);
    if (ci > 0) {
      ctx.strokeStyle = '#E0E8F1';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, top);
      ctx.lineTo(x0, h - 30);
      ctx.stroke();
    }

    const capacity = kanbanCapacity(h);
    const shown = cards.length > capacity ? cards.slice(0, capacity - 1) : cards;
    shown.forEach((card, i) => {
      const n = kanbanNoteRect(ci, i, w);
      drawNote(ctx, n.x, n.y, n.w, n.h, card, kanbanCardColor(card, c.key, extras.look), now, extras.look);
    });
    if (cards.length > shown.length) {
      ctx.fillStyle = '#436688';
      ctx.font = `700 26px ${SANS}`;
      const n = kanbanNoteRect(ci, shown.length, w);
      ctx.fillText(`+${cards.length - shown.length} more`, n.x + 14, n.y + n.h / 2);
    }
    if (cards.length === 0) {
      ctx.fillStyle = '#8A96A3';
      ctx.font = `italic 400 26px ${SANS}`;
      ctx.fillText(c.key === 'backlog' ? 'no open issues' : 'nothing here yet', x0 + 30, top + 110);
    }
  });
  for (const p of extras.strings ?? []) drawString(ctx, w, p);
}

/** The stats corner, right-aligned at `right`: one chip per figure, "needs you" in red. Returns its left edge. */
function drawStatsCorner(ctx: CanvasRenderingContext2D, right: number, cy: number, stats: BoardStats) {
  ctx.font = `700 28px ${SANS}`;
  let x = right;
  for (const chip of statsChips(stats).reverse()) {
    const cw = ctx.measureText(chip.text).width + 36;
    x -= cw;
    roundRect(ctx, x, cy - 26, cw, 52, 26);
    ctx.fillStyle = chip.alarm ? '#C25B54' : '#EEF3F8';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = chip.alarm ? '#8C3A34' : '#DCE3EA';
    ctx.stroke();
    ctx.fillStyle = chip.alarm ? '#FFFFFF' : '#26394D';
    ctx.fillText(chip.text, x + 18, cy + 1);
    x -= 12;
  }
  return x;
}

/** A red yarn string pinned to the tops of two stickies (a "Depends on" pair), sagging between them. */
function drawString(ctx: CanvasRenderingContext2D, w: number, p: Pair) {
  const pin = (s: Pair['from']) => {
    const n = kanbanNoteRect(KANBAN_KEYS.indexOf(s.col), s.index, w);
    return { x: n.x + n.w / 2, y: n.y + 12 };
  };
  const a = pin(p.from);
  const b = pin(p.to);
  const sag = 36 + Math.hypot(b.x - a.x, b.y - a.y) * 0.12;
  const cx = (a.x + b.x) / 2;
  const cy = Math.max(a.y, b.y) + sag;
  const path = (dx: number, dy: number) => {
    ctx.beginPath();
    ctx.moveTo(a.x + dx, a.y + dy);
    ctx.quadraticCurveTo(cx + dx, cy + dy, b.x + dx, b.y + dy);
  };
  ctx.lineCap = 'round';
  path(3, 5);
  ctx.strokeStyle = 'rgba(27,39,50,0.16)';
  ctx.lineWidth = 6;
  ctx.stroke();
  path(0, 0);
  ctx.strokeStyle = '#C25B54';
  ctx.lineWidth = 5;
  ctx.stroke();
  // a lighter strand twisted along it, so it reads as yarn
  ctx.setLineDash([7, 9]);
  path(0, -1);
  ctx.strokeStyle = '#E07A72';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  for (const q of [a, b]) {
    ctx.fillStyle = 'rgba(27,39,50,0.2)';
    ctx.beginPath();
    ctx.arc(q.x + 2, q.y + 3, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8C3A34';
    ctx.beginPath();
    ctx.arc(q.x, q.y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#F5DEDC';
    ctx.beginPath();
    ctx.arc(q.x - 3, q.y - 3, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'butt';
}

/**
 * One card on its own canvas (the sticky lifted off the board under the crosshair), drawn as the board draws it with
 * a deeper shadow. The note is `nw` × `nh` board pixels, `pad` of them around it, at `scale` canvas pixels each.
 */
export function drawLiftedNote(ctx: CanvasRenderingContext2D, card: KanbanCard, col: keyof KanbanColumns, nw: number, nh: number, pad: number, scale: number, look: StatusLook = STANDARD_LOOK) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  if (!card.ghost) {
    ctx.fillStyle = 'rgba(27,39,50,0.28)';
    roundRect(ctx, pad + 3, pad + 7, nw + 2, nh + 2, 6);
    ctx.fill();
  }
  drawNote(ctx, pad, pad, nw, nh, card, kanbanCardColor(card, col, look), officeNow(), look);
  ctx.restore();
}

function drawNote(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, card: KanbanCard, color: string, now: number, look: StatusLook = STANDARD_LOOK) {
  const tilt = (((card.number * 37) % 7) - 3) * 0.006;
  const ink = card.agent && /^#[0-9a-f]{6}$/i.test(card.agent.color) ? card.agent.color : '#8A96A3';
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(tilt);
  ctx.translate(-w / 2, -h / 2);
  if (card.ghost) {
    // the sticky is off the board, on its tester's monitor: a dashed slot in their colour, still saying what it is
    ctx.fillStyle = shadeHex(ink, 0.86);
    ctx.fillRect(0, 0, w, h);
    ctx.setLineDash([12, 9]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = 'rgba(27,39,50,0.12)';
    ctx.fillRect(4, 6, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(27,39,50,0.06)';
    ctx.fillRect(0, 0, w, 10);
  }

  ctx.fillStyle = '#26394D';
  ctx.font = `700 22px ${SANS}`;
  ctx.textBaseline = 'top';
  const header = `${card.prNumber ? 'PR ' : ''}#${card.number}`;
  ctx.fillText(header, 14, 12);
  const headerW = ctx.measureText(header).width;
  ctx.font = `600 19px ${BODY}`;
  const lines = wrap(ctx, card.title, w - 28, 2);
  lines.forEach((l, i) => ctx.fillText(l, 14, 38 + i * 21));

  ctx.textBaseline = 'middle';
  if (card.ghost) {
    const label = testingLabel(card.agent?.name, card.qa?.round ?? 0, card.qa?.updatedAt, now);
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(22, h - 15, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#26394D';
    ctx.font = `700 17px ${SANS}`;
    ctx.fillText(label.who, 36, h - 14, w - 46);
    ctx.font = `600 15px ${BODY}`;
    const room = w - 12 - (14 + headerW + 12);
    const meta = label.meta.find((m) => ctx.measureText(m).width <= room);
    if (meta) {
      ctx.fillStyle = '#436688';
      ctx.textAlign = 'right';
      ctx.fillText(meta, w - 12, 24);
      ctx.textAlign = 'left';
    }
  } else if (card.agent) {
    ctx.fillStyle = card.agent.color;
    ctx.beginPath();
    ctx.arc(22, h - 15, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#26394D';
    ctx.font = `700 17px ${SANS}`;
    ctx.fillText(card.agent.name, 36, h - 14);
  }
  if (card.note && !card.ghost) {
    ctx.font = `600 16px ${BODY}`;
    ctx.fillStyle = '#436688';
    ctx.textAlign = 'right';
    ctx.fillText(card.note, w - 12, h - 14);
    ctx.textAlign = 'left';
  }
  if (look.shapes && card.tone && !card.ghost) drawStatusBadge(ctx, w - 18, 20, 13, TONE_KIND[card.tone], look);
  ctx.restore();
  ctx.textBaseline = 'middle';
}

// ---------- signs and tags ----------

export function drawTag(ctx: CanvasRenderingContext2D, w: number, h: number, agent: Agent, look: StatusLook = STANDARD_LOOK) {
  ctx.clearRect(0, 0, w, h);
  const icon =
    agent.status === 'working'
      ? agent.currentTool?.startsWith('mcp__playwright')
        ? '🌐'
        : agent.currentTool === 'Bash' || agent.currentTool === 'PowerShell'
          ? '▶️'
          : agent.currentTool
            ? '⌨️'
            : '💭'
      : agent.status === 'preparing'
        ? '📦'
        : agent.status === 'done'
          ? '✅'
          : agent.status === 'error'
            ? '❗'
            : agent.status === 'stopped'
              ? '⏸️'
              : agent.role === 'ceo'
                ? '🏛️'
                : '☕';
  roundRect(ctx, 4, 4, w - 8, h - 8, 18);
  ctx.fillStyle = PAPER_SIGN.bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = PAPER_SIGN.outline;
  ctx.stroke();
  // the agent's colour as a stripe down the left edge
  ctx.save();
  ctx.clip();
  ctx.fillStyle = agent.color;
  ctx.fillRect(4, 4, 10, h - 8);
  ctx.restore();
  ctx.textBaseline = 'middle';
  ctx.font = `38px ${SANS}`;
  ctx.fillText(icon, 22, h / 2 + 2);
  ctx.fillStyle = PAPER_SIGN.ink;
  ctx.font = `700 40px ${SANS}`;
  const busy = agent.status !== 'idle';
  let label =
    agent.role === 'ceo'
      ? `${agent.name} · CEO`
      : busy && agent.task === 'fix' && agent.prNumber
        ? `${agent.name} · 🔧 PR #${agent.prNumber}`
        : busy && agent.task === 'qa' && agent.prNumber
          ? `${agent.name} · 🧪 PR #${agent.prNumber}`
          : busy && agent.issueNumber
            ? `${agent.name} · #${agent.issueNumber}`
            : agent.name;
  // With status shapes on, a badge at the right end says the status in shape and colour (the icon on the left is the detail).
  const badge = look.shapes ? h * 0.32 : 0;
  while (label.length > 4 && ctx.measureText(label).width > w - 96 - badge * 2) label = `${label.slice(0, -2)}…`;
  ctx.fillText(label, 78, h / 2 + 2);
  if (badge) drawStatusBadge(ctx, w - 14 - badge, h / 2, badge, STATUS_KIND[agent.status], look);
}

/** Name tag for a candidate in the waiting room: who they are, a detail (their coding agent, say) and their floor. */
export function drawCandidateTag(ctx: CanvasRenderingContext2D, w: number, h: number, name: string, detail: string, floor: number | null, color: string) {
  ctx.clearRect(0, 0, w, h);
  roundRect(ctx, 4, 4, w - 8, h - 8, 18);
  ctx.fillStyle = PAPER_SIGN.bg;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = color;
  ctx.setLineDash([14, 8]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textBaseline = 'middle';
  ctx.font = `44px ${SANS}`;
  ctx.fillText('📄', 20, h / 2 + 2);
  const fit = (text: string, max: number) => {
    let t = text;
    while (t.length > 4 && ctx.measureText(t).width > max) t = `${t.slice(0, -2)}…`;
    return t;
  };
  ctx.fillStyle = PAPER_SIGN.ink;
  ctx.font = `700 40px ${SANS}`;
  ctx.fillText(fit(`Candidate: ${name}`, w - 100), 80, h * 0.36);
  ctx.fillStyle = PAPER_SIGN.sub;
  ctx.font = `600 28px ${BODY}`;
  ctx.fillText(fit(`${detail}${floor ? ` · Floor ${floor}` : ''}`, w - 100), 80, h * 0.72);
}

export function drawSign(ctx: CanvasRenderingContext2D, w: number, h: number, lines: { text: string; size: number; color?: string; weight?: number }[], bg: string, fg = '#FFFFFF') {
  roundRect(ctx, 0, 0, w, h, 28);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const total = lines.reduce((s, l) => s + l.size * 1.25, 0);
  let y = h / 2 - total / 2;
  for (const l of lines) {
    y += (l.size * 1.25) / 2;
    ctx.fillStyle = l.color ?? fg;
    // Komet has 400 and 700 only: lighter asks get 400, heavier 700
    ctx.font = `${(l.weight ?? 700) >= 600 ? 700 : 400} ${l.size}px ${SANS}`;
    let text = l.text;
    while (text.length > 3 && ctx.measureText(text).width > w - 40) text = `${text.slice(0, -2)}…`;
    ctx.fillText(text, w / 2, y);
    y += (l.size * 1.25) / 2;
  }
  ctx.textAlign = 'left';
}

/** Window glass: a faint blue tint you see straight through, with two diagonal glints. */
export function drawGlass(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = 'rgba(214, 228, 242, 0.16)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
  for (const [x0, bw] of [[0.18, 0.07], [0.3, 0.025]] as const) {
    ctx.beginPath();
    ctx.moveTo(w * x0, h);
    ctx.lineTo(w * (x0 + bw), h);
    ctx.lineTo(w * (x0 + bw + 0.22), 0);
    ctx.lineTo(w * (x0 + 0.22), 0);
    ctx.fill();
  }
}

/**
 * One bay of the building's outside, one storey tall, for the floors above and below yours: the wall, a window,
 * and the slab between floors along the top. `wall` is the fraction of the storey that's wall (the rest is slab).
 */
export function drawFacade(ctx: CanvasRenderingContext2D, w: number, h: number, wall: number, win: { x0: number; x1: number; y0: number; y1: number }) {
  ctx.fillStyle = '#E8EEF4';
  ctx.fillRect(0, 0, w, h);
  const slab = h * (1 - wall);
  ctx.fillStyle = '#C9D4DF';
  ctx.fillRect(0, 0, w, slab);
  ctx.fillStyle = '#AEB8C2';
  ctx.fillRect(0, slab - 3, w, 3);
  // fractions of the storey, from its floor up
  const x0 = w * win.x0;
  const x1 = w * win.x1;
  const top = h - h * win.y1;
  const bottom = h - h * win.y0;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0 - 5, top - 5, x1 - x0 + 10, bottom - top + 12);
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, '#8FB5DD');
  g.addColorStop(1, '#D6E4F2');
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, x1 - x0, bottom - top);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(x0 + (x1 - x0) * 0.15, bottom);
  ctx.lineTo(x0 + (x1 - x0) * 0.25, bottom);
  ctx.lineTo(x0 + (x1 - x0) * 0.45, top);
  ctx.lineTo(x0 + (x1 - x0) * 0.35, top);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect((x0 + x1) / 2 - 3, top, 6, bottom - top);
  ctx.fillStyle = '#26394D';
  ctx.fillRect(x0 - 5, bottom + 5, x1 - x0 + 10, 2);
}

// ---------- the floor's app monitor ----------

const APP_STEPS: { status: PreviewStatus; label: string }[] = [
  { status: 'preparing', label: 'Checking out the code' },
  { status: 'installing', label: 'Installing dependencies' },
  { status: 'starting', label: 'Starting the app' },
];

const APP_BADGE: Record<PreviewStatus, { text: string; bg: string }> = {
  unconfigured: { text: 'NOT SET UP', bg: '#6B7580' },
  stopped: { text: 'STOPPED', bg: '#6B7580' },
  preparing: { text: 'STARTING', bg: '#C9A24B' },
  installing: { text: 'STARTING', bg: '#C9A24B' },
  starting: { text: 'STARTING', bg: '#C9A24B' },
  running: { text: '● LIVE', bg: '#C25B54' },
  error: { text: 'ERROR', bg: '#C25B54' },
};

/** Shorten text with an ellipsis until it fits in max pixels, in the context's current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number) {
  let t = text;
  while (t.length > 2 && ctx.measureText(t).width > max) t = `${t.slice(0, -2)}…`;
  return t;
}

/** A channel on the big screen's strip: main or an open PR, with its light. */
export interface ScreenChip {
  label: string;
  on: boolean; // the channel on screen
  led: 'live' | 'busy' | 'bad' | 'off';
}

const CHIP_LED: Record<ScreenChip['led'], string> = { live: SCREEN.good, busy: SCREEN.warn, bad: SCREEN.bad, off: SCREEN.idle };

export interface AppScreenInfo {
  floor: number;
  name: string;
  color: string;
  preview: PreviewView; // the channel on screen: the floor's main preview, or a PR's
  shot: HTMLImageElement | null; // shown while the app is live: the latest agent screenshot on the floor, or QA's of the PR
  shotCaption: string | null; // what the screenshot is, e.g. "latest from Ada's browser"
  channels?: ScreenChip[]; // the channel strip, drawn when the floor has open PRs
  /** The player's interact key (Help → Controls). */
  use: string;
}

/** The wall screen at the front of an office floor: the floor's app and how it's doing. */
export function drawAppScreen(ctx: CanvasRenderingContext2D, w: number, h: number, info: AppScreenInfo) {
  const p = info.preview;
  ctx.fillStyle = TERM.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // header: floor chip, floor name, status badge
  const headH = 118;
  ctx.fillStyle = TERM.bar;
  ctx.fillRect(0, 0, w, headH);
  ctx.fillStyle = info.color;
  ctx.fillRect(0, headH - 6, w, 6);
  ctx.font = `700 34px ${SANS}`;
  const chip = `FLOOR ${info.floor}`;
  const chipW = ctx.measureText(chip).width + 44;
  roundRect(ctx, 40, 30, chipW, 54, 14);
  ctx.fillStyle = info.color;
  ctx.fill();
  ctx.fillStyle = inkOnColor(info.color);
  ctx.fillText(chip, 62, 58);

  const badge = APP_BADGE[p.status];
  ctx.font = `700 38px ${SANS}`;
  const badgeW = ctx.measureText(badge.text).width + 52;
  roundRect(ctx, w - 40 - badgeW, 28, badgeW, 58, 14);
  ctx.fillStyle = badge.bg;
  ctx.fill();
  ctx.fillStyle = inkOnColor(badge.bg);
  ctx.textAlign = 'center';
  ctx.fillText(badge.text, w - 40 - badgeW / 2, 58);
  ctx.textAlign = 'left';

  ctx.fillStyle = TERM.text;
  ctx.font = `700 50px ${SANS}`;
  const nameX = 40 + chipW + 26;
  ctx.fillText(fitText(ctx, info.name, w - 40 - badgeW - 26 - nameX), nameX, 58);

  const centred = (text: string, y: number, size: number, color: string, weight = 700) => {
    ctx.font = `${weight} ${size}px ${SANS}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, text, w - 100), w / 2, y);
    ctx.textAlign = 'left';
  };
  // With a channel strip along the bottom, the footer line sits above it.
  const strip = info.channels && info.channels.length > 1 ? info.channels : null;
  const footH = strip ? 200 : 100;
  const footer = (text: string, color = TERM.result) => centred(text, h - footH + 50, 32, color, 700);

  const bodyTop = headH;
  const midY = bodyTop + (h - headH - footH) / 2;
  const ref = p.ref ?? 'the app';

  if (p.status === 'stopped') {
    // a big play button
    const cy = midY - 70;
    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(w / 2, cy, 84, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = inkOnColor(info.color);
    ctx.beginPath();
    ctx.moveTo(w / 2 - 26, cy - 42);
    ctx.lineTo(w / 2 - 26, cy + 42);
    ctx.lineTo(w / 2 + 44, cy);
    ctx.closePath();
    ctx.fill();
    centred(`Press ${info.use} to open the app`, midY + 80, 70, TERM.text);
    footer("The app isn't running. Start it from the viewer.");
  } else if (p.status === 'unconfigured') {
    centred('⚙️', midY - 90, 110, TERM.text, 400);
    centred('No run command yet.', midY + 40, 66, TERM.text);
    centred("Set one in the manager's console.", midY + 120, 44, '#AABFD5', 400);
    footer(`Press ${info.use} to open the app`);
  } else if (p.status === 'error') {
    const firstLine = (p.error ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() || 'The app stopped unexpectedly.';
    ctx.fillStyle = '#C25B54';
    ctx.fillRect(0, midY - 120, w, 130);
    ctx.font = `700 44px ${SANS}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(fitText(ctx, `⚠ ${firstLine}`, w - 100), 50, midY - 55);
    centred("The app couldn't start.", midY + 90, 52, TERM.text);
    footer(`Press ${info.use} to see the log and try again`, '#EBA09A');
  } else if (p.status !== 'running') {
    const at = Math.max(0, APP_STEPS.findIndex((s) => s.status === p.status));
    centred(`Getting ${ref} ready…`, bodyTop + 80, 46, '#AABFD5', 400);
    centred(`${APP_STEPS[at].label}…`, midY - 20, 72, TERM.text);
    // a three-step progress bar
    const gap = 18;
    const segW = (w - 200 - gap * (APP_STEPS.length - 1)) / APP_STEPS.length;
    APP_STEPS.forEach((s, i) => {
      const x = 100 + i * (segW + gap);
      const y = midY + 90;
      roundRect(ctx, x, y, segW, 34, 17);
      ctx.fillStyle = i < at ? TERM.done : i === at ? SCREEN.warn : SCREEN.line;
      ctx.fill();
      ctx.font = `700 28px ${SANS}`;
      ctx.fillStyle = i <= at ? TERM.text : SCREEN.dim;
      ctx.textAlign = 'center';
      ctx.fillText(`${i < at ? '✓ ' : ''}${s.label}`, x + segW / 2, y + 70);
      ctx.textAlign = 'left';
    });
    footer(`Step ${at + 1} of ${APP_STEPS.length} · press ${info.use} to watch`);
  } else {
    // running: where it's served and what's deployed, plus the latest thing an agent on this floor looked at
    const left = 56;
    const colW = info.shot ? w * 0.5 : w - 2 * left;
    ctx.font = `700 34px ${SANS}`;
    ctx.fillStyle = '#AABFD5';
    ctx.fillText('Serving at', left, bodyTop + 72);
    ctx.font = `700 50px ${MONO}`;
    ctx.fillStyle = TERM.tool;
    ctx.fillText(fitText(ctx, (p.url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, ''), colW), left, bodyTop + 140);

    ctx.font = `700 42px ${SANS}`;
    const refW = ctx.measureText(ref).width + 48;
    roundRect(ctx, left, bodyTop + 208, refW, 64, 14);
    ctx.fillStyle = info.color;
    ctx.fill();
    ctx.fillStyle = inkOnColor(info.color);
    ctx.fillText(ref, left + 24, bodyTop + 241);
    if (p.commit) {
      ctx.font = `600 42px ${MONO}`;
      ctx.fillStyle = TERM.thinking;
      ctx.fillText(p.commit, left + refW + 24, bodyTop + 241);
    }
    if (p.startedAt) {
      ctx.font = `400 32px ${SANS}`;
      ctx.fillStyle = TERM.result;
      ctx.fillText(`up since ${new Date(p.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, left, bodyTop + 330);
    }

    if (info.shot) {
      const tw = w - colW - left - 70;
      const th = Math.round(tw * 0.5625);
      const tx = w - 40 - tw;
      const ty = bodyTop + 50;
      ctx.fillStyle = SCREEN.line;
      ctx.fillRect(tx - 6, ty - 6, tw + 12, th + 12);
      // cover-fit, anchored to the top left like a browser viewport
      const img = info.shot;
      const scale = Math.max(tw / img.width, th / img.height);
      ctx.drawImage(img, 0, 0, tw / scale, th / scale, tx, ty, tw, th);
      ctx.font = `400 26px ${BODY}`;
      ctx.fillStyle = TERM.result;
      ctx.fillText(fitText(ctx, info.shotCaption ?? 'latest agent screenshot', tw), tx, ty + th + 36);
    }
    footer(`Press ${info.use} to open the app`, TERM.done);
  }
  if (strip) drawChannelStrip(ctx, w, h, strip, info.color);
}

/** The row of channel chips along the bottom of the big screen; aiming at one and pressing E switches to it. */
function drawChannelStrip(ctx: CanvasRenderingContext2D, w: number, h: number, chips: ScreenChip[], color: string) {
  const rects = chipRects(chips.length, w, h);
  ctx.fillStyle = TERM.bar;
  ctx.fillRect(0, rects[0].y - 16, w, h - rects[0].y + 16);
  ctx.textBaseline = 'middle';
  chips.forEach((c, i) => {
    const r = rects[i];
    roundRect(ctx, r.x, r.y, r.w, r.h, 18);
    ctx.fillStyle = c.on ? color : SCREEN.line;
    ctx.fill();
    if (c.on) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }
    ctx.fillStyle = CHIP_LED[c.led];
    ctx.beginPath();
    ctx.arc(r.x + 26, r.y + r.h / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `700 30px ${SANS}`;
    ctx.fillStyle = c.on ? inkOnColor(color) : '#DCE3EA';
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, c.label, r.w - 56), r.x + r.w / 2 + 14, r.y + r.h / 2 + 1);
    ctx.textAlign = 'left';
  });
}
