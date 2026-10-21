import { describe, expect, it } from 'vitest';
import { holdReason, matchesHold, MAX_HOLD_PATHS, parseHoldPaths } from './holds.ts';

describe('matchesHold', () => {
  it('matches a name without a slash at any depth', () => {
    expect(matchesHold('package.json', 'package.json')).toBe(true);
    expect(matchesHold('package.json', 'apps/web/package.json')).toBe(true);
    expect(matchesHold('*.sql', 'db/migrations/0007_add_index.sql')).toBe(true);
    expect(matchesHold('*.sql', 'db/schema.sqlite')).toBe(false);
  });

  it('anchors a pattern with a slash to the repo root, and covers what is under a folder', () => {
    expect(matchesHold('migrations/', 'migrations/001.sql')).toBe(true);
    expect(matchesHold('server/payments', 'server/payments/stripe.ts')).toBe(true);
    expect(matchesHold('server/payments', 'lib/server/payments/stripe.ts')).toBe(false);
    expect(matchesHold('/README.md', 'README.md')).toBe(true);
    expect(matchesHold('/README.md', 'docs/README.md')).toBe(false);
  });

  it('keeps * and ? within one folder, and lets ** cross folders', () => {
    expect(matchesHold('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesHold('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(matchesHold('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesHold('src/**/*.ts', 'src/deep/er/a.ts')).toBe(true);
    expect(matchesHold('.github/**', '.github/workflows/ci.yml')).toBe(true);
    expect(matchesHold('v?.txt', 'v1.txt')).toBe(true);
    expect(matchesHold('v?.txt', 'v10.txt')).toBe(false);
  });

  it('treats regex characters literally and accepts Windows separators', () => {
    expect(matchesHold('a+b(1).ts', 'a+b(1).ts')).toBe(true);
    expect(matchesHold('a.ts', 'abts')).toBe(false);
    expect(matchesHold('server\\payments', 'server\\payments\\x.ts')).toBe(true);
  });
});

describe('holdReason', () => {
  const files = ['src/app.ts', 'db/migrations/0007.sql', 'package.json'];

  it('holds a labelled PR, whatever it changes', () => {
    expect(holdReason(['bug', 'swarm:hold'], null, [])).toBe('label swarm:hold');
    expect(holdReason(['SWARM:HOLD'], files, ['nothing/'])).toBe('label swarm:hold');
  });

  it('names the first changed file that matches a pattern', () => {
    expect(holdReason([], files, ['package.json', 'migrations/', '**/migrations/**'])).toBe('db/migrations/0007.sql');
  });

  it('lets everything else merge', () => {
    expect(holdReason([], files, ['infra/'])).toBeNull();
    expect(holdReason(undefined, files, [])).toBeNull();
    expect(holdReason(['bug'], null, ['infra/'])).toBeNull();
  });
});

describe('parseHoldPaths', () => {
  it('trims and drops repeats', () => {
    expect(parseHoldPaths([' migrations/ ', 'migrations/', '*.sql'])).toEqual(['migrations/', '*.sql']);
  });

  it('refuses anything but a list of non-empty strings within the limits', () => {
    expect(() => parseHoldPaths('migrations/')).toThrow(/array/);
    expect(() => parseHoldPaths(['ok', 3])).toThrow(/array/);
    expect(() => parseHoldPaths(['ok', '  '])).toThrow(/non-empty/);
    expect(() => parseHoldPaths(Array.from({ length: MAX_HOLD_PATHS + 1 }, (_, i) => `p${i}`))).toThrow(/At most/);
    expect(() => parseHoldPaths(['x'.repeat(201)])).toThrow(/too long/);
    expect(parseHoldPaths([])).toEqual([]);
  });
});
