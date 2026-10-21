// Outbound email's rules (docs/email.md), shared by the server (validation, the allowlist check, the daily cap) and
// Settings → Email. The CEO may only write to people on the manager's list; the office enforces it, not the prompt.
import type { DigestSettings, EmailRecipient, EmailSettings, EmailView } from './types.ts';

export type { DigestSettings, EmailRecipient, EmailSettings };

/** Most people on the list. */
export const MAX_RECIPIENTS = 25;
export const MAX_NAME = 60;
/** Most emails the CEO may send (or have waiting) in any 24 hours. */
export const EMAILS_PER_DAY = 10;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DIGEST: DigestSettings = { enabled: false, hour: 8, to: '' };
export const DEFAULT_EMAIL: EmailSettings = { enabled: false, from: '', copyTo: '', recipients: [], digest: DEFAULT_DIGEST };

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
  return { enabled: typeof p.enabled === 'boolean' ? p.enabled : b.enabled, from, copyTo, recipients, digest: digestSettings({ ...DEFAULT_DIGEST, ...b.digest }, p.digest, recipients) };
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

/** Emails that count toward EMAILS_PER_DAY: sent or waiting, written in the last 24 hours. */
export function emailsToday(emails: Pick<EmailView, 'status' | 'createdAt'>[], now: number): number {
  return emails.filter((e) => (e.status === 'sent' || e.status === 'pending') && now - e.createdAt < DAY_MS).length;
}

/** The two lines under every email: who wrote it, and where replies go. */
export function emailFooter(company: string, from: string): string {
  return [`Sent by the CEO of ${company.trim() || 'the company'}'s office, an AI agent running in cubefarm.`, `Replies go to ${from}.`].join('\n');
}

/** The text that's sent: the CEO's body, then the footer. */
export function emailText(body: string, company: string, from: string): string {
  return `${body.trimEnd()}\n\n-- \n${emailFooter(company, from)}`;
}

/** Text made safe to put in HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The HTML that's sent, for an email that has some (the digest): its body, then the same footer. */
export function emailHtml(bodyHtml: string, company: string, from: string): string {
  const footer = emailFooter(company, from).split('\n').map(escapeHtml).join('<br>');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45">${bodyHtml}<hr style="border:0;border-top:1px solid #ccc;margin:20px 0 8px"><p style="color:#666;font-size:12px">${footer}</p></div>`;
}
