import { describe, expect, it } from 'vitest';
import { clampStuckMinutes, isMcpDialog, lastScreenLine, screenHash, stuckDecision, stuckMessage } from './stuckScreen.ts';
import { projectMcpServers } from './clis.ts';

const MIN = 60_000;
const at = (status: string, frozenMin: number, strikes = 0, stuckMinutes = 15) => stuckDecision({ status, lastChange: 0, now: frozenMin * MIN, strikes, stuckMinutes });

describe('stuckDecision', () => {
  it('leaves a screen that changed recently alone', () => {
    expect(at('working', 14.9)).toBe('none');
  });
  it('restarts a working or preparing agent frozen for stuckMinutes, the first time', () => {
    expect(at('working', 15)).toBe('restart');
    expect(at('preparing', 40)).toBe('restart');
  });
  it('gives up the second time on the same task', () => {
    expect(at('working', 15, 1)).toBe('giveUp');
    expect(at('working', 15, 3)).toBe('giveUp');
  });
  it('ignores agents that are not busy', () => {
    for (const status of ['idle', 'done', 'error', 'stopped']) expect(at(status, 120)).toBe('none');
  });
  it('is off at 0 minutes', () => {
    expect(at('working', 600, 0, 0)).toBe('none');
  });
});

describe('clampStuckMinutes', () => {
  it('keeps whole minutes in range, 0 = off', () => {
    expect(clampStuckMinutes(15.4)).toBe(15);
    expect(clampStuckMinutes(0)).toBe(0);
    expect(clampStuckMinutes(-3)).toBe(0);
    expect(clampStuckMinutes(1e9)).toBe(1440);
    expect(clampStuckMinutes('x')).toBe(15);
  });
});

describe('isMcpDialog', () => {
  it("spots Claude Code's dialog for several project servers", () => {
    const screen = ['╭────╮', '│ 3 new MCP servers found in this project', '│ Select any you wish to enable.', '│ ❯ ◉ figma', '│   Enable selected', '╰────╯', '  Space to select · Enter to confirm · Esc to reject all'].join('\n');
    expect(isMcpDialog(screen)).toBe(true);
  });
  it('spots the dialog for a single project server', () => {
    expect(isMcpDialog('New MCP server found in this project: figma\n❯ 1. Use this MCP server\n  3. Continue without using this MCP server')).toBe(true);
  });
  it("doesn't take a file mentioning the title for the dialog", () => {
    expect(isMcpDialog("⏺ Read(server/stuckScreen.ts)\n  // ('3 new MCP servers found in this project')")).toBe(false);
    expect(isMcpDialog('✻ Thinking… (12s · esc to interrupt)')).toBe(false);
  });
});

describe('lastScreenLine', () => {
  it('is the last non-empty line, trimmed', () => {
    expect(lastScreenLine('one\n  ✻ Waiting… (3m)  \n\n   \n')).toBe('✻ Waiting… (3m)');
    expect(lastScreenLine('\n\n')).toBe('');
  });
  it('is at most 120 characters', () => {
    const line = lastScreenLine('x'.repeat(300));
    expect(line).toHaveLength(120);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('screenHash', () => {
  it('changes with the screen, e.g. a spinner timer', () => {
    expect(screenHash('✻ Working… (12s)')).not.toBe(screenHash('✻ Working… (13s)'));
    expect(screenHash('same')).toBe(screenHash('same'));
  });
});

describe('stuckMessage', () => {
  it('says what happened, with the last line', () => {
    expect(stuckMessage('Ada', 15, '#12', 'restart', '│ Enable selected')).toBe('Ada was stuck for 15 min on #12; restarted it. Last line: "│ Enable selected"');
    expect(stuckMessage('Ada', 16, '#12', 'giveUp', '')).toBe('Ada was stuck again for 16 min on #12; stopped it and left the task for you to assign by hand.');
  });
});

describe('projectMcpServers', () => {
  it("lists a repo's .mcp.json servers, leaving the office's own alone", () => {
    expect(projectMcpServers(JSON.stringify({ mcpServers: { figma: {}, linear: {}, playwright: {} } }), ['playwright', 'office'])).toEqual(['figma', 'linear']);
  });
  it('is empty for no file or bad JSON', () => {
    expect(projectMcpServers('')).toEqual([]);
    expect(projectMcpServers('{nope')).toEqual([]);
    expect(projectMcpServers('{"mcpServers":[1]}')).toEqual([]);
  });
});
