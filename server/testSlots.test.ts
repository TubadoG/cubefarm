import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isHeavyTestCommand, TEST_SLOT_SCRIPT, wrapHeavyCommand } from './testSlots.ts';

const script = path.resolve(import.meta.dirname, '../scripts/test-slot.sh');
const hasFlock = spawnSync('flock', ['--version']).status === 0;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const dirs: string[] = [];
const children: ChildProcess[] = [];

describe('heavy test commands', () => {
  it.each([
    'docker compose up', 'docker-compose up', 'docker compose run tests',
    'docker compose up -d --wait postgres seaweedfs', 'pytest -q', 'uv run pytest', 'python -m pytest', 'python3 -m pytest',
    'vitest run', 'npx vitest', 'npx vitest run', 'npm test', 'npm run test', 'pnpm test', 'yarn test',
    'npx playwright test', 'playwright test', 'make test', 'npx eslint .', 'npm run lint',
    'tsc --noEmit', 'npx tsc --noEmit -p tsconfig.json', 'npm run typecheck', 'npm run build', 'next build', 'vite build',
    'cd app && uv run pytest -q', 'git status; npm test', 'pytest | tee output', 'pwd\nnpm test', 'CI=1 npm test',
  ])('wraps %s', (command) => {
    expect(isHeavyTestCommand(command)).toBe(true);
    expect(wrapHeavyCommand(command)).toBe(`${TEST_SLOT_SCRIPT} ${quote(command)}`);
    expect(wrapHeavyCommand(wrapHeavyCommand(command))).toBe(wrapHeavyCommand(command));
  });

  it.each([
    'git status', 'docker compose down -v', 'docker compose ps', 'docker compose logs', 'docker-compose down',
    'cat package.json', 'ls', 'grep pytest README.md', 'rg "npm test"', 'echo "hello; pytest"', "git commit -m 'npm test'",
    'npx vitest --watch', 'vitest run --watch', 'npx vitest -w', 'vitest', 'npm run dev', '',
  ])('leaves %s unchanged', (command) => {
    expect(isHeavyTestCommand(command)).toBe(false);
    expect(wrapHeavyCommand(command)).toBe(command);
  });

  it('preserves single and double quotes as one shell argument', () => {
    const command = `pytest -k 'one or two' --override-ini="name=quoted"`;
    const wrapped = wrapHeavyCommand(command);
    const argument = wrapped.slice(TEST_SLOT_SCRIPT.length + 1);
    const result = spawnSync('bash', ['-c', `printf '%s' ${argument}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(command);
  });
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-slots-'));
  dirs.push(dir);
  return dir;
}

function run(dir: string, command: string, slots = '2') {
  const child = spawn(script, [command], { env: { ...process.env, SWARM_TEST_SLOTS: slots, SWARM_TEST_SLOT_DIR: dir } });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { child, done, stderr: () => stderr };
}

async function waitFor(file: string) {
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('test-slot.sh', () => {
  it.skipIf(!hasFlock)('queues a third command until one of two holders finishes', async () => {
    const dir = tempDir();
    const command = (id: number) => `${quote(process.execPath)} -e ${quote(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(dir, `${id}-start`))}, String(Date.now())); setTimeout(() => fs.writeFileSync(${JSON.stringify(path.join(dir, `${id}-end`))}, String(Date.now())), 1000);`)}`;
    const first = run(dir, command(1));
    const second = run(dir, command(2));
    await Promise.all([waitFor(path.join(dir, '1-start')), waitFor(path.join(dir, '2-start'))]);
    const third = run(dir, command(3));
    expect(await Promise.all([first.done, second.done, third.done])).toEqual([0, 0, 0]);
    const timestamp = (file: string) => Number(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(timestamp('3-start')).toBeGreaterThanOrEqual(Math.min(timestamp('1-end'), timestamp('2-end')));
    expect(third.stderr().match(/waiting for a free test slot/g)).toHaveLength(1);
  }, 10_000);

  it.skipIf(!hasFlock)('preserves a failure exit code and immediately frees the slot', async () => {
    const dir = tempDir();
    expect(await run(dir, 'exit 3', '1').done).toBe(3);
    const next = run(dir, 'true', '1');
    expect(await next.done).toBe(0);
    expect(next.stderr()).not.toContain('waiting');
  });

  it.skipIf(!hasFlock)('releases the slot when its holder is killed with SIGKILL', async () => {
    const dir = tempDir();
    const ready = path.join(dir, 'ready');
    const holder = run(dir, `touch ${quote(ready)}; exec sleep 60`, '1');
    await waitFor(ready);
    holder.child.kill('SIGKILL');
    await holder.done;
    const next = run(dir, 'true', '1');
    expect(await next.done).toBe(0);
    expect(next.stderr()).not.toContain('waiting');
  });
});
