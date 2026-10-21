// The daily decision digest (docs/email.md): one email a day to the manager listing, floor by floor, the PRs and
// issues that wait for them and what merged in the last 24 hours. Built from what the office already knows, with no
// CEO session and no model tokens. Pure: the swarm gathers the data (swarm.ts sendDigest) and sends it.
import { escapeHtml } from '../shared/email.ts';
import type { IssueInfo, PullInfo, QaStatus } from '../shared/types.ts';

/** The label that asks the manager for an answer on an issue. */
export const NEEDS_INPUT = 'needs-input';
/** How much of an issue's latest comment (or its body) the digest quotes. */
export const EXCERPT_CHARS = 300;
/** Merges the digest counts: those in the last 24 hours. */
export const MERGED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DigestItem {
  number: number;
  title: string;
  url: string;
}

export interface DigestIssue extends DigestItem {
  excerpt: string; // the latest comment, or the body when nobody commented, cut to EXCERPT_CHARS
}

export interface DigestFloor {
  name: string; // owner/repo
  waiting: (DigestItem & { why: string })[]; // open PRs that wait for the manager, and why
  needsInput: DigestIssue[];
  merged: DigestItem[];
}

export interface Digest {
  decisions: number;
  subject: string;
  text: string;
  html: string;
}

/**
 * Open PRs that wait for the manager on one floor, with why: QA passed and the office holds them (shared/holds.ts),
 * or QA passed and auto-merge is off.
 */
export function waitingPulls(
  pulls: PullInfo[],
  qa: { prNumber: number; status: QaStatus; heldFor?: string | null }[],
  autoMerge: boolean,
): (DigestItem & { why: string })[] {
  const passed = new Map(qa.filter((q) => q.status === 'passed').map((q) => [q.prNumber, q.heldFor ?? null]));
  const why = (n: number) => {
    if (!passed.has(n)) return null;
    const held = passed.get(n);
    if (held) return `held for you: ${held}`;
    return autoMerge ? null : 'QA passed; auto-merge is off';
  };
  return pulls
    .filter((p) => p.state === 'OPEN')
    .flatMap((p) => {
      const w = why(p.number);
      return w ? [{ number: p.number, title: p.title, url: p.url, why: w }] : [];
    })
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

/**
 * The digest's subject, text and HTML (the footer is added when it's sent). A quiet day still sends one: the manager
 * reads "nothing waits for you" as the all-clear, and its absence as a sign the office is down.
 */
export function buildDigest(floors: DigestFloor[], opts: { officeUrl?: string } = {}): Digest {
  const shown = floors.filter((f) => f.waiting.length || f.needsInput.length || f.merged.length).sort((a, b) => a.name.localeCompare(b.name));
  const decisions = shown.reduce((n, f) => n + f.waiting.length + f.needsInput.length, 0);
  const merges = shown.reduce((n, f) => n + f.merged.length, 0);
  const subject = decisions ? `Office: ${plural(decisions, 'decision')} waiting` : 'Office: nothing waits for you';
  const intro = decisions
    ? `${plural(decisions, 'decision')} ${decisions === 1 ? 'waits' : 'wait'} for you${shown.length > 1 ? ` across ${plural(shown.length, 'floor')}` : ''}.`
    : `Nothing waits for you. ${merges ? plural(merges, 'PR') : 'No PR'} merged in the last 24 hours.`;

  const text: string[] = [intro];
  const html: string[] = [`<p>${escapeHtml(intro)}</p>`];
  const link = (i: DigestItem) => `<a href="${escapeHtml(i.url)}">#${i.number}</a> ${escapeHtml(i.title)}`;
  for (const f of shown) {
    text.push('', f.name, '='.repeat(Math.min(f.name.length, 60)));
    html.push(`<h3 style="margin:18px 0 6px">${escapeHtml(f.name)}</h3>`);
    if (f.waiting.length) {
      text.push('', 'PRs waiting for you:');
      for (const p of f.waiting) text.push(`- #${p.number} ${p.title} (${p.why})`, `  ${p.url}`);
      html.push('<p style="margin:8px 0 2px"><b>PRs waiting for you</b></p><ul>', ...f.waiting.map((p) => `<li>${link(p)} <span style="color:#666">(${escapeHtml(p.why)})</span></li>`), '</ul>');
    }
    if (f.needsInput.length) {
      text.push('', 'Issues that need your input:');
      for (const i of f.needsInput) text.push(`- #${i.number} ${i.title}`, `  ${i.url}`, ...(i.excerpt ? [`  > ${i.excerpt}`] : []));
      html.push(
        '<p style="margin:8px 0 2px"><b>Issues that need your input</b></p><ul>',
        ...f.needsInput.map((i) => `<li>${link(i)}${i.excerpt ? `<br><span style="color:#555">${escapeHtml(i.excerpt)}</span>` : ''}</li>`),
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
