import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeProjectsDir, locateTranscript, projectSlug, sessionTranscriptTokens, transcriptTokens } from './transcript.ts';

// A terminal Claude session's tokens from its transcript (docs/kimai.md): each message once, subagents included, only
// inside the session's window, and nothing (never an error) when the file isn't there.
const T0 = Date.UTC(2026, 10, 17, 15, 0, 0);
const SESSION = '3f1c2b9a-1111-4222-8333-444455556666';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function assistant(id: string, at: number, usage: Record<string, number>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), sessionId: SESSION, message: { id, role: 'assistant', model: 'claude-opus-5-5', usage, content: [] }, ...extra });
}

const u = (input: number, output: number, cacheWrite: number, cacheRead: number) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead });

/** A projects folder with this session's transcript (and a subagent's) for a desk at `cwd`. */
async function fixture(cwd = path.join(os.tmpdir(), 'desks', 'ada')) {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-'));
  dirs.push(projects);
  const folder = path.join(projects, projectSlug(cwd));
  const file = path.join(folder, `${SESSION}.jsonl`);
  await fs.mkdir(path.join(folder, SESSION, 'subagents'), { recursive: true });
  await fs.writeFile(
    file,
    [
      JSON.stringify({ type: 'user', timestamp: new Date(T0 + 1000).toISOString(), message: { role: 'user', content: 'Build #12' } }),
      assistant('msg_old', T0 - 60 * 60_000, u(999, 999, 999, 999)), // an earlier session of the resumed conversation
      // Streaming writes one message on several lines, each with the same usage.
      assistant('msg_1', T0 + 2_000, u(5, 100, 20_000, 300_000)),
      assistant('msg_1', T0 + 2_500, u(5, 100, 20_000, 300_000)),
      assistant('msg_2', T0 + 60_000, u(10, 39_900, 755_000, 12_000_000)),
      '{"type":"assistant","timestamp":"2026-11-17T15:', // a line still being written
      JSON.stringify({ type: 'user', timestamp: new Date(T0 + 70_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: '"usage" "assistant"' }] } }),
      assistant('msg_late', T0 + 50 * 60_000, u(999, 999, 999, 999)), // the next session's
    ].join('\n') + '\n',
  );
  await fs.writeFile(path.join(folder, SESSION, 'subagents', 'agent-a1.jsonl'), [assistant('msg_sub', T0 + 30_000, u(4_985, 0, 0, 800_000), { isSidechain: true }), assistant('msg_sub', T0 + 31_000, u(4_985, 0, 0, 800_000))].join('\n'));
  return { projects, file, cwd };
}

describe('transcriptTokens', () => {
  it('counts each message once, subagents included, within the session’s window', async () => {
    const f = await fixture();
    expect(await transcriptTokens(f.file, T0, T0 + 45 * 60_000)).toEqual({ input: 5_000, output: 40_000, cacheWrite: 775_000, cacheRead: 13_100_000 });
  });

  it('is undefined for a missing file and for a window with no messages', async () => {
    const f = await fixture();
    expect(await transcriptTokens(path.join(f.projects, 'nope.jsonl'), T0, T0 + 60_000)).toBeUndefined();
    expect(await transcriptTokens(f.file, T0 + 2 * 60 * 60_000, T0 + 3 * 60 * 60_000)).toBeUndefined();
  });
});

describe('locateTranscript', () => {
  it('uses the file the hooks reported, else finds it from the desk folder and session id', async () => {
    const f = await fixture();
    expect(await locateTranscript({ file: f.file, cwd: '/elsewhere', sessionId: null }, f.projects)).toBe(f.file);
    expect(await locateTranscript({ file: null, cwd: f.cwd, sessionId: SESSION }, f.projects)).toBe(f.file);
    expect(await locateTranscript({ file: path.join(f.projects, 'gone.jsonl'), cwd: f.cwd, sessionId: SESSION }, f.projects)).toBe(f.file);
    expect(await locateTranscript({ file: null, cwd: f.cwd, sessionId: null }, f.projects)).toBeNull();
    expect(await locateTranscript({ file: null, cwd: f.cwd, sessionId: '../x' }, f.projects)).toBeNull();
  });

  it('finds a long desk path’s folder, which Claude Code shortens and ends with a hash', async () => {
    const cwd = path.join(os.tmpdir(), 'machines', 'x'.repeat(220), 'desk');
    const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-'));
    dirs.push(projects);
    const folder = path.join(projects, `${projectSlug(cwd).slice(0, 200)}-k3j9x`);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${SESSION}.jsonl`), assistant('m', T0, u(1, 1, 1, 1)));
    expect(await locateTranscript({ file: null, cwd, sessionId: SESSION }, projects)).toBe(path.join(folder, `${SESSION}.jsonl`));
  });

  it('names folders the way Claude Code does, under CLAUDE_CONFIG_DIR when set', () => {
    expect(projectSlug('/Users/ada/.cubefarm/machines/m1/desk_2')).toBe('-Users-ada--cubefarm-machines-m1-desk-2');
    expect(projectSlug('C:\\Projects\\office swarm')).toBe('C--Projects-office-swarm');
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: path.join('cfg', 'claude') }, 'home')).toBe(path.join('cfg', 'claude', 'projects'));
    expect(claudeProjectsDir({}, 'home')).toBe(path.join('home', '.claude', 'projects'));
  });
});

describe('sessionTranscriptTokens', () => {
  it('never throws: no transcript means no tokens', async () => {
    const f = await fixture();
    expect(await sessionTranscriptTokens({ file: null, cwd: '/nowhere', sessionId: SESSION }, T0, T0 + 60_000, f.projects)).toBeUndefined();
    expect(await sessionTranscriptTokens({ file: null, cwd: f.cwd, sessionId: SESSION }, T0, T0 + 45 * 60_000, f.projects)).toMatchObject({ cacheRead: 13_100_000 });
  });
});
