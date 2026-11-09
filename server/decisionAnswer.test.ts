import { describe, expect, it } from 'vitest';
import { NEEDS_INPUT, OFFICE_MARK, type Brief } from '../shared/brief.ts';
import { DECIDED_MANAGER } from '../shared/decisions.ts';
import { answerPlan } from './decisionAnswer.ts';
import { isAnswer } from './decisionClock.ts';

const brief = (recommendation = 'Harbour: better contrast.'): Brief => ({
  background: 'v2 needs a palette.',
  decision: 'Which palette?',
  options: ['Sunrise: on brand, weaker contrast.', 'Harbour: better contrast.', 'Merge it as it is.'],
  recommendation,
  risk: 'Less on-brand.',
  ifNoReply: '',
});
const issue = { kind: 'issue' as const, reason: 'needs-input' as const, brief: brief(), by: 'Sam' };
const pr = { kind: 'pr' as const, reason: 'held' as const, brief: brief('Merge it.'), by: 'Sam' };

describe('answerPlan: issues', () => {
  it('records the choice as an explicit "Decision:" comment and relabels the issue so it can be built', () => {
    const p = answerPlan(issue, { choice: 'approve' });
    expect(p.summary).toBe('approved the recommendation: Harbour: better contrast.');
    expect(p.comment.split('\n')[0]).toBe('Decision: Approved the recommendation: Harbour: better contrast.');
    expect(isAnswer(p.comment)).toBe(true);
    expect(p.comment).toContain('Answered by Sam in the cubefarm Decision room.');
    expect(p.comment).toContain(OFFICE_MARK);
    expect(p.issue).toEqual({ labels: { add: [DECIDED_MANAGER], remove: [NEEDS_INPUT] } });
    expect(p.pr).toBeUndefined();
  });

  it('takes an option, or the manager’s own words, the same way', () => {
    expect(answerPlan(issue, { choice: 'option', option: 1 }).summary).toBe('chose option 1: Sunrise: on brand, weaker contrast.');
    const own = answerPlan(issue, { choice: 'send-back', note: 'Use the  logo colours.' });
    expect(own.summary).toBe('answered: Use the logo colours.');
    expect(own.issue).toEqual({ labels: { add: [DECIDED_MANAGER], remove: [NEEDS_INPUT] } });
  });

  it('closes a declined issue', () => {
    const p = answerPlan(issue, { choice: 'close', note: 'Not this quarter' });
    expect(p.summary).toBe('declined it: Not this quarter');
    expect(p.issue).toEqual({ close: true });
  });

  it('refuses an option the brief does not have, or approving without a brief', () => {
    expect(() => answerPlan(issue, { choice: 'option', option: 4 })).toThrow('The brief has no option 4.');
    expect(() => answerPlan({ ...issue, brief: null }, { choice: 'approve' })).toThrow(/no recommendation to approve/);
    expect(answerPlan({ ...issue, brief: null }, { choice: 'close' }).issue).toEqual({ close: true });
  });
});

describe('answerPlan: pull requests', () => {
  it('merges when the choice is to merge as it is', () => {
    expect(answerPlan(pr, { choice: 'approve' }).pr).toEqual({ do: 'merge' });
    expect(answerPlan(pr, { choice: 'option', option: 3 }).pr).toEqual({ do: 'merge' });
  });

  it('sends it back with the choice as the note otherwise', () => {
    expect(answerPlan(pr, { choice: 'option', option: 1 }).pr).toEqual({ do: 'send-back', note: 'The manager chose option 1: Sunrise: on brand, weaker contrast.' });
    expect(answerPlan({ ...pr, brief: brief('Rename it to Studio, then merge.') }, { choice: 'approve' }).pr).toEqual({
      do: 'send-back',
      note: 'The manager approved the recommendation: Rename it to Studio, then merge.',
    });
    expect(answerPlan(pr, { choice: 'send-back', note: 'Use MIT.' })).toMatchObject({ summary: 'sent it back: Use MIT.', pr: { do: 'send-back', note: 'Use MIT.' } });
  });

  it('closes it', () => {
    expect(answerPlan({ ...pr, reason: 'stuck' }, { choice: 'close' })).toMatchObject({ summary: 'closed it', pr: { do: 'close' } });
  });
});
