import path from 'node:path';

// One folder up from both the source server/ and the published dist-server/.
export const TEST_SLOT_SCRIPT = path.resolve(import.meta.dirname, '../scripts/test-slot.sh');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const scriptCommand = /^[\w/.-]+$/.test(TEST_SLOT_SCRIPT) ? TEST_SLOT_SCRIPT : shellQuote(TEST_SLOT_SCRIPT);

/** Inspect command words, keeping quoted arguments together so reads mentioning tests stay light. */
export function isHeavyTestCommand(cmd: string): boolean {
  const trimmed = cmd.trimStart();
  if ([TEST_SLOT_SCRIPT, shellQuote(TEST_SLOT_SCRIPT), `"${TEST_SLOT_SCRIPT}"`].some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))) return false;
  const tokens = cmd.match(/(?:[^\s"';&|\\]+|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;|\n&]/g) ?? [];
  let words: string[] = [];
  const heavy = () => {
    let args = words;
    if (args[0] === 'env') args = args.slice(1);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? '')) args = args.slice(1);
    if (args[0] === 'npx') args = args.slice(1);
    const [bin, sub, ...rest] = args;
    const name = path.basename(bin ?? '');
    if (name === 'pytest' || (name === 'uv' && sub === 'run' && rest[0] === 'pytest')) return true;
    if (/^python(?:\d+(?:\.\d+)?)?$/.test(name) && sub === '-m' && rest[0] === 'pytest') return true;
    if (name === 'docker' && sub === 'compose') return rest[0] === 'up' || rest[0] === 'run';
    if (name === 'docker-compose') return sub === 'up' || sub === 'run';
    if (name === 'vitest') return !args.some((arg) => /^--watch(?:=|$)|^-w$/.test(arg)) && (sub === 'run' || words.includes('npx'));
    if (['npm', 'pnpm', 'yarn'].includes(name) && sub === 'test') return true;
    if (name === 'npm' && sub === 'run') return ['test', 'lint', 'typecheck', 'build'].includes(rest[0]);
    if (name === 'playwright' || name === 'make') return sub === 'test';
    if (name === 'eslint') return sub === '.';
    if (name === 'tsc') return args.includes('--noEmit');
    return (name === 'next' || name === 'vite') && sub === 'build';
  };
  for (const token of [...tokens, ';']) {
    if (/^(?:&&|\|\||[;|\n&])$/.test(token)) {
      if (heavy()) return true;
      words = [];
    } else {
      words.push(token.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g, (_match, double: string | undefined, single: string | undefined, escaped: string | undefined) => double?.replace(/\\(["\\$`])/g, '$1') ?? single ?? escaped ?? ''));
    }
  }
  return false;
}

export function wrapHeavyCommand(cmd: string): string {
  return isHeavyTestCommand(cmd) ? `${scriptCommand} ${shellQuote(cmd)}` : cmd;
}
