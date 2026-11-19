import { describe, expect, it } from 'vitest';
import { resultTokens } from './agentRunner.ts';

// A session's tokens from the SDK's result messages, for its timesheet (docs/kimai.md).
describe('resultTokens', () => {
  const model = (input: number, output: number, cacheWrite: number, cacheRead: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
  });

  it('adds up every model the session called, subagents included', () => {
    expect(resultTokens({ usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'claude-opus-5-5': model(4_000, 30_000, 700_000, 12_000_000), 'claude-haiku-4-5': model(1_000, 10_000, 75_000, 1_100_000) } })).toEqual({
      input: 5_000,
      output: 40_000,
      cacheWrite: 775_000,
      cacheRead: 13_100_000,
    });
  });

  it('falls back to the main loop’s usage, and is undefined when nothing was reported', () => {
    expect(resultTokens({ usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: null } })).toEqual({ input: 10, output: 20, cacheWrite: 30, cacheRead: 0 });
    expect(resultTokens({ usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} })).toBeUndefined();
    expect(resultTokens({})).toBeUndefined();
  });
});
