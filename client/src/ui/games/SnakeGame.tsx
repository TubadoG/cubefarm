import { useRef, useState } from 'react';
import { GameCanvas, GameHeader, PadButton, arrowOf, isStartKey, useGameKeys, useOnAway, type Arrow } from './kit';
import { FLOOR, INK, MONO, MUTED, WELL, burst, card, drawParticles, eyes, messageCard, popText, shade, text, toonBlock, type Particle } from './paint';
import { randomSeed } from './rng';
import { newSnake, step, stepMs, turn, type Pt, type SnakeEnd, type SnakeState } from './snake';
import { blip } from './sounds';
import { bestScore, recordScore } from './storage';

// Cable Snake on the phone: a green network cable with googly eyes crawling over the office carpet, eating bugs and
// the odd coffee, around four desks.

export const SNAKE_COLOR = '#5FA8A0';

const C = 20;
const GX = 6;
const GY = 38;
const COLS = 16;
const ROWS = 16;
const W = GX * 2 + COLS * C;
const H = GY + ROWS * C + 6;
const CABLE = '#7FC4A0';

type Status = 'ready' | 'playing' | 'paused' | 'over';

let saved: SnakeState | null = null;
export const snakeInProgress = () => saved !== null;

const ENDS: Record<SnakeEnd, string> = { wall: 'Unplugged!', self: 'Tangled up!', desk: 'Desk crash!', won: 'Office wired! 🎉' };
const ANGLE: Record<Arrow, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
const LOOK: Record<Arrow, [number, number]> = { right: [1, 0], down: [0, 1], left: [-1, 0], up: [0, -1] };

const cx = (p: Pt) => GX + p.x * C + C / 2;
const cy = (p: Pt) => GY + p.y * C + C / 2;

export function Snake({ onBack }: { onBack: () => void }) {
  const [status, setStatusState] = useState<Status>(saved ? 'paused' : 'ready');
  const st = useRef({
    game: saved ?? newSnake(randomSeed(), COLS, ROWS),
    status: (saved ? 'paused' : 'ready') as Status,
    acc: 0,
    best: bestScore('snake'),
    newBest: false,
    particles: [] as Particle[],
    shake: 0,
    chomp: 0,
    swipe: null as { x: number; y: number } | null,
  });

  const setStatus = (s: Status) => {
    st.current.status = s;
    setStatusState(s);
    saved = s === 'over' || s === 'ready' ? null : st.current.game;
  };

  const update = (next: SnakeState) => {
    const s = st.current;
    const prev = s.game;
    if (next === prev) return;
    s.game = next;
    if (s.status === 'playing') saved = next;
    if (next.ate) {
      const head = next.body[0];
      if (next.ate === 'coffee') blip.slurp();
      else blip.chomp();
      s.chomp = 0.18;
      burst(s.particles, cx(head), cy(head), next.ate === 'coffee' ? ['#8d5524', '#ffffff', '#E2C26E'] : ['#E07A72', '#7FC4A0', '#ffffff'], 8, 90);
      popText(s.particles, cx(head), cy(head) - 12, next.ate === 'coffee' ? '+50 ☕' : '+10', next.ate === 'coffee' ? '#E2C26E' : '#ffffff', 15);
    }
    if (next.over && !prev.over) {
      s.newBest = recordScore('snake', next.score);
      if (s.newBest) s.best = next.score;
      s.shake = next.over === 'won' ? 0 : 0.3;
      if (next.over === 'won') blip.best();
      else blip.over();
      if (s.newBest && next.over !== 'won') blip.best();
      setStatus('over');
    }
  };

  const start = () => {
    const s = st.current;
    if (s.status === 'playing') return;
    if (s.status === 'over') s.game = newSnake(randomSeed(), COLS, ROWS);
    if (s.status !== 'paused') {
      s.newBest = false;
      s.particles.length = 0;
    }
    s.acc = 0;
    blip.start();
    setStatus('playing');
  };
  const pause = () => {
    if (st.current.status !== 'playing') return;
    blip.pause();
    setStatus('paused');
  };
  /** A direction from a key, the pad or a swipe; from the start screen it also starts the game. */
  const steer = (d: Arrow) => {
    if (st.current.status !== 'playing') {
      if (st.current.status === 'paused') return start();
      start();
    }
    update(turn(st.current.game, d));
  };

  useGameKeys((e) => {
    const d = arrowOf(e.code);
    if (d) {
      if (!e.repeat) steer(d);
      return true;
    }
    if (isStartKey(e.code)) {
      if (!e.repeat) (st.current.status === 'playing' ? pause : start)();
      return true;
    }
    return false;
  });
  useOnAway(pause);

  const onPointer = (kind: 'down' | 'move' | 'up', x: number, y: number) => {
    const s = st.current;
    if (kind === 'down') {
      s.swipe = { x, y };
      return;
    }
    if (!s.swipe) return;
    const dx = x - s.swipe.x;
    const dy = y - s.swipe.y;
    if (kind === 'move' && Math.max(Math.abs(dx), Math.abs(dy)) > 18) {
      steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
      s.swipe = { x, y };
    } else if (kind === 'up') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8 && s.status !== 'playing') start();
      s.swipe = null;
    }
  };

  const frame = (ctx: CanvasRenderingContext2D, dt: number, now: number) => {
    const s = st.current;
    if (s.status === 'playing') {
      s.acc += dt * 1000;
      let every = stepMs(s.game);
      while (s.acc >= every && s.status === 'playing') {
        s.acc -= every;
        update(step(s.game));
        every = stepMs(s.game);
      }
    }
    const g = s.game;

    // the scores along the top
    card(ctx, GX, 4, 96, 26);
    text(ctx, `🐛 ${g.eaten} eaten`, GX + 48, 17, 12, INK, 700);
    card(ctx, W / 2 - 50, 4, 100, 26);
    text(ctx, `SCORE ${g.score}`, W / 2, 17, 11, INK, 600, 'center', MONO);
    card(ctx, W - GX - 96, 4, 96, 26);
    const best = Math.max(s.best, g.score);
    text(ctx, `BEST ${best}`, W - GX - 48, 17, 11, g.score > s.best ? '#3D6B54' : MUTED, 600, 'center', MONO);

    ctx.save();
    if (s.shake > 0) {
      s.shake -= dt;
      ctx.translate((Math.random() - 0.5) * 12 * s.shake, (Math.random() - 0.5) * 12 * s.shake);
    }

    // office carpet tiles
    card(ctx, GX - 3, GY - 3, COLS * C + 6, ROWS * C + 6, WELL, 9, WELL);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(GX, GY, COLS * C, ROWS * C, 6);
    ctx.clip();
    ctx.fillStyle = '#22303F';
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if ((x + y) % 2) ctx.fillRect(GX + x * C, GY + y * C, C, C);
    ctx.restore();

    // desks, each with a little monitor
    for (let i = 0; i + 1 < g.desks.length; i += 2) {
      const a = g.desks[i];
      const x = GX + a.x * C;
      const y = GY + a.y * C;
      toonBlock(ctx, x + 1, y + 2, C * 2 - 2, C - 3, '#E4E9EE', 5);
      toonBlock(ctx, x + C - 8, y - 3, 16, 12, '#3D454D', 3, 1.5);
      ctx.fillStyle = FLOOR[(i / 2) % FLOOR.length];
      ctx.fillRect(x + C - 5, y, 10, 5);
    }

    drawFood(ctx, g, now);
    drawCable(ctx, g, s.chomp, now);
    s.chomp = Math.max(0, s.chomp - dt);
    ctx.restore();

    drawParticles(ctx, s.particles, dt);

    if (s.status === 'ready') messageCard(ctx, W, H, 'Cable Snake', ['Eat bugs 🐛, sip coffee ☕', 'Dodge desks, walls & yourself', 'Arrows, swipe or tap to start'], SNAKE_COLOR);
    else if (s.status === 'paused') messageCard(ctx, W, H, 'Coffee break ☕', [`Score ${g.score}`, 'Space or tap to resume'], SNAKE_COLOR);
    else if (s.status === 'over') messageCard(ctx, W, H, ENDS[g.over ?? 'self'], [`Score ${g.score} · ${g.body.length} long`, s.newBest ? '🏆 New best!' : `Best ${s.best}`, 'Space or tap to play again'], g.over === 'won' ? '#4C9A76' : '#C25B54');
  };

  const pad = (d: Arrow, glyph: string, label: string) => (
    <PadButton label={label} className={`game-pad-${d}`} onPress={() => steer(d)}>
      {glyph}
    </PadButton>
  );
  return (
    <div className="game">
      <GameHeader title="Cable Snake" color={SNAKE_COLOR} onBack={onBack}>
        <button type="button" className="game-mini" tabIndex={-1} onPointerDown={(e) => e.preventDefault()} onClick={() => (status === 'playing' ? pause() : start())} title={status === 'playing' ? 'Pause (Space)' : 'Play (Space)'}>
          {status === 'playing' ? '⏸' : '▶'}
        </button>
      </GameHeader>
      <GameCanvas width={W} height={H} frame={frame} label="Cable Snake board" onPointer={onPointer} />
      <div className="game-dpad">
        {pad('up', '▲', 'Up')}
        {pad('left', '◀', 'Left')}
        {pad('right', '▶', 'Right')}
        {pad('down', '▼', 'Down')}
      </div>
      <div className="game-keys">
        <kbd>←</kbd>
        <kbd>↑</kbd>
        <kbd>→</kbd>
        <kbd>↓</kbd> or <kbd>WASD</kbd> steer · swipe on the board · <kbd>Space</kbd> pause
      </div>
    </div>
  );
}

function drawFood(ctx: CanvasRenderingContext2D, g: SnakeState, now: number) {
  const x = cx(g.food);
  const y = cy(g.food);
  ctx.save();
  ctx.translate(x, y);
  if (g.food.kind === 'coffee') {
    // a glowing mug of coffee, steaming
    const pulse = 0.5 + Math.sin(now / 200) * 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, 10 + pulse * 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(226,194,110,${0.25 + pulse * 0.2})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(5, 1, 3.5, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-7, -5, 12, 12, 2.5);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-1, -4, 5, 1.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#8d5524';
    ctx.fill();
    ctx.strokeStyle = 'rgba(234,240,246,0.6)';
    ctx.lineWidth = 1.2;
    for (const sx of [-3, 1]) {
      const t = (now / 400 + sx) % 1;
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.moveTo(sx, -7 - t * 6);
      ctx.quadraticCurveTo(sx + 2, -9 - t * 6, sx, -11 - t * 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    // a little red bug, wiggling its legs
    ctx.rotate(Math.sin(now / 160) * 0.18);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    for (const side of [-1, 1])
      for (const ly of [-3, 0.5, 4]) {
        ctx.beginPath();
        ctx.moveTo(side * 3, ly);
        ctx.lineTo(side * 8, ly + Math.sin(now / 90 + ly) * 1.5 - 1);
        ctx.stroke();
      }
    ctx.beginPath();
    ctx.moveTo(-1.5, -7);
    ctx.lineTo(-4, -10);
    ctx.moveTo(1.5, -7);
    ctx.lineTo(4, -10);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -6, 3, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 1, 5.5, 6.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#E07A72';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(0, 7);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = INK;
    for (const [sx, sy] of [
      [-2.6, -0.5],
      [2.6, -0.5],
      [-2.4, 3.5],
      [2.4, 3.5],
    ]) {
      ctx.beginPath();
      ctx.arc(sx, sy, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawCable(ctx: CanvasRenderingContext2D, g: SnakeState, chomp: number, now: number) {
  const pts = g.body;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(cx(pts[pts.length - 1]), cy(pts[pts.length - 1]));
    for (let i = pts.length - 2; i >= 0; i--) ctx.lineTo(cx(pts[i]), cy(pts[i]));
  };
  path();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 14;
  ctx.stroke();
  ctx.strokeStyle = CABLE;
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.save();
  ctx.translate(0, -2);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
  // cable ties every few segments
  ctx.strokeStyle = shade(CABLE, -0.45);
  ctx.lineWidth = 3;
  for (let i = 3; i < pts.length - 1; i += 4) {
    const a = pts[i];
    const b = pts[i + 1];
    const mx = (cx(a) + cx(b)) / 2;
    const my = (cy(a) + cy(b)) / 2;
    const vertical = a.x === b.x;
    ctx.beginPath();
    ctx.moveTo(mx - (vertical ? 5 : 0), my - (vertical ? 0 : 5));
    ctx.lineTo(mx + (vertical ? 5 : 0), my + (vertical ? 0 : 5));
    ctx.stroke();
  }

  // the head: an RJ45 plug with googly eyes, looking where it's going
  const head = pts[0];
  const dir = g.queue[0] ?? g.dir;
  const hx = cx(head);
  const hy = cy(head);
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ANGLE[g.dir]);
  const bite = chomp > 0 ? 1.12 : 1;
  ctx.scale(bite, bite);
  ctx.beginPath();
  ctx.roundRect(-8, -8, 16, 16, 3.5);
  ctx.fillStyle = '#EAF0F6';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = '#D4B483';
  for (let i = 0; i < 4; i++) ctx.fillRect(5, -6 + i * 3.3, 3, 1.8);
  ctx.restore();
  const [lx, ly] = LOOK[dir];
  const ex = hx - LOOK[g.dir][0] * 2;
  const ey = hy - LOOK[g.dir][1] * 2 - 1;
  if (g.over && g.over !== 'won') {
    // dazed: X eyes
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      const x = ex + side * 4;
      ctx.beginPath();
      ctx.moveTo(x - 2.5, ey - 2.5);
      ctx.lineTo(x + 2.5, ey + 2.5);
      ctx.moveTo(x + 2.5, ey - 2.5);
      ctx.lineTo(x - 2.5, ey + 2.5);
      ctx.stroke();
    }
  } else eyes(ctx, ex, ey, 8, 3.2, lx, ly, Math.floor(now / 170) % 25 === 0);
}
