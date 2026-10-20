// Outbound email's rules (docs/email.md), shared by the server (validation, the allowlist check, the daily cap) and
// Settings → Email. The CEO may only write to people on the manager's list; the office enforces it, not the prompt.
import type { EmailRecipient, EmailSettings, EmailView } from './types.ts';

export type { EmailRecipient, EmailSettings };

/** Most people on the list. */
export const MAX_RECIPIENTS = 25;
export const MAX_NAME = 60;
/** Most emails the CEO may send (or have waiting) in any 24 hours. */
export const EMAILS_PER_DAY = 10;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_EMAIL: EmailSettings = { enabled: false, from: '', copyTo: '', recipients: [] };

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

/** What's wrong with a settings patch, in words Settings → Email can show; null when nothing is. */
export function emailProblem(patch: unknown): string | null {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof EmailSettings, unknown>>;
  if (p.from !== undefined && p.from !== '' && !emailAddress(p.from)) return "The From address isn't a valid email address.";
  if (p.recipients !== undefined) {
    if (!Array.isArray(p.recipients)) return 'The list of recipients is missing.';
    if (p.recipients.length > MAX_RECIPIENTS) return `At most ${MAX_RECIPIENTS} people fit on the list.`;
    const bad = (p.recipients as { email?: unknown }[]).find((r) => !emailAddress(r?.email));
    if (bad) return `"${String(bad?.email ?? '')}" isn't a valid email address.`;
  }
  if (p.copyTo !== undefined && p.copyTo !== '' && !emailAddress(p.copyTo)) return "The copy-to address isn't a valid email address.";
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
  return { enabled: typeof p.enabled === 'boolean' ? p.enabled : b.enabled, from, copyTo, recipients };
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
