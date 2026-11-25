import { describe, expect, it } from 'vitest';
import { allowTool, lostConversation, resumableSession } from './cliRunner.ts';
import { wrapHeavyCommand } from './testSlots.ts';

describe('PreToolUse permissions', () => {
  it('wraps heavy foreground Bash commands and preserves other input fields', () => {
    const input = { command: 'cd app && uv run pytest -q', timeout: 1000 };
    expect(allowTool({ tool_name: 'Bash', tool_input: input })).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved by cubefarm',
      updatedInput: { ...input, command: wrapHeavyCommand(input.command) },
    } });
  });

  it.each([
    { tool_name: 'Bash', tool_input: { command: 'git status' } },
    { tool_name: 'Read', tool_input: { command: 'npm test' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } },
    { tool_name: 'Bash', tool_input: { command: 42 } },
  ])('keeps the original approval for %j', (event) => {
    expect(allowTool(event)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved by cubefarm',
    } });
  });
});

describe('resumableSession', () => {
  const onDisk = (files: string[]) => (file: string) => files.includes(file);
  const hook = { hook_event_name: 'PreToolUse', session_id: 'abc', transcript_path: 'abc.jsonl' };

  it("keeps the session once Claude Code's conversation file exists", () => {
    expect(resumableSession(hook, onDisk(['abc.jsonl']))).toBe('abc');
  });

  it("doesn't keep it while the file isn't written yet (SessionStart, UserPromptSubmit)", () => {
    expect(resumableSession({ ...hook, hook_event_name: 'UserPromptSubmit' }, onDisk([]))).toBeNull();
  });

  it("doesn't keep it from a call with no transcript path (the status line) or no session", () => {
    expect(resumableSession({ hook_event_name: 'StatusLine', session_id: 'abc' }, () => true)).toBeNull();
    expect(resumableSession({ hook_event_name: 'Stop', transcript_path: 'abc.jsonl' }, () => true)).toBeNull();
  });
});

describe('lostConversation', () => {
  it("spots Claude Code's message for a resume with nothing to resume", () => {
    expect(lostConversation('\n No conversation found with session ID: 6cc74c7e-0c81-4bff-a140-cc8307c1d11b\n')).toBe(true);
  });

  it('ignores other screens', () => {
    expect(lostConversation('Claude Code v2.1.280\n❯ ')).toBe(false);
  });
});
