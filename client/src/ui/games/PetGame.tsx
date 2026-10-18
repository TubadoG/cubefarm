import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GameCanvas, GameHeader, isStartKey, useGameKeys } from './kit';
import { FLOOR, INK, burst, drawParticles, eyes, outlinedText, shade, text, toonBlock, type Particle } from './paint';
import { MOOD_LINES, STAGES, act, advance, hatch, mood, stage, type Mood, type PetAction, type PetState } from './pet';
import { getPet, setPet, subscribePet } from './petStore';
import { blip } from './sounds';

// Desk Pet on the phone: a little cube creature living on a cubicle desk. Feed it, give it coffee, play with it and
// let it nap; it grows up (Intern to Tech Lead) the more you look after it, and cheers when the team ships.

export const PET_COLOR = '#B4A7D6';

const W = 320;
const H = 260;
const DESK_Y = 212;
const SIZES = [52, 60, 68, 74];
const ANIM_LEN = 1.4;

type Anim = { kind: PetAction | 'cheer' | 'hatch' | 'jitter' | 'wake'; t: number };

// When the pet screen was last closed, so it can recap what happened while you were away.
let lastShown = Date.now();

const ACTIONS: { action: PetAction; icon: string; label: string; key: string }[] = [
  { action: 'snack', icon: '🍩', label: 'Snack', key: '1' },
  { action: 'coffee', icon: '☕', label: 'Coffee', key: '2' },
  { action: 'play', icon: '🎾', label: 'Play', key: '3' },
  { action: 'nap', icon: '💤', label: 'Nap', key: '4' },
];

export interface Figure {
  size: number;
  color: string;
  mood: Mood;
  stage: number;
  blink: boolean;
  /** Mouth open (eating). */
  open?: boolean;
  /** Arms up (cheering, playing). */
  arms?: boolean;
}

/** The pet itself, standing with its feet at (0, 0): a toon cube with a face, dressed for its job title. */
export function drawPetFigure(ctx: CanvasRenderingContext2D, f: Figure) {
  const s = f.size;
  const top = -s;
  const lw = Math.max(2, s / 22);
  const dark = shade(f.color, -0.3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgba(27,39,50,0.16)';
  ctx.beginPath();
  ctx.ellipse(0, 2, s * 0.46, s * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  // feet and arms, behind the body
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * s * 0.22, -3, s * 0.14, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    if (f.arms) ctx.ellipse(side * s * 0.52, top + s * 0.3, s * 0.09, s * 0.15, side * 0.5, 0, Math.PI * 2);
    else ctx.ellipse(side * s * 0.5, top + s * 0.62, s * 0.09, s * 0.14, -side * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.stroke();
  }
  toonBlock(ctx, -s / 2, top, s, s - 4, f.color, s * 0.3, lw * 1.3);

  // the face
  const ey = top + s * 0.4;
  const gap = s * 0.36;
  const r = s * 0.1;
  const asleep = f.mood === 'asleep';
  eyes(ctx, 0, ey, gap, r, 0, f.mood === 'hungry' ? 0.5 : 0.1, asleep || f.blink);
  if (f.mood === 'tired' && !f.blink) {
    // heavy lids
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse((side * gap) / 2, ey, r * 1.12, r * 1.3, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = shade(f.color, -0.08);
      ctx.fill();
      ctx.lineWidth = lw * 0.8;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.moveTo((side * gap) / 2 - r * 1.1, ey);
      ctx.lineTo((side * gap) / 2 + r * 1.1, ey);
      ctx.stroke();
    }
  }
  if (f.mood === 'grumpy') {
    ctx.lineWidth = lw * 1.1;
    ctx.strokeStyle = INK;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * (gap / 2 + r * 1.2), ey - r * 2);
      ctx.lineTo(side * (gap / 2 - r * 0.9), ey - r * 1.3);
      ctx.stroke();
    }
  }
  if (f.stage >= 2) {
    // glasses
    ctx.lineWidth = lw * 0.9;
    ctx.strokeStyle = INK;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect((side * gap) / 2 - r * 1.6, ey - r * 1.5, r * 3.2, r * 3, r * 0.6);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-gap / 2 + r * 1.6, ey - r * 0.4);
    ctx.lineTo(gap / 2 - r * 1.6, ey - r * 0.4);
    ctx.stroke();
  }
  // cheeks
  ctx.fillStyle = 'rgba(255,111,181,0.45)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * s * 0.3, top + s * 0.58, s * 0.075, s * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // mouth
  const my = top + s * 0.62;
  const mw = s * 0.12;
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.beginPath();
  if (f.open || f.mood === 'hungry') {
    ctx.ellipse(0, my + 1, mw * 0.55, mw * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (f.mood === 'happy') {
    ctx.arc(0, my - 1, mw, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, my + mw * 0.55, mw * 0.5, mw * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ff8fa3';
    ctx.fill();
  } else if (f.mood === 'content') {
    ctx.arc(0, my - mw * 0.6, mw, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  } else if (f.mood === 'grumpy') {
    ctx.arc(0, my + mw * 0.9, mw, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();
  } else if (f.mood === 'asleep') {
    ctx.ellipse(0, my + 1, mw * 0.3, mw * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (f.mood === 'tired') {
    ctx.moveTo(-mw, my + 1);
    ctx.quadraticCurveTo(-mw / 2, my - 2, 0, my + 1);
    ctx.quadraticCurveTo(mw / 2, my + 4, mw, my + 1);
    ctx.stroke();
  } else {
    ctx.moveTo(-mw * 0.8, my + 1);
    ctx.lineTo(mw * 0.8, my + 1);
    ctx.stroke();
  }

  // dressed for the job
  const chest = top + s * 0.76;
  if (f.stage === 0) {
    // an intern's visitor badge on a lanyard
    ctx.strokeStyle = '#6699CC';
    ctx.lineWidth = lw * 0.9;
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, top + s * 0.7);
    ctx.lineTo(0, chest + s * 0.02);
    ctx.lineTo(s * 0.2, top + s * 0.7);
    ctx.stroke();
    toonBlock(ctx, -s * 0.09, chest, s * 0.18, s * 0.14, '#ffffff', s * 0.03, lw * 0.8);
    ctx.fillStyle = '#6699CC';
    ctx.fillRect(-s * 0.06, chest + s * 0.04, s * 0.12, s * 0.025);
  } else {
    // a tie
    ctx.beginPath();
    ctx.moveTo(-s * 0.05, chest - s * 0.04);
    ctx.lineTo(s * 0.05, chest - s * 0.04);
    ctx.lineTo(s * 0.035, chest + s * 0.02);
    ctx.lineTo(s * 0.065, chest + s * 0.15);
    ctx.lineTo(0, chest + s * 0.2);
    ctx.lineTo(-s * 0.065, chest + s * 0.15);
    ctx.lineTo(-s * 0.035, chest + s * 0.02);
    ctx.closePath();
    ctx.fillStyle = f.color === '#f25f5c' || f.color === '#ff6fb5' ? '#26394D' : '#f25f5c';
    ctx.fill();
    ctx.lineWidth = lw * 0.8;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  if (f.stage >= 3) {
    // a tech lead's headset
    ctx.lineWidth = lw * 1.4;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(0, top + s * 0.4, s * 0.53, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
    for (const side of [-1, 1]) toonBlock(ctx, side * s * 0.52 - s * 0.08, top + s * 0.28, s * 0.16, s * 0.24, '#26394D', s * 0.05, lw * 0.8);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(-s * 0.52, top + s * 0.5);
    ctx.quadraticCurveTo(-s * 0.4, my + s * 0.08, -mw * 1.6, my + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-mw * 1.6, my + 2, lw * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  }
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function drawDonut(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, bitten = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, bitten * Math.PI * 1.5, Math.PI * 2);
  ctx.arc(0, 0, r * 0.38, Math.PI * 2, bitten * Math.PI * 1.5, true);
  ctx.closePath();
  ctx.fillStyle = '#e0ac69';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.78, bitten * Math.PI * 1.5, Math.PI * 2);
  ctx.arc(0, 0, r * 0.45, Math.PI * 2, bitten * Math.PI * 1.5, true);
  ctx.fillStyle = '#ff8fc7';
  ctx.fill();
  ['#4fb3e8', '#ffc93c', '#8fd14f', '#ffffff'].forEach((c, i) => {
    const a = i * 1.7 + 0.4;
    if (a / (Math.PI * 2) < bitten * 0.75) return;
    ctx.fillStyle = c;
    ctx.fillRect(Math.cos(a) * r * 0.62 - 1.5, Math.sin(a) * r * 0.62 - 1, 3, 2);
  });
  ctx.restore();
}

function drawMug(ctx: CanvasRenderingContext2D, x: number, y: number, now: number) {
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(x + 9, y + 8, 5, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  toonBlock(ctx, x - 9, y, 18, 18, '#ffffff', 4, 2);
  ctx.beginPath();
  ctx.ellipse(x, y + 3, 6.5, 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#8d5524';
  ctx.fill();
  ctx.strokeStyle = 'rgba(31,29,43,0.45)';
  ctx.lineWidth = 1.5;
  for (const sx of [-3, 3]) {
    const t = (now / 600 + sx / 7) % 1;
    ctx.globalAlpha = 1 - t;
    ctx.beginPath();
    ctx.moveTo(x + sx, y - 3 - t * 10);
    ctx.quadraticCurveTo(x + sx + 3, y - 6 - t * 10, x + sx, y - 9 - t * 10);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Its little cubicle: fabric wall, a pinboard, employee of the month, a desk with a monitor and a plant. */
function drawCubicle(ctx: CanvasRenderingContext2D, now: number, star: boolean) {
  ctx.fillStyle = '#DCE3EA';
  ctx.fillRect(0, 0, W, DESK_Y);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  for (let x = 6; x < W; x += 12) ctx.fillRect(x, 12, 1.5, DESK_Y - 12);
  ctx.fillStyle = '#AABFD5';
  ctx.fillRect(0, 0, W, 12);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 12, W, 2);

  // pinboard with sticky notes
  toonBlock(ctx, 16, 58, 76, 52, '#d9a066', 6, 2);
  const notes: [number, number, string, number][] = [
    [24, 66, '#FFFFFF', -0.08],
    [56, 70, '#DDE8F4', 0.1],
  ];
  for (const [x, y, c, rot] of notes) {
    ctx.save();
    ctx.translate(x + 13, y + 13);
    ctx.rotate(rot);
    ctx.fillStyle = c;
    ctx.fillRect(-13, -13, 26, 26);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-13, -13, 26, 26);
    ctx.strokeStyle = 'rgba(38,57,77,0.4)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-8, -6 + i * 6);
      ctx.lineTo(8 - i * 4, -6 + i * 6);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, -11, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#E07A72';
    ctx.fill();
    ctx.restore();
  }

  // employee of the month
  toonBlock(ctx, 232, 54, 66, 60, '#ffffff', 5, 2);
  text(ctx, 'EMPLOYEE', 265, 64, 7.5, INK, 700);
  text(ctx, 'OF THE MONTH', 265, 73, 7, INK, 700);
  drawStar(ctx, 265, 93, 13, star ? '#D4B483' : '#DCE3EA');

  // the office clock, telling the real time
  const d = new Date();
  const clockX = 160;
  const clockY = 42;
  ctx.beginPath();
  ctx.arc(clockX, clockY, 17, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.lineCap = 'round';
  for (const [turns, len, width] of [
    [((d.getHours() % 12) + d.getMinutes() / 60) / 12, 8, 3],
    [(d.getMinutes() + d.getSeconds() / 60) / 60, 12, 2],
  ]) {
    const a = turns * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(clockX, clockY);
    ctx.lineTo(clockX + Math.cos(a) * len, clockY + Math.sin(a) * len);
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(clockX, clockY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#6699CC';
  ctx.fill();

  // the desk
  ctx.fillStyle = '#B9C6D3';
  ctx.fillRect(0, DESK_Y + 12, W, H - DESK_Y - 12);
  ctx.fillStyle = INK;
  ctx.fillRect(0, DESK_Y + 12, W, 2);
  toonBlock(ctx, -6, DESK_Y, W + 12, 14, '#E4E9EE', 5, 2.5);

  // monitor with code scrolling by
  toonBlock(ctx, 48, DESK_Y - 12, 18, 12, '#5C6B7A', 2, 2);
  toonBlock(ctx, 18, DESK_Y - 66, 78, 54, '#3D454D', 7, 2.5);
  ctx.fillStyle = '#1B2732';
  ctx.fillRect(25, DESK_Y - 59, 64, 40);
  const scroll = Math.floor(now / 700);
  for (let i = 0; i < 5; i++) {
    const n = scroll + i;
    ctx.fillStyle = FLOOR[(n * 3) % FLOOR.length];
    ctx.fillRect(29 + (n % 3) * 5, DESK_Y - 55 + i * 7, 14 + ((n * 17) % 30), 3);
  }

  // plant
  ctx.lineWidth = 2;
  for (const [x, y, r] of [
    [262, DESK_Y - 36, 13],
    [276, DESK_Y - 44, 11],
    [252, DESK_Y - 48, 10],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#5E9C7E';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  toonBlock(ctx, 248, DESK_Y - 26, 32, 26, '#AABFD5', 5, 2);
}

/** The box a new desk pet arrives in, standing on (0, 0). */
export function drawDeliveryBox(ctx: CanvasRenderingContext2D, scale = 1) {
  ctx.save();
  ctx.scale(scale, scale);
  toonBlock(ctx, -38, -56, 76, 56, '#d9a066', 6, 2.5);
  ctx.fillStyle = 'rgba(241,209,155,0.9)';
  ctx.fillRect(-7, -55, 14, 54);
  toonBlock(ctx, -30, -34, 38, 16, '#ffffff', 3, 1.5);
  text(ctx, 'NEW HIRE', -11, -26, 7.5, INK, 700);
  ctx.restore();
}

function thought(ctx: CanvasRenderingContext2D, x: number, y: number, draw: () => void) {
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.fillStyle = '#ffffff';
  for (const [dx, dy, r] of [
    [-16, 22, 3],
    [-10, 14, 5],
  ]) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.ellipse(x + 8, y - 4, 20, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.translate(x + 8, y - 4);
  draw();
  ctx.restore();
}

export function Pet({ onBack }: { onBack: () => void }) {
  const pet = useSyncExternalStore(subscribePet, getPet);
  const [now, setNow] = useState(Date.now());
  const anim = useRef<Anim | null>(null);
  const particles = useRef<Particle[]>([]);
  const mine = useRef(0); // when the pet last spoke because of something you did here
  const heard = useRef(pet?.say?.at ?? 0);
  const [openedAt] = useState(() => Date.now());
  // Anything it said since you last looked (a teammate finishing, say) is repeated for a few seconds.
  const [recap] = useState(() => (pet?.say && pet.say.at > lastShown && openedAt - pet.say.at > 5000 ? pet.say : null));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      lastShown = Date.now();
    };
  }, []);

  // News from the office (the pet cheered while you were watching): a little celebration.
  const sayAt = pet?.say?.at ?? 0;
  useEffect(() => {
    if (sayAt === heard.current) return;
    heard.current = sayAt;
    if (sayAt !== mine.current && Date.now() - sayAt < 3000) {
      anim.current = { kind: 'cheer', t: 0 };
      burst(particles.current, W / 2, DESK_Y - 60, FLOOR, 16, 140);
      blip.happy();
    }
  }, [sayAt]);

  const unbox = () => {
    if (getPet()) return;
    const born = hatch(Date.now(), Math.random(), Math.random());
    mine.current = born.say?.at ?? 0;
    anim.current = { kind: 'hatch', t: 0 };
    burst(particles.current, W / 2, DESK_Y - 30, ['#d9a066', '#f1d19b', ...FLOOR], 22, 170);
    blip.levelUp();
    setPet(born);
  };

  const doAction = (a: PetAction) => {
    const before = getPet();
    if (!before) return;
    const t = Date.now();
    const next = act(before, a, t);
    if (next.say?.at === t) mine.current = t;
    setPet(next);
    setNow(t);
    const did = next.xp > before.xp;
    const size = SIZES[stage(next.xp)];
    if (next.say?.text.startsWith('Promoted')) {
      blip.levelUp();
      burst(particles.current, W / 2, DESK_Y - size, FLOOR, 22, 160);
      anim.current = { kind: 'cheer', t: 0 };
      return;
    }
    switch (a) {
      case 'snack':
      case 'play':
        if (did) {
          anim.current = { kind: a, t: 0 };
          (a === 'snack' ? blip.nom : blip.boing)();
        } else if (!next.asleep) blip.grumble();
        break;
      case 'coffee':
        if (did) {
          anim.current = { kind: 'coffee', t: 0 };
          blip.slurp();
        } else if (!next.asleep) {
          anim.current = { kind: 'jitter', t: 0 };
          blip.grumble();
        }
        break;
      case 'nap':
        if (next.asleep) blip.snore();
        else if (before.asleep) {
          anim.current = { kind: 'wake', t: 0 };
          blip.happy();
        }
        break;
      case 'pet':
        if (next.pettedAt === t) {
          anim.current = { kind: 'pet', t: 0 };
          for (let i = 0; i < 3; i++) particles.current.push({ x: W / 2 + (i - 1) * 16, y: DESK_Y - size - 6, vx: (i - 1) * 14, vy: -50 - i * 8, life: 1.1, color: '#ff6fb5', size: 16 + i * 2, text: '♥' });
          blip.happy();
        }
        break;
    }
  };

  useGameKeys((e) => {
    if (e.repeat) return false;
    const hit = ACTIONS.find((x) => e.code === `Digit${x.key}` || e.code === `Numpad${x.key}`);
    if (hit) {
      doAction(hit.action);
      return true;
    }
    if (isStartKey(e.code)) {
      if (getPet()) doAction('pet');
      else unbox();
      return true;
    }
    return false;
  });

  const frame = (ctx: CanvasRenderingContext2D, dt: number, t: number) => {
    const raw = getPet();
    const p = raw ? advance(raw, Date.now()) : null;
    const m = p ? mood(p) : 'content';
    const st = p ? stage(p.xp) : 0;
    drawCubicle(ctx, t, st >= 2 || m === 'happy');
    const a = anim.current;
    if (a) {
      a.t += dt;
      if (a.t > ANIM_LEN) anim.current = null;
    }

    if (!p) {
      // a delivery box on the desk, wobbling now and then
      const wob = t % 2600 < 450 ? Math.sin(t / 45) * 0.06 : 0;
      ctx.save();
      ctx.translate(W / 2, DESK_Y + 1);
      ctx.rotate(wob);
      drawDeliveryBox(ctx);
      ctx.restore();
      outlinedText(ctx, '?', W / 2 + 34, DESK_Y - 70 + Math.sin(t / 300) * 3, 20, '#E2C26E');
    } else {
      const size = SIZES[st];
      let x = W / 2;
      let lift = 0;
      let sx = 1;
      let sy = 1;
      const breathe = Math.sin(t / (m === 'asleep' ? 900 : 450));
      sy += breathe * (m === 'asleep' ? 0.04 : 0.025);
      sx -= breathe * 0.015;
      const k = a ? a.t / ANIM_LEN : 0;
      if (a?.kind === 'play' || a?.kind === 'cheer' || a?.kind === 'wake') lift = Math.abs(Math.sin(k * Math.PI * (a.kind === 'wake' ? 1 : 4))) * (a.kind === 'wake' ? 10 : 16) * (1 - k * 0.5);
      if (a?.kind === 'coffee' || a?.kind === 'jitter') x += Math.sin(a.t * 70) * (a.kind === 'jitter' ? 2.5 : 1.2);
      if (a?.kind === 'pet') {
        const squish = Math.sin(Math.min(1, k * 3) * Math.PI) * 0.1;
        sy -= squish;
        sx += squish;
      }
      if (a?.kind === 'hatch') {
        const g = Math.min(1, k * 3);
        sx *= 0.3 + g * 0.7;
        sy *= 0.3 + g * 0.7;
      }
      ctx.save();
      ctx.translate(x, DESK_Y + 2 - lift);
      ctx.scale(sx, sy);
      const eating = a?.kind === 'snack' && k > 0.3 && Math.floor(a.t * 8) % 2 === 0;
      drawPetFigure(ctx, { size, color: p.color, mood: a?.kind === 'jitter' ? 'grumpy' : a?.kind === 'cheer' || a?.kind === 'play' ? 'happy' : m, stage: st, blink: Math.floor(t / 160) % 24 === 0, open: eating, arms: a?.kind === 'cheer' || a?.kind === 'play' });
      ctx.restore();

      const headY = DESK_Y - size - lift;
      if (a?.kind === 'snack') {
        // from the desk to just beside its mouth
        const fly = Math.min(1, k / 0.3);
        const dx = x + size * 0.2 + 60 * (1 - fly);
        const dy = DESK_Y - 10 + (12 - size * 0.38) * fly - Math.sin(fly * Math.PI) * 24;
        drawDonut(ctx, dx, dy, 10 * (1 - Math.max(0, k - 0.3) * 0.6), Math.max(0, (k - 0.3) / 0.7));
      }
      if (a?.kind === 'coffee') drawMug(ctx, x + size / 2 + 16, DESK_Y - 18, t);
      if (a?.kind === 'play') {
        const bx = W / 2 + Math.cos(k * Math.PI * 2) * 70;
        const by = DESK_Y - 16 - Math.abs(Math.sin(k * Math.PI * 5)) * 60;
        ctx.beginPath();
        ctx.arc(bx, by, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#d4f25c';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = INK;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(bx - 8, by, 7, -0.9, 0.9);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      // how it's feeling, when nothing's happening
      if (!a) {
        const bob = Math.sin(t / 400) * 2;
        if (m === 'asleep') {
          for (let i = 0; i < 3; i++) {
            const z = ((t / 1400 + i / 3) % 1);
            ctx.globalAlpha = Math.min(1, (1 - z) * 2);
            outlinedText(ctx, 'z', x + size * 0.35 + z * 26, headY - z * 34, 12 + z * 10, '#ffffff');
          }
          ctx.globalAlpha = 1;
        } else if (m === 'hungry') thought(ctx, x + size * 0.55 + 18, headY - 8 + bob, () => drawDonut(ctx, 0, 0, 9));
        else if (m === 'bored') thought(ctx, x + size * 0.55 + 18, headY - 8 + bob, () => text(ctx, '…', 0, -2, 20, INK, 700));
        else if (m === 'tired') thought(ctx, x + size * 0.55 + 18, headY - 8 + bob, () => text(ctx, '💤', 0, 0, 14, INK, 400));
        else if (m === 'grumpy') {
          // a little storm cloud
          const cx = x;
          const cy = headY - 22 + bob;
          ctx.fillStyle = '#8A96A3';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx - 12, cy, 9, 0, Math.PI * 2);
          ctx.arc(cx, cy - 5, 11, 0, Math.PI * 2);
          ctx.arc(cx + 12, cy, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fill();
          if (Math.floor(t / 250) % 6 === 0) {
            ctx.beginPath();
            ctx.moveTo(cx + 2, cy + 8);
            ctx.lineTo(cx - 3, cy + 16);
            ctx.lineTo(cx + 2, cy + 16);
            ctx.lineTo(cx - 2, cy + 24);
            ctx.strokeStyle = '#E2C26E';
            ctx.lineWidth = 2.5;
            ctx.stroke();
          }
        } else if (m === 'happy' && Math.floor(t / 900) % 3 === 0) {
          const sp = (t % 900) / 900;
          ctx.globalAlpha = Math.sin(sp * Math.PI);
          outlinedText(ctx, '✦', x - size * 0.6, headY + 10 - sp * 8, 14, '#E2C26E');
          outlinedText(ctx, '✦', x + size * 0.62, headY + 22 - sp * 6, 11, '#ffffff');
          ctx.globalAlpha = 1;
        }
      }
      if (m === 'asleep') {
        ctx.fillStyle = 'rgba(27,39,50,0.32)';
        ctx.fillRect(0, 0, W, H);
      }
    }
    drawParticles(ctx, particles.current, dt);
  };

  const onPointer = (kind: 'down' | 'move' | 'up', px: number, py: number) => {
    if (kind !== 'down') return;
    const p = getPet();
    if (!p) {
      if (Math.abs(px - W / 2) < 50 && py > DESK_Y - 70) unbox();
      return;
    }
    const size = SIZES[stage(p.xp)];
    if (Math.abs(px - W / 2) < size / 2 + 8 && py > DESK_Y - size - 12 && py < DESK_Y + 6) doAction('pet');
  };

  const view: PetState | null = pet ? advance(pet, now) : null;
  const m = view ? mood(view) : null;
  const fresh = view?.say && now - view.say.at < 20_000 ? view.say.text : null;
  const bubble = !view ? 'A delivery just arrived at your desk…' : fresh ?? (recap && now - openedAt < 10_000 ? `While you were away: ${recap.text}` : MOOD_LINES[m!]);
  const title = view ? STAGES[stage(view.xp)].title : '';
  const day = view ? Math.floor((now - view.born) / 86_400_000) + 1 : 0;
  const bars: [string, string, number, string][] = view
    ? [
        ['🍩', 'Food', view.food, 'var(--gold)'],
        ['🎾', 'Fun', view.fun, 'var(--lavender)'],
        ['⚡', 'Energy', view.energy, 'var(--sky)'],
      ]
    : [];

  return (
    <div className="game pet">
      <GameHeader title="Desk Pet" color={PET_COLOR} onBack={onBack}>
        {view && (
          <span className="game-chip" title={`${view.xp} care points`}>
            {view.name} · {title}
          </span>
        )}
      </GameHeader>
      <div className="pet-say" aria-live="polite">
        {bubble}
      </div>
      <GameCanvas width={W} height={H} frame={frame} label={view ? `${view.name}, your desk pet, is ${m}` : 'A delivery box'} onPointer={onPointer} />
      {view ? (
        <>
          <div className="pet-bars">
            {bars.map(([icon, label, v, color]) => (
              <div key={label} className={`pet-bar ${v < 25 ? 'pet-bar-low' : ''}`} title={`${label}: ${Math.round(v)}%`}>
                <span className="pet-bar-label">
                  {icon} {label}
                </span>
                <span className="pet-meter">
                  <i style={{ width: `${Math.max(2, v)}%`, background: color }} />
                </span>
              </div>
            ))}
          </div>
          <div className="pet-actions">
            {ACTIONS.map((x) => {
              const wake = x.action === 'nap' && view.asleep;
              return (
                <button key={x.action} type="button" className="btn btn-small pet-act" tabIndex={-1} onPointerDown={(e) => e.preventDefault()} onClick={() => doAction(x.action)} disabled={view.asleep && !wake} title={`${wake ? 'Wake up' : x.label} (${x.key})`}>
                  <span className="pet-act-icon">{wake ? '☀️' : x.icon}</span>
                  {wake ? 'Wake' : x.label}
                </button>
              );
            })}
          </div>
          <div className="game-keys">
            <kbd>1</kbd>–<kbd>4</kbd> care · click {view.name} (or <kbd>Space</kbd>) for a pat · day {day}
          </div>
        </>
      ) : (
        <div className="pet-actions">
          <button type="button" className="btn btn-good pet-unbox" onClick={unbox}>
            📦 Unbox your desk pet
          </button>
        </div>
      )}
    </div>
  );
}
