// The daily decision digest (docs/email.md): one email a day to the manager listing, floor by floor, the PRs and
// issues that wait for them and what merged in the last 24 hours. Built from what the office already knows, with no
// CEO session and no model tokens. Pure: the swarm gathers the data (swarm.ts sendDigest) and sends it.
import { briefLines, NEEDS_INPUT, type Brief } from '../shared/brief.ts';
import { escapeHtml } from '../shared/email.ts';
import type { IssueInfo, PullInfo, QaStatus } from '../shared/types.ts';
import { decisionLink } from '../shared/decisions.ts';
import { dueSoon, whenLabel } from './decisionClock.ts';
import { decisionLines, readyDecision, stuckPrDecision, type Decision } from './decision.ts';

export { NEEDS_INPUT };
/** How much of an issue's latest comment (or its body) the digest quotes. */
export const EXCERPT_CHARS = 300;
/** Merges the digest counts: those in the last 24 hours. */
export const MERGED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DigestItem {
  number: number;
  title: string;
  url: string;
}

/**
 * A decision on the office's decision clock (decisionClock.ts). brief: undefined when the item isn't on the clock,
 * null when it has no brief yet (the CEO writes one). deadline: when the office applies the recommendation.
 */
export interface DecisionInfo {
  brief?: Brief | null;
  deadline?: number | null;
  answered?: boolean; // the manager replied: no default applies
}

export interface DigestIssue extends DigestItem, DecisionInfo {
  excerpt: string; // the latest comment, or the body when nobody commented, cut to EXCERPT_CHARS
}

export interface DigestFloor {
  name: string; // owner/repo
  waiting: WaitingPull[]; // open PRs that wait for the manager, and why
  needsInput: DigestIssue[];
  merged: DigestItem[];
  inProgress?: string[]; // titles of the issues agents are building now
  milestone?: { title: string; open: number; closed: number } | null; // the current GitHub milestone, when the repo uses them
}

/** An open PR that waits for the manager: why in a few words, and the decision in plain words (server/decision.ts). */
export interface WaitingPull extends DigestItem, DecisionInfo {
  why: string;
  decision: Decision;
}

export interface Digest {
  decisions: number;
  subject: string;
  text: string;
  html: string;
}

/**
 * Open PRs that wait for the manager on one floor, with why: QA passed and the office holds them (shared/holds.ts),
 * QA passed and auto-merge is off, or they're stuck and the CEO handed them on. floor: the repo's name, for the question.
 */
export function waitingPulls(
  pulls: PullInfo[],
  qa: { prNumber: number; status: QaStatus; heldFor?: string | null; stuckWhy?: string | null; escalated?: boolean }[],
  autoMerge: boolean,
  floor = '',
): WaitingPull[] {
  const recs = new Map(qa.map((q) => [q.prNumber, q]));
  const item = (p: PullInfo): WaitingPull | null => {
    const q = recs.get(p.number);
    const pr = { number: p.number, title: p.title, url: p.url };
    if (q?.status === 'needs-human' && q.escalated) return { ...pr, why: `stuck: ${q.stuckWhy ?? 'it needs you'}`, decision: stuckPrDecision(floor, pr, q.stuckWhy ?? null) };
    if (q?.status !== 'passed') return null;
    if (q.heldFor) return { ...pr, why: `held for you: ${q.heldFor}`, decision: readyDecision(floor, pr, q.heldFor) };
    return autoMerge ? null : { ...pr, why: 'QA passed; auto-merge is off', decision: readyDecision(floor, pr, null) };
  };
  return pulls
    .filter((p) => p.state === 'OPEN')
    .flatMap((p) => item(p) ?? [])
    .sort((a, b) => a.number - b.number);
}

/** Open issues labelled needs-input, oldest first. */
export function needsInputIssues(issues: IssueInfo[]): IssueInfo[] {
  return issues.filter((i) => i.labels.some((l) => l.toLowerCase() === NEEDS_INPUT)).sort((a, b) => a.number - b.number);
}

/** Text on one line, cut to `max` characters with an ellipsis. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** PRs merged in the window before `now`, newest first. */
export function mergedSince<T extends { mergedAt: string | null }>(pulls: T[], now: number, windowMs = MERGED_WINDOW_MS): T[] {
  return pulls
    .filter((p) => p.mergedAt && now - Date.parse(p.mergedAt) <= windowMs && Date.parse(p.mergedAt) <= now)
    .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A brief missing from a decision on the clock. */
export const NO_BRIEF = 'No decision brief yet: the CEO is writing it.';

/** What the digest says about a decision on the clock: its brief (or that it is missing) and its deadline. */
export function decisionInfoLines(d: DecisionInfo, now: number): string[] {
  if (d.brief === undefined) return [];
  const by = d.deadline ? whenLabel(d.deadline) : null;
  const flag = !d.answered && d.deadline && dueSoon(d.deadline, now) ? [`Due within 24 hours: by ${by}, the office applies the recommendation.`] : [];
  if (d.answered) return ['You replied, so the office will not decide this by default.', ...(d.brief ? briefLines(d.brief, { max: 400 }).slice(0, 4) : [])];
  if (!d.brief) return [...flag, NO_BRIEF];
  return [...flag, ...briefLines(d.brief, { by, max: 400 })];
}

/** The decisions of a floor, oldest number first. */
const floorDecisions = (f: DigestFloor) => [...f.waiting, ...f.needsInput];

/** The executive summary at the top of a floor: what merged, what is in progress, open decisions, the milestone. */
export function floorSummary(f: DigestFloor, now: number): string[] {
  const lines: string[] = [];
  lines.push(f.merged.length ? `Merged in the last 24 hours: ${f.merged.map((p) => p.title).join('; ')}.` : 'Nothing merged in the last 24 hours.');
  if (f.inProgress) lines.push(f.inProgress.length ? `In progress: ${f.inProgress.join('; ')}.` : 'Nothing in progress.');
  const open = floorDecisions(f);
  if (!open.length) lines.push('No decisions wait for you.');
  else {
    const due = open.filter((d) => !d.answered && d.deadline && dueSoon(d.deadline, now)).length;
    const each = open.map((d) => `#${d.number} ${d.title}${d.deadline && !d.answered ? ` (default applies ${whenLabel(d.deadline)})` : ''}${d.brief === null ? ' (brief missing)' : ''}`);
    lines.push(`Open decisions: ${plural(open.length, 'decision')}${due ? `, ${due} due within 24 hours` : ''}: ${each.join('; ')}.`);
  }
  if (f.milestone) {
    const total = f.milestone.open + f.milestone.closed;
    lines.push(`Milestone ${f.milestone.title}: ${f.milestone.closed} of ${total} issues closed${total ? ` (${Math.round((100 * f.milestone.closed) / total)}%)` : ''}.`);
  }
  return lines;
}

/**
 * The digest's subject, text and HTML (the footer is added when it's sent). A quiet day still sends one: the manager
 * reads "nothing waits for you" as the all-clear, and its absence as a sign the office is down.
 */
export function buildDigest(floors: DigestFloor[], opts: { officeUrl?: string; now?: number } = {}): Digest {
  const now = opts.now ?? Date.now();
  const shown = floors.filter((f) => f.waiting.length || f.needsInput.length || f.merged.length || f.inProgress?.length).sort((a, b) => a.name.localeCompare(b.name));
  const decisions = shown.reduce((n, f) => n + f.waiting.length + f.needsInput.length, 0);
  const merges = shown.reduce((n, f) => n + f.merged.length, 0);
  const dueCount = shown.reduce((n, f) => n + floorDecisions(f).filter((d) => !d.answered && d.deadline && dueSoon(d.deadline, now)).length, 0);
  const subject = decisions ? `Office: ${plural(decisions, 'decision')} waiting${dueCount ? ` (${dueCount} due within 24 hours)` : ''}` : 'Office: nothing waits for you';
  const intro = decisions
    ? `${plural(decisions, 'decision')} ${decisions === 1 ? 'waits' : 'wait'} for you${shown.length > 1 ? ` across ${plural(shown.length, 'floor')}` : ''}.`
    : `Nothing waits for you. ${merges ? plural(merges, 'PR') : 'No PR'} merged in the last 24 hours.`;

  const text: string[] = [intro];
  const html: string[] = [`<p>${escapeHtml(intro)}</p>`];
  const link = (i: DigestItem) => `<a href="${escapeHtml(i.url)}">#${i.number}</a> ${escapeHtml(i.title)}`;
  const approvals = opts.officeUrl ? new URL('?tab=approvals', opts.officeUrl).toString() : '';
  for (const f of shown) {
    text.push('', f.name, '='.repeat(Math.min(f.name.length, 60)));
    html.push(`<h3 style="margin:18px 0 6px">${escapeHtml(f.name)}</h3>`);
    const summary = floorSummary(f, now);
    text.push('', 'Summary:', ...summary.map((l) => `- ${l}`));
    html.push('<p style="margin:8px 0 2px"><b>Summary</b></p><ul>', ...summary.map((l) => `<li>${escapeHtml(l)}</li>`), '</ul>');
    const infoHtml = (d: DecisionInfo) => decisionInfoLines(d, now).map((l) => `<br>${l.startsWith('Due within') ? `<b>${escapeHtml(l)}</b>` : escapeHtml(l)}`).join('');
    // Each decision links to its card in the Decision room, where it is answered in one tap.
    const room = (n: number) => (opts.officeUrl ? decisionLink(opts.officeUrl, f.name, n) : null);
    const roomText = (n: number) => (room(n) ? [`  Answer in the Decision room: ${room(n)}`] : []);
    const roomHtml = (n: number) => (room(n) ? `<br><a href="${escapeHtml(room(n)!)}">Answer in the Decision room</a>` : '');
    if (f.waiting.length) {
      text.push('', 'PRs waiting for your decision:');
      // With a brief, the brief is the decision (its options and recommendation); without one, the office's own.
      for (const p of f.waiting) {
        const [title, options, pick, approve] = decisionLines(p.decision);
        const lines = p.brief ? [title, ...decisionInfoLines(p, now), approve] : [title, options, pick, ...decisionInfoLines(p, now), approve];
        text.push('', `- ${p.decision.question}`, ...lines.map((l) => `  ${l}`), `  ${p.url}`, ...roomText(p.number));
      }
      html.push(
        '<p style="margin:8px 0 2px"><b>PRs waiting for your decision</b></p><ul>',
        ...f.waiting.map((p) => {
          const [, options, pick, approve] = decisionLines(p.decision).map(escapeHtml);
          const office = p.brief ? '' : `<br>${options}<br>${pick}`;
          return `<li style="margin-bottom:10px"><b>${escapeHtml(p.decision.question)}</b><br>${link(p)}${office}${infoHtml(p)}<br><span style="color:#555">${approve}</span>${roomHtml(p.number)}</li>`;
        }),
        '</ul>',
      );
    }
    if (f.needsInput.length) {
      text.push('', 'Issues that need your input:');
      for (const i of f.needsInput) {
        const info = decisionInfoLines(i, now);
        const quote = i.excerpt && !i.brief ? [`  > ${i.excerpt}`] : [];
        text.push(`- #${i.number} ${i.title}`, `  ${i.url}`, ...quote, ...info.map((l) => `  ${l}`), ...roomText(i.number));
      }
      html.push(
        '<p style="margin:8px 0 2px"><b>Issues that need your input</b></p><ul>',
        ...f.needsInput.map((i) => `<li style="margin-bottom:10px">${link(i)}${i.excerpt && !i.brief ? `<br><span style="color:#555">${escapeHtml(i.excerpt)}</span>` : ''}${infoHtml(i)}${roomHtml(i.number)}</li>`),
        '</ul>',
      );
    }
    if (f.merged.length) {
      text.push('', 'Merged in the last 24 hours:');
      for (const p of f.merged) text.push(`- #${p.number} ${p.title}`);
      html.push('<p style="margin:8px 0 2px"><b>Merged in the last 24 hours</b></p><ul>', ...f.merged.map((p) => `<li>${link(p)}</li>`), '</ul>');
    }
  }
  if (opts.officeUrl) {
    if (shown.some((f) => f.waiting.length)) {
      text.push('', `Open Approvals: ${approvals}`);
      html.push(`<p><a href="${escapeHtml(approvals)}">Open Approvals</a> to decide.</p>`);
    }
    text.push('', `Open the office: ${opts.officeUrl}`);
    html.push(`<p><a href="${escapeHtml(opts.officeUrl)}">Open the office</a></p>`);
  }
  return { decisions, subject, text: text.join('\n'), html: html.join('\n') };
}

// ---------- when ----------

/** The office's local day, as YYYY-MM-DD: what `lastSentDay` remembers. */
export function digestDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whether today's digest is due: at or after `hour` (local time), and not already sent (or tried) today. */
export function digestDue(now: Date, hour: number, lastSentDay: string | null): boolean {
  return now.getHours() >= hour && digestDay(now) !== lastSentDay;
}
