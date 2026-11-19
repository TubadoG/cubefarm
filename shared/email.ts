// Outbound email's rules (docs/email.md), shared by the server (validation, the allowlist check, the daily cap) and
// Settings → Email. The CEO may only write to people on the manager's list; the office enforces it, not the prompt.
import type { DigestSettings, EmailColleague, EmailRecipient, EmailSettings, EmailView } from './types.ts';

export type { DigestSettings, EmailColleague, EmailRecipient, EmailSettings };

/** Most people on the list. */
export const MAX_RECIPIENTS = 25;
export const MAX_NAME = 60;
/** The daily cap until the manager changes it: most emails the office may send (or have waiting) in any 24 hours. */
export const DEFAULT_DAILY_CAP = 10;
/** The bounds Settings → Email allows for the daily cap. */
export const MIN_DAILY_CAP = 1;
export const MAX_DAILY_CAP = 100;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DIGEST: DigestSettings = { enabled: false, hour: 8, to: '' };
export const DEFAULT_EMAIL: EmailSettings = { enabled: false, from: '', copyTo: '', recipients: [], digest: DEFAULT_DIGEST, inbox: false, mine: [], colleagues: [], dailyCap: DEFAULT_DAILY_CAP };
/** Most addresses that count as the manager's own. */
export const MAX_MINE = 10;
/** Most colleagues whose email reaches the CEO. */
export const MAX_COLLEAGUES = 10;

// Deliberately plain: no quotes, spaces or brackets, a dot in the domain. Enough to catch typos, not RFC 5322.
const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** An address, trimmed and lowercased, or null when it doesn't look like one. */
export function emailAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && ADDRESS.test(s) ? s : null;
}

/** The list from a saved state or a settings patch, or null when it isn't one (too long, or a bad address). */
function recipientList(raw: unknown): EmailRecipient[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RECIPIENTS) return null;
  const out: EmailRecipient[] = [];
  for (const r of raw as unknown[]) {
    const x = (r && typeof r === 'object' ? r : {}) as { email?: unknown; name?: unknown; approve?: unknown };
    const email = emailAddress(x.email);
    if (!email) return null;
    if (out.some((o) => o.email === email)) continue;
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, MAX_NAME) : '';
    // New people wait for the manager's OK unless they said otherwise.
    out.push({ email, name: name || email.split('@')[0], approve: x.approve !== false });
  }
  return out;
}

const validHour = (h: unknown): h is number => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;
const validCap = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= MIN_DAILY_CAP && n <= MAX_DAILY_CAP;

/**
 * What's wrong with the digest part of a settings patch; null when nothing is. A newly picked recipient must be on the
 * list (as the patch leaves it) without "Ask me": the digest goes out on its own, with nobody to approve it.
 */
function digestProblem(raw: unknown, recipients: unknown, base: EmailSettings): string | null {
  if (!raw || typeof raw !== 'object') return 'The digest settings are missing.';
  const d = raw as Partial<Record<keyof DigestSettings, unknown>>;
  if (d.hour !== undefined && !validHour(d.hour)) return 'The digest hour must be a whole hour from 0 to 23.';
  const to = d.to === undefined ? base.digest.to : d.to === '' ? '' : emailAddress(d.to);
  if (to === null) return `"${String(d.to)}" isn't a valid email address.`;
  if (to && to !== base.digest.to) {
    const list = Array.isArray(recipients) ? (recipients as { email?: unknown; approve?: unknown }[]) : base.recipients;
    const who = list.find((r) => emailAddress(r?.email) === to);
    if (!who) return `${to} isn't on the list: add them first, then pick them for the digest.`;
    if (who.approve !== false) return `The digest goes out on its own, so it can only go to someone without “Ask me”. Turn it off for ${to}, or pick someone else.`;
  }
  if (d.enabled === true && !to) return 'Pick who gets the digest first.';
  return null;
}

/** What's wrong with a settings patch, in words Settings → Email can show; null when nothing is. `base`: the settings now. */
export function emailProblem(patch: unknown, base: EmailSettings = DEFAULT_EMAIL): string | null {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof EmailSettings, unknown>>;
  if (p.from !== undefined && p.from !== '' && !emailAddress(p.from)) return "The From address isn't a valid email address.";
  if (p.recipients !== undefined) {
    if (!Array.isArray(p.recipients)) return 'The list of recipients is missing.';
    if (p.recipients.length > MAX_RECIPIENTS) return `At most ${MAX_RECIPIENTS} people fit on the list.`;
    const bad = (p.recipients as { email?: unknown }[]).find((r) => !emailAddress(r?.email));
    if (bad) return `"${String(bad?.email ?? '')}" isn't a valid email address.`;
  }
  if (p.copyTo !== undefined && p.copyTo !== '' && !emailAddress(p.copyTo)) return "The copy-to address isn't a valid email address.";
  if (p.inbox !== undefined && typeof p.inbox !== 'boolean') return 'Reading replies is on or off.';
  if (p.mine !== undefined) {
    if (!Array.isArray(p.mine)) return 'The list of your addresses is missing.';
    if (p.mine.length > MAX_MINE) return `At most ${MAX_MINE} addresses can count as yours.`;
    const bad = (p.mine as unknown[]).find((m) => !emailAddress(m));
    if (bad !== undefined) return `"${String(bad)}" isn't a valid email address.`;
  }
  if (p.colleagues !== undefined) {
    if (!Array.isArray(p.colleagues)) return 'The list of colleagues is missing.';
    if (p.colleagues.length > MAX_COLLEAGUES) return `At most ${MAX_COLLEAGUES} colleagues fit on the list.`;
    const bad = (p.colleagues as { email?: unknown }[]).find((c) => !emailAddress(c?.email));
    if (bad !== undefined) return `"${String(bad?.email ?? '')}" isn't a valid email address.`;
  }
  if (p.dailyCap !== undefined && !validCap(p.dailyCap)) return `The daily cap must be a whole number from ${MIN_DAILY_CAP} to ${MAX_DAILY_CAP}.`;
  if (p.digest !== undefined) return digestProblem(p.digest, p.recipients, { ...DEFAULT_EMAIL, ...base, digest: { ...DEFAULT_DIGEST, ...base.digest } });
  return null;
}

/** Email settings from a saved state or a PATCH /api/settings, field by field; anything invalid keeps `base`. */
export function emailSettings(base: EmailSettings, patch: unknown): EmailSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof EmailSettings, unknown>>;
  const b = { ...DEFAULT_EMAIL, ...base };
  const recipients = p.recipients === undefined ? b.recipients : (recipientList(p.recipients) ?? b.recipients);
  const from = p.from === '' ? '' : (emailAddress(p.from) ?? b.from);
  // The blind copy only ever goes to someone on the list: a copyTo that left the list goes with them.
  const wanted = p.copyTo === '' ? '' : (emailAddress(p.copyTo) ?? b.copyTo);
  const copyTo = recipients.some((r) => r.email === wanted) ? wanted : '';
  const inbox = typeof p.inbox === 'boolean' ? p.inbox : b.inbox;
  let mine = p.mine === undefined ? (b.mine ?? []) : (mineList(p.mine) ?? b.mine ?? []);
  // Switched on with nobody listed: the blind-copy address, the manager's own, counts.
  if (inbox && !b.inbox && mine.length === 0 && copyTo) mine = [copyTo];
  const colleagues = p.colleagues === undefined ? (b.colleagues ?? []) : (colleagueList(p.colleagues) ?? b.colleagues ?? []);
  return { enabled: typeof p.enabled === 'boolean' ? p.enabled : b.enabled, from, copyTo, recipients, digest: digestSettings({ ...DEFAULT_DIGEST, ...b.digest }, p.digest, recipients), inbox, mine, colleagues, dailyCap: validCap(p.dailyCap) ? p.dailyCap : dailyCap(b) };
}

/** Colleagues from a saved state or a patch, or null when it isn't a valid list. A name defaults to the address's local part. */
function colleagueList(raw: unknown): EmailColleague[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_COLLEAGUES) return null;
  const out: EmailColleague[] = [];
  for (const c of raw as unknown[]) {
    const x = (c && typeof c === 'object' ? c : {}) as { email?: unknown; name?: unknown };
    const email = emailAddress(x.email);
    if (!email) return null;
    if (out.some((o) => o.email === email)) continue;
    const name = typeof x.name === 'string' ? x.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
    out.push({ email, name: name || email.split('@')[0] });
  }
  return out;
}

/**
 * The colleague with this address, if any. An address that is also on `mine` is the manager's: the manager wins, so it
 * never comes back as a colleague.
 */
export function findColleague(s: Pick<EmailSettings, 'mine' | 'colleagues'>, addr: unknown): EmailColleague | undefined {
  const email = emailAddress(addr);
  if (!email || (s.mine ?? []).includes(email)) return undefined;
  return (s.colleagues ?? []).find((c) => c.email === email);
}

/** Colleagues the CEO can't answer: not on the send list. Settings → Email warns about them. */
export function colleaguesOffList(s: Pick<EmailSettings, 'recipients' | 'colleagues'>): EmailColleague[] {
  return (s.colleagues ?? []).filter((c) => !s.recipients.some((r) => r.email === c.email));
}

/** The manager's own addresses from a patch, or null when it isn't a valid list. */
function mineList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_MINE) return null;
  const out: string[] = [];
  for (const m of raw as unknown[]) {
    const a = emailAddress(m);
    if (!a) return null;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** The digest from a saved state or a patch; its recipient only ever someone on `recipients` without "Ask me". */
function digestSettings(base: DigestSettings, patch: unknown, recipients: EmailRecipient[]): DigestSettings {
  const d = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof DigestSettings, unknown>>;
  const hour = validHour(d.hour) ? d.hour : base.hour;
  const wanted = d.to === '' ? '' : (emailAddress(d.to) ?? base.to);
  // Like the blind copy: a recipient who left the list, or now needs an OK, takes the digest with them.
  const to = recipients.some((r) => r.email === wanted && !r.approve) ? wanted : '';
  const enabled = (typeof d.enabled === 'boolean' ? d.enabled : base.enabled) && !!to;
  return { enabled, hour, to };
}

/** The person on the list with this address, if any. */
export function findRecipient(settings: EmailSettings, addr: unknown): EmailRecipient | undefined {
  const email = emailAddress(addr);
  return email ? settings.recipients.find((r) => r.email === email) : undefined;
}

/** Whether an email counts toward the daily cap: sent or waiting, written in the last 24 hours (a rolling window, not a calendar day). */
export function countsToday(e: Pick<EmailView, 'status' | 'createdAt'>, now: number): boolean {
  return (e.status === 'sent' || e.status === 'pending') && now - e.createdAt < DAY_MS;
}

/** Emails that count toward the daily cap. */
export function emailsToday(emails: Pick<EmailView, 'status' | 'createdAt'>[], now: number): number {
  return emails.filter((e) => countsToday(e, now)).length;
}

/** The daily cap in force; the default for settings saved before it could be changed (or a bad value). */
export function dailyCap(s: Partial<Pick<EmailSettings, 'dailyCap'>>): number {
  return validCap(s.dailyCap) ? s.dailyCap : DEFAULT_DAILY_CAP;
}

/** Why another email can't go out now, or null when the cap leaves room. Worded for the CEO and the manager. */
export function capRefusal(s: Partial<Pick<EmailSettings, 'dailyCap'>>, emails: Pick<EmailView, 'status' | 'createdAt'>[], now: number): string | null {
  const cap = dailyCap(s);
  return emailsToday(emails, now) >= cap ? `The office sends at most ${cap} email${cap === 1 ? '' : 's'} in any 24 hours, and they're used up.` : null;
}

/** Settings → Email's count beside the cap, e.g. "4 of 10 used in the last 24 hours". */
export function capUsage(used: number, cap: number): string {
  return `${used} of ${cap} used in the last 24 hours`;
}

/**
 * What happens to a reply: it reaches the CEO (the office reads its mailbox and the recipient's address counts as the
 * manager's or a colleague's), the manager answers in the office instead, or nobody reads it (anyone else).
 */
export type ReplyNote = 'read' | 'office' | 'unread';

/** The reply note for an email to `to` under these settings. */
export function replyNote(s: Pick<EmailSettings, 'inbox' | 'mine'> & Partial<Pick<EmailSettings, 'colleagues'>>, to: string): ReplyNote {
  const addr = to.trim().toLowerCase();
  if ((s.colleagues ?? []).some((c) => c.email === addr) && !(s.mine ?? []).includes(addr)) return s.inbox ? 'read' : 'unread';
  const mine = (s.mine ?? []).includes(addr);
  if (!mine) return 'unread';
  return s.inbox ? 'read' : 'office';
}

const REPLY_LINE: Record<ReplyNote, string> = {
  read: 'Reply to this email to answer the CEO.',
  office: "Replies to this address aren't read; answer in the office.",
  unread: "Replies to this address aren't read.",
};

/** The two lines under every email: who wrote it, and what happens to a reply. */
export function emailFooter(company: string, reply: ReplyNote): string {
  return [`Sent by the CEO of ${company.trim() || 'the company'}'s office, an AI agent running in cubefarm.`, REPLY_LINE[reply]].join('\n');
}

/** The text that's sent: the CEO's body, then the footer. */
export function emailText(body: string, company: string, reply: ReplyNote): string {
  return `${body.trimEnd()}\n\n-- \n${emailFooter(company, reply)}`;
}

/** Text made safe to put in HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The HTML that's sent, for an email that has some (the digest): its body, then the same footer. */
export function emailHtml(bodyHtml: string, company: string, reply: ReplyNote): string {
  const footer = emailFooter(company, reply).split('\n').map(escapeHtml).join('<br>');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45">${bodyHtml}<hr style="border:0;border-top:1px solid #ccc;margin:20px 0 8px"><p style="color:#666;font-size:12px">${footer}</p></div>`;
}
