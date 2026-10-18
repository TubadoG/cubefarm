import * as THREE from 'three';
import { useStore } from '../store';
import { useKeyName } from '../ui/controls';
import { roundRect, SANS } from './draw';
import { useCanvasTexture, useInteractable } from './interact';
import { HALF_D } from './layout';
import { Box } from './Toon';

// The lobby's time-lapse screen, on the south wall between the basketball hoop and the elevator: E opens the
// manager's console on its Time-lapse tab, to replay a day or catch up on what happened while you were away.

const AT: [number, number, number] = [-5.8, 1.75, HALF_D - 0.03];
const W = 2.2;
const H = 1.25;
const PX: [number, number] = [704, 400];

function drawScreen(ctx: CanvasRenderingContext2D, replaying: boolean, use: string) {
  const [w, h] = PX;
  ctx.fillStyle = '#26394D';
  ctx.fillRect(0, 0, w, h);
  // a strip of film along the top and bottom
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let x = 18; x < w; x += 44) {
    roundRect(ctx, x, 14, 24, 16, 4);
    ctx.fill();
    roundRect(ctx, x, h - 30, 24, 16, 4);
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 64px ${SANS}`;
  ctx.fillText('📼 Time-lapse', 40, 102);
  ctx.fillStyle = '#EAF0F6';
  ctx.font = `400 34px ${SANS}`;
  ctx.fillText('What happened while', 40, 180);
  ctx.fillText('you were away?', 40, 222);
  ctx.fillStyle = replaying ? '#E07A72' : '#8FB5DD';
  ctx.font = `700 32px ${SANS}`;
  ctx.fillText(replaying ? '▶ REPLAY · Esc for live' : `Press ${use} to replay the day`, 40, 306);
}

export function TimeLapseScreen() {
  const replaying = useStore((s) => s.replaying);
  const use = useKeyName('interact');
  const ref = useInteractable<THREE.Group>({ id: 'timelapse', label: 'Time-lapse: replay the office’s day', action: { kind: 'manager', tab: 'timelapse' } }, 4);
  const tex = useCanvasTexture(PX[0], PX[1], (ctx) => drawScreen(ctx, replaying, use), [replaying, use]);
  return (
    <group ref={ref} position={AT} rotation={[0, Math.PI, 0]}>
      <Box size={[W + 0.14, H + 0.14, 0.06]} position={[0, 0, -0.04]} color="#1B2732" outline shadow={false} />
      <mesh position={[0, 0, 0.002]}>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}
