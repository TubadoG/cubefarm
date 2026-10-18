import { MONO, SANS, roundRect } from '../../world/draw';

// Canvas painters shared by the phone games, in the office's look: game pieces are toon blocks (flat colour, a light
// top edge, a darker bottom edge, a navy outline) like the 3D office's furniture; the chrome around them is flat white
// cards on hairlines, like the HTML panels.

export { MONO, SANS, roundRect };
export const INK = '#26394D';
export const PAPER = '#FFFFFF';
export const MUTED = '#436688';
/** Card edges: the stylesheet's --border-hairline. */
export const HAIRLINE = '#E0E8F1';
/** The games' wells (Tetris board, Snake floor): the dark-screen navy. */
export const WELL = '#1B2732';
/** The office floor colours (server/swarm.ts FLOOR_COLORS). */
export const FLOOR = ['#6699CC', '#5FA8A0', '#8C9FD9', '#7FB7D9', '#9C8FC4', '#86B39A', '#AABFD5', '#B4A7D6'];

/** A rounded toon block: fill, a lighter top, a darker bottom and an ink outline. */
export function toonBlock(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, r = Math.min(w, h) * 0.24, line = 2) {
  roundRect(ctx, x + line / 2, y + line / 2, w - line, h - line, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillRect(x, y, w, h * 0.26);
  ctx.fillStyle = 'rgba(27,39,50,0.13)';
  ctx.fillRect(x, y + h * 0.74, w, h * 0.26);
  ctx.restore();
  ctx.lineWidth = line;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

/** A flat card on a hairline, like the office's cards and panels (radius 9 by default, the controls' radius). */
export function card(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill = PAPER, r = 9, edge = HAIRLINE) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = edge;
  ctx.stroke();
}

/** Text in the display face (Komet: 400 or 700 only); pass MONO as `family` for labels and numbers. */
export function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color = INK, weight = 700, align: CanvasTextAlign = 'center', family = SANS) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

/** Big friendly text with an ink outline, for "Stack overflow!" and floating points. */
export function outlinedText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string) {
  ctx.font = `700 ${size}px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size / 5);
  ctx.strokeStyle = INK;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** Cartoon eyes: white ovals with ink rims and pupils looking (lx, ly) in -1..1; closed when blink is true. */
export function eyes(ctx: CanvasRenderingContext2D, cx: number, cy: number, gap: number, r: number, lx = 0, ly = 0, blink = false) {
  for (const side of [-1, 1]) {
    const ex = cx + (side * gap) / 2;
    if (blink) {
      ctx.beginPath();
      ctx.moveTo(ex - r, cy);
      ctx.quadraticCurveTo(ex, cy + r * 0.6, ex + r, cy);
      ctx.lineWidth = Math.max(1.5, r * 0.35);
      ctx.lineCap = 'round';
      ctx.strokeStyle = INK;
      ctx.stroke();
      continue;
    }
    ctx.beginPath();
    ctx.ellipse(ex, cy, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.28);
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ex + lx * r * 0.35, cy + ly * r * 0.35, r * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex + lx * r * 0.35 - r * 0.18, cy + ly * r * 0.35 - r * 0.2, r * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

/** A lighter or darker version of a #rrggbb colour (amount -1..1). */
export function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ---------- confetti and pop-up points ----------

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // seconds left
  color: string;
  size: number;
  text?: string;
}

export function burst(into: Particle[], x: number, y: number, colors: string[], n = 12, speed = 120) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    into.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.4, life: 0.6 + Math.random() * 0.4, color: colors[i % colors.length], size: 3 + Math.random() * 3 });
  }
}

export function popText(into: Particle[], x: number, y: number, s: string, color: string, size = 18) {
  into.push({ x, y, vx: 0, vy: -40, life: 1.1, color, size, text: s });
}

/** Moves and draws particles, dropping the ones that are done. */
export function drawParticles(ctx: CanvasRenderingContext2D, ps: Particle[], dt: number) {
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    p.life -= dt;
    if (p.life <= 0) {
      ps.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (!p.text) p.vy += 320 * dt;
    ctx.globalAlpha = Math.min(1, p.life * 2);
    if (p.text) outlinedText(ctx, p.text, p.x, p.y, p.size, p.color);
    else {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      ctx.lineWidth = 1;
      ctx.strokeStyle = INK;
      ctx.strokeRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }
}

/** The "paused / game over / press start" card drawn over a game. */
export function messageCard(ctx: CanvasRenderingContext2D, w: number, h: number, title: string, lines: string[], accent: string) {
  ctx.fillStyle = 'rgba(27,39,50,0.45)';
  ctx.fillRect(0, 0, w, h);
  const cw = Math.min(w - 36, 250);
  const ch = 70 + lines.length * 22;
  const x = (w - cw) / 2;
  const y = (h - ch) / 2;
  card(ctx, x, y, cw, ch, PAPER, 14);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, cw, 4);
  ctx.restore();
  text(ctx, title, w / 2, y + 36, 22, INK, 700);
  lines.forEach((l, i) => text(ctx, l, w / 2, y + 68 + i * 22, i === lines.length - 1 ? 13 : 15, i === lines.length - 1 ? MUTED : INK, i === lines.length - 1 ? 400 : 700));
}
