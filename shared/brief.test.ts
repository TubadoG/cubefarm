import { describe, expect, it } from 'vitest';
import { BRIEF_TEMPLATE, briefGaps, briefLines, findBrief, parseBrief, recommendsMerge, renderBrief, usableBrief, type Brief } from './brief.ts';

const full: Brief = {
  background: 'Checkout needs a payment provider.',
  decision: 'Which provider do we launch with?',
  options: ['Stripe: fastest to build, 2.9% per sale.', 'Adyen: cheaper at volume, a month more work.'],
  recommendation: 'Stripe, because launch date matters more than fees now.',
  risk: 'Fees grow with sales; the provider sits behind one module, so a switch later is contained.',
  ifNoReply: 'The office builds Stripe.',
};

describe('parseBrief', () => {
  it('reads every section under "## Decision brief"', () => {
    const body = `Intro text.\n\n${renderBrief(full, 'Wed 11 Nov 08:00')}\n\n## Notes\nnot part of it`;
    expect(parseBrief(body)).toEqual(full);
  });

  it('accepts bold section lines and a "Recommendation (and why)" heading', () => {
    const b = parseBrief('## Decision brief\n**Background**\nBg\n**The decision:**\nQ?\n**Options**\n1. A\n2. B\n### Recommendation (and why)\nA\n**Risk and mitigation**\nR\n### If no reply by Friday\nDo A');
    expect(b).toEqual({ background: 'Bg', decision: 'Q?', options: ['A', 'B'], recommendation: 'A', risk: 'R', ifNoReply: 'Do A' });
  });

  it('is null without the heading, and lists the gaps of a partial brief', () => {
    expect(parseBrief('Just a body')).toBeNull();
    expect(parseBrief(null)).toBeNull();
    const b = parseBrief('## Decision brief\n### The decision\nQ?')!;
    expect(briefGaps(b)).toEqual(['Background', 'Options', 'Recommendation', 'Risk and mitigation', 'If no reply by']);
    expect(usableBrief(b)).toBe(false);
    expect(usableBrief(full)).toBe(true);
  });

  it('parses the template the agents are given', () => {
    const b = parseBrief(BRIEF_TEMPLATE)!;
    expect(b).not.toBeNull();
    expect(briefGaps(b)).toHaveLength(6); // headings only, every section empty
  });
});

describe('findBrief', () => {
  it('takes the latest comment with a brief, else the body', () => {
    const body = renderBrief({ ...full, recommendation: 'From the body' });
    expect(findBrief(body, [])!.recommendation).toBe('From the body');
    const comments = [{ body: renderBrief({ ...full, recommendation: 'Older' }) }, { body: renderBrief({ ...full, recommendation: 'Newer' }) }, { body: 'Thanks!' }];
    expect(findBrief(body, comments)!.recommendation).toBe('Newer');
    expect(findBrief('no brief', [{ body: 'none either' }])).toBeNull();
  });
});

describe('briefLines', () => {
  it('puts each section on one plain line, with the deadline', () => {
    const lines = briefLines({ ...full, background: '**Checkout**\nneeds   a provider.' }, { by: 'Wed 11 Nov 08:00' });
    expect(lines).toEqual([
      'Background: Checkout needs a provider.',
      'The decision: Which provider do we launch with?',
      'Options: (1) Stripe: fastest to build, 2.9% per sale. (2) Adyen: cheaper at volume, a month more work.',
      'Recommendation: Stripe, because launch date matters more than fees now.',
      'Risk and mitigation: Fees grow with sales; the provider sits behind one module, so a switch later is contained.',
      'If no reply by Wed 11 Nov 08:00: The office builds Stripe.',
    ]);
  });

  it('cuts long sections and fills in what is missing', () => {
    const lines = briefLines({ ...full, background: 'x'.repeat(500), ifNoReply: '', risk: '' }, { max: 50 });
    expect(lines[0]).toHaveLength('Background: '.length + 50);
    expect(lines[4]).toBe('Risk and mitigation: (not given)');
    expect(lines[5]).toBe('If no reply: the office applies the recommendation');
  });
});

describe('recommendsMerge', () => {
  it('is true for a recommendation to merge', () => {
    for (const r of ['Merge it.', 'Merge: the change is small and QA passed.', 'I recommend merging as is.']) expect(recommendsMerge(r)).toBe(true);
  });
  it('is false for anything else', () => {
    for (const r of ['Rename the plan to Pro, then merge.', 'Merge once legal signs off.', 'Do not merge until legal signs off.', "Don't merge; send it back to use the MIT licence.", 'Send it back and rename the plan.', 'Keep the free tier.']) expect(recommendsMerge(r)).toBe(false);
  });
});
