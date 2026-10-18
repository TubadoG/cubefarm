import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './games.css';
import { useGameKeys } from './kit';
import { INK, eyes, toonBlock } from './paint';
import { STAGES, advance, mood, stage } from './pet';
import { getPet, subscribePet } from './petStore';
import { PET_COLOR, Pet, drawDeliveryBox, drawPetFigure } from './PetGame';
import { SNAKE_COLOR, Snake, snakeInProgress } from './SnakeGame';
import { TETRIS_COLOR, Tetris, tetrisInProgress } from './TetrisGame';
import { bestScore } from './storage';

// The phone's Games app: a little launcher for Cubetris, Cable Snake and Desk Pet, something to do while the
// team works. Backspace goes back to the list from a game.

export type GameId = 'tetris' | 'snake' | 'pet';

/** A small canvas icon, drawn once in the games' own style. */
function Thumb({ draw }: { draw: (ctx: CanvasRenderingContext2D) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = 56 * dpr;
    cv.height = 56 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx);
  }, [draw]);
  return <canvas ref={ref} className="game-thumb" style={{ width: 56, height: 56 }} aria-hidden />;
}

const drawTetrisThumb = (ctx: CanvasRenderingContext2D) => {
  // a T dropping onto a square and an L
  const s = 13;
  const block = (x: number, y: number, c: string) => toonBlock(ctx, 2 + x * s, 2 + y * s, s, s, c, 3.5, 1.8);
  const pieces: [string, number[][]][] = [
    ['#E2C26E', [[0, 2], [1, 2], [0, 3], [1, 3]]],
    ['#D4B483', [[3, 1], [3, 2], [3, 3], [2, 3]]],
    ['#9C8FC4', [[0, 0], [1, 0], [2, 0], [1, 1]]],
  ];
  for (const [c, cells] of pieces) for (const [x, y] of cells) block(x, y, c);
  eyes(ctx, 2 + 1.5 * s, 2 + 0.5 * s, 7, 2.4, 0, 0.5);
};

const drawSnakeThumb = (ctx: CanvasRenderingContext2D) => {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(8, 48);
  ctx.lineTo(8, 34);
  ctx.lineTo(28, 34);
  ctx.lineTo(28, 16);
  ctx.lineTo(36, 16);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 11;
  ctx.stroke();
  ctx.strokeStyle = '#7FC4A0';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(33, 9, 14, 14, 3);
  ctx.fillStyle = '#EAF0F6';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = '#D4B483';
  for (let i = 0; i < 3; i++) ctx.fillRect(44, 11 + i * 3.6, 2.5, 1.8);
  eyes(ctx, 39, 15, 6, 2.4, 1, 0);
  ctx.beginPath();
  ctx.ellipse(46, 44, 5, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#E07A72';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(46, 38, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
};

function Card({ icon, name, what, status, color, onOpen }: { icon: (ctx: CanvasRenderingContext2D) => void; name: string; what: string; status: string; color: string; onOpen: () => void }) {
  return (
    <button type="button" className="game-card" style={{ ['--game' as string]: color }} onClick={onOpen}>
      <Thumb draw={icon} />
      <span className="game-card-text">
        <b>{name}</b>
        <span className="game-card-what">{what}</span>
        <span className="game-card-status">{status}</span>
      </span>
      <span className="game-card-go">▶</span>
    </button>
  );
}

function Launcher({ onGame }: { onGame: (g: GameId) => void }) {
  const pet = useSyncExternalStore(subscribePet, getPet);
  const [now] = useState(Date.now);
  const view = pet ? advance(pet, now) : null;
  const petIcon = (ctx: CanvasRenderingContext2D) => {
    ctx.translate(28, 50);
    if (view) drawPetFigure(ctx, { size: 38, color: view.color, mood: mood(view), stage: stage(view.xp), blink: false });
    else drawDeliveryBox(ctx, 0.6);
  };
  const best = (g: 'tetris' | 'snake') => (bestScore(g) ? `Best ${bestScore(g).toLocaleString()}` : 'No best score yet');
  const moodText: Record<string, string> = { asleep: 'is napping', happy: 'is thrilled', content: 'is doing fine', hungry: 'is hungry', bored: 'is bored', tired: 'is sleepy', grumpy: 'is grumpy, needs you' };

  useGameKeys((e) => {
    const n = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (n < 0 || e.repeat) return false;
    onGame((['tetris', 'snake', 'pet'] as const)[n]);
    return true;
  });

  return (
    <div className="phone-scroll games-list">
      <h3 className="phone-h">🎮 Games</h3>
      <p className="muted small games-blurb">Something to do while the team works. They pause when you put the phone away.</p>
      <Card icon={drawTetrisThumb} name="Cubetris" what="Falling blocks (a Tetris clone)" status={tetrisInProgress() ? '⏸ Game paused, tap to resume' : best('tetris')} color={TETRIS_COLOR} onOpen={() => onGame('tetris')} />
      <Card icon={drawSnakeThumb} name="Cable Snake" what="Eat the bugs (a Snake clone)" status={snakeInProgress() ? '⏸ Game paused, tap to resume' : best('snake')} color={SNAKE_COLOR} onOpen={() => onGame('snake')} />
      <Card
        icon={petIcon}
        name="Desk Pet"
        what="Your office pet (a Tamagotchi clone)"
        status={view ? `${view.name} the ${STAGES[stage(view.xp)].title.toLowerCase()} ${moodText[mood(view)]}` : '📦 A delivery is waiting for you'}
        color={PET_COLOR}
        onOpen={() => onGame('pet')}
      />
      <p className="muted small games-blurb">
        <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> open a game · <kbd>Backspace</kbd> comes back here
      </p>
    </div>
  );
}

export function Games({ game, onGame }: { game: GameId | null; onGame: (g: GameId | null) => void }) {
  useGameKeys((e) => {
    if (!game || e.code !== 'Backspace') return false;
    onGame(null);
    return true;
  });
  const back = () => onGame(null);
  if (game === 'tetris') return <Tetris onBack={back} />;
  if (game === 'snake') return <Snake onBack={back} />;
  if (game === 'pet') return <Pet onBack={back} />;
  return <Launcher onGame={onGame} />;
}
