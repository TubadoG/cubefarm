// The manager's answer on a Decision room card, as what the office does about it: the comment it posts (first line
// "Decision: …", so the decision clock and anyone reading GitHub see an explicit answer), the issue's labels, and the
// PR action through the swarm's own merge / send back / close. Pure; swarm.ts answerDecision carries it out.
import { NEEDS_INPUT, OFFICE_MARK, recommendsMerge, type Brief } from '../shared/brief.ts';
import { DECIDED_MANAGER, type DecisionChoice, type DecisionReason } from '../shared/decisions.ts';

export type PrAction = { do: 'merge' } | { do: 'send-back'; note: string } | { do: 'close' };

export interface AnswerPlan {
  /** Posted on the issue or PR first. */
  comment: string;
  /** What the manager chose, in a few words, for the card and the phone. */
  summary: string;
  /** Issues: relabel (answered) or close (declined). */
  issue?: { labels: { add: string[]; remove: string[] } } | { close: true };
  pr?: PrAction;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Where an answer came from: a Room card, or Bryan's voice Claude through the decision connector (docs/decision-connector.md). */
export type AnswerVia = 'room' | 'connector';

/** How swarm.ts answerDecision is asked: the source, and (for PRs) the head the answer was given on. */
export interface AnswerOptions {
  via?: AnswerVia;
  /** Refuse if the PR's head on GitHub isn't this commit any more. The connector always sends it; the Room may. */
  expectedHeadSha?: string;
}

/** The sign-off under the "Decision:" comment, naming where the answer came from. */
export function signOff(by: string, via: AnswerVia = 'room'): string {
  return via === 'connector' ? `_Answered by ${by} via the cubefarm decision connector._` : `_Answered by ${by} in the cubefarm Decision room._`;
}

/**
 * What a choice does. Issues: an answer drops needs-input for decided:manager, so the issue can be built; declining
 * closes it. PRs: approving or picking an option merges it when that option is "merge" as it is (recommendsMerge),
 * otherwise it goes back to a developer with the choice as the note; send back and close do just that.
 * Throws a message the manager can act on (no brief, an option that isn't there).
 */
export function answerPlan(d: { kind: 'issue' | 'pr'; reason: DecisionReason; brief: Brief | null; by: string; via?: AnswerVia }, c: DecisionChoice): AnswerPlan {
  const sign = `\n\n${signOff(d.by, d.via)}\n${OFFICE_MARK}`;
  let chosen: string; // the words of the choice
  let summary: string;
  if (c.choice === 'approve') {
    if (!d.brief?.recommendation) throw new Error('There is no recommendation to approve yet: pick an option, send it back with a note, or ask the CEO.');
    chosen = oneLine(d.brief.recommendation);
    summary = `approved the recommendation: ${chosen}`;
  } else if (c.choice === 'option') {
    const text = d.brief?.options[c.option - 1];
    if (!text) throw new Error(`The brief has no option ${c.option}.`);
    chosen = oneLine(text);
    summary = `chose option ${c.option}: ${chosen}`;
  } else if (c.choice === 'send-back') {
    chosen = oneLine(c.note);
    summary = d.kind === 'pr' ? `sent it back: ${chosen}` : `answered: ${chosen}`;
  } else {
    chosen = c.note ? oneLine(c.note) : '';
    summary = d.kind === 'pr' ? `closed it${chosen ? `: ${chosen}` : ''}` : `declined it${chosen ? `: ${chosen}` : ''}`;
  }
  const comment = `Decision: ${summary.charAt(0).toUpperCase()}${summary.slice(1)}${sign}`;

  if (d.kind === 'issue') {
    if (c.choice === 'close') return { comment, summary, issue: { close: true } };
    return { comment, summary, issue: { labels: { add: [DECIDED_MANAGER], remove: [NEEDS_INPUT] } } };
  }
  if (c.choice === 'close') return { comment, summary, pr: { do: 'close' } };
  if (c.choice === 'send-back') return { comment, summary, pr: { do: 'send-back', note: chosen } };
  if (recommendsMerge(chosen)) return { comment, summary, pr: { do: 'merge' } };
  return { comment, summary, pr: { do: 'send-back', note: `The manager ${summary}` } };
}
