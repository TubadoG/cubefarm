import { useRef, useState } from 'react';
import { GameCanvas, GameHeader, PadButton, arrowOf, isStartKey, useGameKeys, useOnAway } from './kit';
import { FLOOR, INK, MONO, MUTED, WELL, burst, card, drawParticles, eyes, messageCard, outlinedText, popText, text, toonBlock, type Particle } from './paint';
import { randomSeed } from './rng';
import { blip } from './sounds';
import { bestScore, recordScore } from './storage';
import { COLS, ROWS, dropDistance, dropMs, hardDrop, move, newTetris, pieceCells, previewCells, rotate, softDrop, tick, type PieceType, type TetrisState } from './tetris';

// Cubetris on the phone: falling office blocks in the floors' colours, with a line-clear confetti pop.

export const TETRIS_COLOR = '#9C8FC4';

/** One colour per piece, from the office's floor palette. */
const COLOR: Record<PieceType, string> = { I: '#7FB7D9', O: '#E2C26E', T: '#9C8FC4', S: '#7FC4A0', Z: '#E07A72', J: '#4D7399', L: '#D4B483' };

const C = 18; // cell size in canvas units
const BX = 8;
const BY = 8;
const BW = COLS * C;
const BH = ROWS * C;
const SIDE = BX + BW + 12;
const W = SIDE + 92 + 6;
const H = BY + BH + 8;

type Status = 'ready' | 'playing' | 'paused' | 'over';

// The game in progress survives the phone being put away (or leaving for the game list), paused.
let saved: TetrisState | null = null;
export const tetrisInProgress = () => saved !== null;

const CLEAR_WORDS = ['', 'Shipped!', 'Double ship!', 'Triple ship!', 'CUBETRIS!'];

export function Tetris({ onBack }: { onBack: () => void }) {
  const [status, setStatusState] = useState<Status>(saved ? 'paused' : 'ready');
  const st = useRef({
    game: saved ?? newTetris(randomSeed()),
    status: (saved ? 'paused' : 'ready') as Status,
    acc: 0,
    best: bestScore('tetris'),
    newBest: false,
    flash: [] as { y: number; t: number }[],
    particles: [] as Particle[],
    shake: 0,
    lastDx: 0,
  });

  const setStatus = (s: Status) => {
    st.current.status = s;
    setStatusState(s);
    saved = s === 'over' || s === 'ready' ? null : st.current.game;
  };

  /** Takes a new game state and plays whatever happened in it: landings, cleared lines, level ups, game over. */
  const update = (next: TetrisState) => {
    const s = st.current;
    const prev = s.game;
    if (next === prev) return false;
    s.game = next;
    saved = s.status === 'playing' ? next : saved;
    if (next.locks !== prev.locks) {
      const n = next.cleared.length;
      if (n) {
        blip.lines(n);
        const gained = next.score - prev.score;
        for (const y of next.cleared) {
          s.flash.push({ y, t: 0.35 });
          burst(s.particles, BX + BW / 2, BY + y * C + C / 2, FLOOR, 10, 150);
        }
        const midY = BY + (next.cleared.reduce((a, b) => a + b, 0) / n) * C;
        popText(s.particles, BX + BW / 2, midY - 14, CLEAR_WORDS[n], n === 4 ? '#E2C26E' : '#ffffff', n === 4 ? 26 : 20);
        popText(s.particles, BX + BW / 2, midY + 12, `+${gained}`, '#7FC4A0', 16);
        if (n === 4) s.shake = 0.35;
      } else blip.land();
      if (next.level > prev.level) {
        blip.levelUp();
        popText(s.particles, BX + BW / 2, BY + BH / 3, `Level ${next.level}!`, '#8FB5DD', 24);
      }
      if (next.over) {
        s.newBest = recordScore('tetris', next.score);
        if (s.newBest) s.best = next.score;
        blip.over();
        if (s.newBest) blip.best();
        setStatus('over');
      }
    }
    return true;
  };

  const start = () => {
    const s = st.current;
    if (s.status === 'playing') return;
    if (s.status === 'over' || s.status === 'ready') {
      if (s.status === 'over') s.game = newTetris(randomSeed());
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

  const shift = (dx: number) => {
    st.current.lastDx = dx;
    if (update(move(st.current.game, dx))) blip.move();
  };
  const turn = (dir: 1 | -1) => update(rotate(st.current.game, dir)) && blip.rotate();
  const down = () => {
    st.current.acc = 0;
    update(softDrop(st.current.game));
  };
  const drop = () => {
    st.current.acc = 0;
    update(hardDrop(st.current.game));
  };
  /** A touch button or the board was pressed: play it, or first get the game going. */
  const pad = (fn: () => void) => () => (st.current.status === 'playing' ? fn() : start());

  useGameKeys((e) => {
    const playing = st.current.status === 'playing';
    const dir = arrowOf(e.code);
    if (isStartKey(e.code)) {
      if (e.repeat) return true;
      if (!playing) start();
      else if (e.code === 'Space') drop();
      else pause();
      return true;
    }
    if (dir) {
      if (!playing) return true;
      if (dir === 'left' || dir === 'right') shift(dir === 'left' ? -1 : 1);
      else if (dir === 'down') down();
      else if (!e.repeat) turn(1);
      return true;
    }
    if (e.code === 'KeyZ' || e.code === 'KeyQ' || e.code === 'KeyX') {
      if (playing && !e.repeat) turn(e.code === 'KeyX' ? 1 : -1);
      return true;
    }
    return false;
  });
  useOnAway(pause);

  const frame = (ctx: CanvasRenderingContext2D, dt: number, now: number) => {
    const s = st.current;
    if (s.status === 'playing') {
      s.acc += dt * 1000;
      const every = dropMs(s.game.level);
      while (s.acc >= every && s.status === 'playing') {
        s.acc -= every;
        update(tick(s.game));
      }
    }
    const g = s.game;
    ctx.save();
    if (s.shake > 0) {
      s.shake -= dt;
      ctx.translate((Math.random() - 0.5) * 6 * s.shake * 3, (Math.random() - 0.5) * 6 * s.shake * 3);
    }

    // the board: a dark-screen well with a faint grid
    card(ctx, BX - 3, BY - 3, BW + 6, BH + 6, WELL, 9, WELL);
    ctx.strokeStyle = 'rgba(170,191,213,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) {
      ctx.moveTo(BX + x * C, BY);
      ctx.lineTo(BX + x * C, BY + BH);
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.moveTo(BX, BY + y * C);
      ctx.lineTo(BX + BW, BY + y * C);
    }
    ctx.stroke();

    g.board.forEach((row, y) => row.forEach((c, x) => c && toonBlock(ctx, BX + x * C, BY + y * C, C, C, COLOR[c], 4.5)));

    if (!g.over) {
      // where it will land
      const d = dropDistance(g);
      ctx.setLineDash([3, 3]);
      for (const [x, y] of pieceCells({ ...g.piece, y: g.piece.y + d })) {
        if (y < 0) continue;
        ctx.beginPath();
        ctx.roundRect(BX + x * C + 2, BY + y * C + 2, C - 4, C - 4, 4);
        ctx.fillStyle = `${COLOR[g.piece.type]}44`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(234,240,246,0.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // the falling piece, with a face on its middle block looking where it's going
      const cells = pieceCells(g.piece);
      ctx.save();
      ctx.beginPath();
      ctx.rect(BX - 2, BY, BW + 4, BH + 4);
      ctx.clip();
      for (const [x, y] of cells) toonBlock(ctx, BX + x * C, BY + y * C, C, C, COLOR[g.piece.type], 4.5);
      const cx = cells.reduce((a, [x]) => a + x, 0) / cells.length;
      const cy = cells.reduce((a, [, y]) => a + y, 0) / cells.length;
      const [fx, fy] = cells.reduce((best, c) => (Math.hypot(c[0] - cx, c[1] - cy) < Math.hypot(best[0] - cx, best[1] - cy) ? c : best));
      if (fy >= 0) eyes(ctx, BX + fx * C + C / 2, BY + fy * C + C / 2 - 1, 8, 2.7, s.lastDx, 0.6, Math.floor(now / 180) % 22 === 0);
      ctx.restore();
    }

    // cleared-row flashes
    s.flash = s.flash.filter((f) => (f.t -= dt) > 0);
    for (const f of s.flash) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, f.t * 3)})`;
      ctx.fillRect(BX, BY + f.y * C, BW, C);
    }
    ctx.restore();

    // side panel: what's next and the numbers
    card(ctx, SIDE, BY, 92, 110);
    text(ctx, 'NEXT', SIDE + 46, BY + 13, 10, MUTED, 600, 'center', MONO);
    g.queue.slice(0, 3).forEach((t, i) => {
      const size = i === 0 ? 14 : 9;
      const cells = previewCells(t);
      const xs = cells.map(([x]) => x);
      const ys = cells.map(([, y]) => y);
      const w = (Math.max(...xs) - Math.min(...xs) + 1) * size;
      const h = (Math.max(...ys) - Math.min(...ys) + 1) * size;
      const ox = i === 0 ? SIDE + 46 - w / 2 : SIDE + (i === 1 ? 24 : 68) - w / 2;
      const oy = i === 0 ? BY + 44 - h / 2 : BY + 90 - h / 2;
      for (const [x, y] of cells) toonBlock(ctx, ox + (x - Math.min(...xs)) * size, oy + (y - Math.min(...ys)) * size, size, size, COLOR[t], size * 0.25, i === 0 ? 2 : 1.5);
    });
    const stat = (label: string, value: string, y: number, color = INK) => {
      card(ctx, SIDE, y, 92, 46);
      text(ctx, label, SIDE + 46, y + 13, 9, MUTED, 600, 'center', MONO);
      text(ctx, value, SIDE + 46, y + 31, 16, color, 600, 'center', MONO);
    };
    stat('SCORE', g.score.toLocaleString(), BY + 122);
    stat('LINES', String(g.lines), BY + 178);
    stat('LEVEL', String(g.level), BY + 234);
    stat('BEST', Math.max(s.best, g.score).toLocaleString(), BY + 290, g.score > s.best ? '#3D6B54' : INK);

    drawParticles(ctx, s.particles, dt);

    if (s.status !== 'playing') {
      const hint = s.status === 'ready' ? 'Space or tap to start' : s.status === 'paused' ? 'Space or tap to resume' : 'Space or tap to play again';
      if (s.status === 'ready') messageCard(ctx, W, H, 'Cubetris', ['Stack the blocks.', 'Fill a row to ship it!', hint], TETRIS_COLOR);
      else if (s.status === 'paused') messageCard(ctx, W, H, 'Coffee break ☕', [`Score ${g.score.toLocaleString()}`, hint], TETRIS_COLOR);
      else messageCard(ctx, W, H, 'Stack overflow!', [`Score ${g.score.toLocaleString()}`, s.newBest ? '🏆 New best!' : `Best ${s.best.toLocaleString()}`, hint], '#C25B54');
    } else if (g.score === 0 && g.locks === 0) {
      outlinedText(ctx, 'Go!', BX + BW / 2, BY + BH / 2, 30 + Math.sin(now / 120) * 2, '#7FC4A0');
    }
  };

  return (
    <div className="game">
      <GameHeader title="Cubetris" color={TETRIS_COLOR} onBack={onBack}>
        <button type="button" className="game-mini" tabIndex={-1} onPointerDown={(e) => e.preventDefault()} onClick={() => (status === 'playing' ? pause() : start())} title={status === 'playing' ? 'Pause (Enter)' : 'Play (Space)'}>
          {status === 'playing' ? '⏸' : '▶'}
        </button>
      </GameHeader>
      <GameCanvas width={W} height={H} frame={frame} label="Cubetris board" onPointer={(kind) => kind === 'down' && pad(() => turn(1))()} />
      <div className="game-pads">
        <PadButton label="Move left" repeat onPress={pad(() => shift(-1))}>
          ◀
        </PadButton>
        <PadButton label="Soft drop" repeat onPress={pad(down)}>
          ▼
        </PadButton>
        <PadButton label="Move right" repeat onPress={pad(() => shift(1))}>
          ▶
        </PadButton>
        <span className="game-pad-gap" />
        <PadButton label="Rotate" className="game-pad-round" onPress={pad(() => turn(1))}>
          ⟳
        </PadButton>
        <PadButton label="Drop" className="game-pad-round game-pad-hot" onPress={pad(drop)}>
          ⤓
        </PadButton>
      </div>
      <div className="game-keys">
        <kbd>←</kbd>
        <kbd>→</kbd> move · <kbd>↑</kbd> turn · <kbd>↓</kbd> down · <kbd>Space</kbd> drop · <kbd>Enter</kbd> pause
      </div>
    </div>
  );
}
