import { describe, expect, it } from 'vitest';
import { MAX_DECISION_TEXT } from '../shared/decisions.ts';
import { parseTeamsDecisions } from './teamsDecision.ts';

describe('Teams decision commands', () => {
  it.each(['approve #114', 'yes on #114', ' @Zander APPROVE #114. ', '@Zander Smith yes on #114'])('approves a whole line: %s', (text) => {
    expect(parseTeamsDecisions(text)).toEqual([{ kind: 'approve', number: 114 }]);
  });

  it.each(['retry QA #114', 'retry qa on #114.'])('recognizes retry QA: %s', (text) => {
    expect(parseTeamsDecisions(text)).toEqual([{ kind: 'retry-qa', number: 114 }]);
  });

  it('keeps options, repo words and multiple lines in order', () => {
    expect(parseTeamsDecisions('approve regn #114\napprove openRTSM #114\noption 2 on #114\noption 9 #115\nclose #116')).toEqual([
      { kind: 'approve', repo: 'regn', number: 114 },
      { kind: 'approve', repo: 'openRTSM', number: 114 },
      { kind: 'option', option: 2, number: 114 },
      { kind: 'option', option: 9, number: 115 },
      { kind: 'close', number: 116 },
    ]);
  });

  it('requires a bounded send-back note', () => {
    expect(parseTeamsDecisions('send back #123: Fix the tests.')).toEqual([{ kind: 'send-back', number: 123, note: 'Fix the tests' }]);
    expect(parseTeamsDecisions(`send back regn #123: ${'a'.repeat(MAX_DECISION_TEXT)}`)).toEqual([{ kind: 'send-back', repo: 'regn', number: 123, note: 'a'.repeat(MAX_DECISION_TEXT) }]);
    for (const text of ['send back #123', 'send back #123: ', `send back #123: ${'a'.repeat(MAX_DECISION_TEXT + 1)}`]) expect(parseTeamsDecisions(text)).toEqual([]);
  });

  it('asks for a number only on conservative answer lines', () => {
    expect(parseTeamsDecisions('yes on the merge')).toEqual([{ kind: 'no-number' }]);
    expect(parseTeamsDecisions('approve\nretry QA\noption 2')).toEqual([{ kind: 'no-number' }, { kind: 'no-number' }, { kind: 'no-number' }]);
  });

  it.each(["I'm holding #86 until I hear back", 'Zander, one more: I merged #146', 'please approve #114', 'approve #114 tomorrow', 'yes', 'thanks', 'approve the design', 'option 0 on #114', 'option 10 on #114', 'approve #0', 'approve #114: yes', 'forwarded: approve #114'])('ignores prose or invalid commands: %s', (text) => {
    expect(parseTeamsDecisions(text)).toEqual([]);
  });
});
