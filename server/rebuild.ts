// Stuck PRs are rebuilt, not escalated. A PR stuck for a technical reason (conflicts with main, red checks, failed
// sessions, too many QA rounds) that the CEO's triage couldn't move is closed and its issue built again from current
// main, so technical problems never wait for the manager. A PR held for a business reason keeps going to the manager.
// Loop guard: an issue is rebuilt at most MAX_REBUILDS times; when a rebuild gets stuck too, the manager gets a
// decision brief whose default is to park the work. Pure: the wording and the decisions; swarm.ts does the GitHub calls.
import { OFFICE_MARK, type Brief } from '../shared/brief.ts';
import { HOLD_LABEL } from '../shared/issues.ts';

/** Rebuilds one issue gets; the next stuck PR for it goes to the manager with a brief. */
export const MAX_REBUILDS = 1;

/** Why a PR got stuck (swarm.ts stuck()), when it is about the code or the sessions rather than a business call. */
const TECHNICAL = /conflicts with|fails its checks|failed QA|fix sessions|session got stuck|without a usable report|desk(?:s)? couldn't be set up/;

/** True when a stuck PR's reason is technical: the office fixes those itself. */
export const technicalStuck = (why: string | null | undefined) => TECHNICAL.test(why ?? '');

/** What the office knows about a PR's business holds. */
export interface HoldFacts {
  labels: readonly string[] | undefined; // its GitHub labels
  heldFor: string | null; // QA passed it and the office held it for the manager (shared/holds.ts)
  hold: string | null; // holdFor() now: swarm:hold, a hold path, or not routine on a routine-only floor
  brief: boolean; // a decision brief is on the PR (body or comment)
}

/** Why a PR waits for the manager on business grounds, or null. Those keep today's escalation. */
export function businessHold(f: HoldFacts): string | null {
  if (f.labels?.some((l) => l.toLowerCase() === HOLD_LABEL)) return `label ${HOLD_LABEL}`;
  if (f.brief) return 'it has a decision brief';
  return f.heldFor ?? f.hold ?? null;
}

export type GiveUpStep = { do: 'rebuild' } | { do: 'escalate'; brief: boolean };

/**
 * The office can't move a stuck PR any further (the CEO's triage budget is spent, or a triage changed nothing): rebuild
 * it, or hand it to the manager. rebuilds: how often its issues were already rebuilt (the most of them).
 */
export function giveUpStep(x: { why: string | null; business: string | null; rebuilds: number }): GiveUpStep {
  if (x.business || !technicalStuck(x.why)) return { do: 'escalate', brief: false };
  return x.rebuilds < MAX_REBUILDS ? { do: 'rebuild' } : { do: 'escalate', brief: true };
}

/** The reason in words for someone who hasn't read the code. */
export function plainWhy(why: string | null): string {
  const w = why ?? '';
  if (/conflicts with/.test(w)) return 'other work kept changing the same files first, so it could never be added cleanly';
  if (/fails its checks/.test(w)) return 'its automatic checks kept failing';
  if (/failed QA/.test(w)) return 'it kept failing testing';
  if (/desk/.test(w)) return "the team's workspace for it could not be set up";
  if (/session|report/.test(w)) return 'the work sessions on it kept failing';
  return 'it got stuck';
}

interface Pr {
  number: number;
  title: string;
  branch: string;
}

/** Posted on the PR the office closes to rebuild. */
export function closeComment(pr: Pr, why: string | null, base: string, issues: number[], newIssue: number | null): string {
  const where = issues.length ? issues.map((n) => `#${n}`).join(', ') : newIssue ? `#${newIssue}` : 'its issue';
  return [
    `The office is closing this pull request and building the change again from the current \`${base}\`: ${why ?? 'it got stuck'}.`,
    '',
    `The agents and the CEO tried to fix it in place several times. Starting again from \`${base}\` is cheaper than another round. ${where} stays open and goes back to the team.`,
    `The branch \`${pr.branch}\` is kept for reference: the next developer can reuse what still fits.`,
    OFFICE_MARK,
  ].join('\n');
}

/** Posted on the issue a rebuilt PR was for: what the next developer does. */
export function issueComment(pr: Pr, why: string | null, base: string): string {
  return [
    `PR #${pr.number} for this issue was closed so it can be built again: ${why ?? 'it got stuck'}.`,
    '',
    `Next developer: start a fresh branch from the current \`${base}\`. The old branch \`${pr.branch}\` is kept: reuse its code where it still fits (\`git fetch origin ${pr.branch}\`), but don't push to it or reopen the old PR.`,
    OFFICE_MARK,
  ].join('\n');
}

/** A new issue for a rebuilt PR that linked none. */
export function rebuildIssue(pr: Pr, body: string, why: string | null, base: string): { title: string; body: string } {
  const desc = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  return {
    title: pr.title.slice(0, 200),
    body: [
      `Build again: PR #${pr.number} had no linked issue and was closed so it can be rebuilt from the current \`${base}\` (${why ?? 'it got stuck'}).`,
      '',
      '## What the closed PR changed',
      desc ? desc.slice(0, 4000) : '(It had no description: read the PR.)',
      '',
      `Start a fresh branch from \`${base}\`. The old branch \`${pr.branch}\` is kept: reuse its code where it still fits, but don't push to it.`,
      OFFICE_MARK,
    ].join('\n'),
  };
}

/** What the next developer's prompt says about an issue that was built before. */
export function rebuildNote(r: { pr: number; branch: string; base: string }): string {
  return `This issue was built before in PR #${r.pr}, which the office closed because it got stuck. Start from the current origin/${r.base} on your own branch. The old branch ${r.branch} is kept for reference: reuse what fits (git fetch origin ${r.branch}), but never push to it.`;
}

/** The branch slug of the nth rebuild: a fresh name, so the kept old branch is never pushed over. */
export const rebuildSlug = (slug: string, count: number) => (count > 0 ? `${slug}-r${count + 1}` : slug);

/** The brief for a rebuilt PR that got stuck again: park it, or give the team a direction. */
export function parkBrief(x: { pr: number; title: string; issues: number[]; why: string | null; hours: number }): Brief {
  const issue = x.issues.length ? x.issues.map((n) => `#${n}`).join(', ') : 'its issue';
  return {
    background: `PR #${x.pr} ("${x.title}") is the second attempt at ${issue}. The first attempt got stuck, so the office closed it and started again from scratch. This one got stuck too: ${plainWhy(x.why)}. The team and the CEO already tried to fix it in place.`,
    decision: `Keep working on ${issue} now, or park it for later?`,
    options: [
      `Park it: close this PR and leave ${issue} open but off the team's queue until you hand it out again. Costs nothing more now; the change waits.`,
      'Send it back with a direction: tell the team what to change (for example a smaller scope, or which part comes first). Costs more agent time and may get stuck again.',
      'Merge it anyway: only if you accept it as it is. It has not passed testing.',
    ],
    recommendation: 'Park it. Two attempts got stuck for technical reasons, so a third without a change of scope is likely to get stuck as well.',
    risk: `The change is delayed. ${issue} stays open with both attempts linked, so nothing is lost and the team can pick it up the moment you assign it.`,
    ifNoReply: x.hours > 0 ? `The office closes this PR and leaves ${issue} for later.` : 'It waits for you: this floor never decides by default.',
  };
}

/** Posted when nobody answered a park brief in time. */
export const parkedComment = (hours: number, issues: number[]) =>
  `No reply within ${hours} h, so the office closes this pull request, as its brief recommends. ${issues.length ? `${issues.map((n) => `#${n}`).join(', ')} stay${issues.length === 1 ? 's' : ''} open and wait${issues.length === 1 ? 's' : ''} until you hand ${issues.length === 1 ? 'it' : 'them'} out again.` : ''} The branch is kept.\n${OFFICE_MARK}`;

/** Whether a parked-brief PR's deadline passed with no reply. */
export function parkDue(x: { deadline: number | null; now: number; replied: boolean }): boolean {
  return x.deadline !== null && x.now >= x.deadline && !x.replied;
}
