import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL, emailSettings } from '../shared/email.ts';
import type { EmailInboxView, EmailSettings } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { CEO_MAX, ceoText, DENIED_EVERY_MS, emptyInbox, type GraphMessage, inboxUrl, INBOX_EVERY_MS, KEEP_IDS, loadInbox, MailInbox, screen, type InboxState } from './mailInbox.ts';

// Replies to the office mailbox (docs/email.md, "Reading replies"): the screen (the manager's addresses, the sender
// checks, auto-replies), what the CEO gets, and the poller through a fake Graph: exactly once across restarts, the
// first start, and the 401 and 403 paths.
const ME = 'bryan@bcco.example.com';
const T0 = Date.UTC(2026, 10, 18, 15, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000', '');
const INTERNAL = [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' }];

function mail(over: Partial<GraphMessage> = {}, from = ME): GraphMessage {
  const who = { emailAddress: { address: from, name: 'Bryan' } };
  return {
    id: 'AAMk-1',
    internetMessageId: '<m1@bcco.example.com>',
    from: who,
    sender: who,
    subject: 'Re: Weekly report',
    uniqueBody: { contentType: 'text', content: 'Put the checkout fix first.' },
    receivedDateTime: iso(T0 + 60_000),
    hasAttachments: false,
    attachments: [],
    internetMessageHeaders: INTERNAL,
    ...over,
  };
}

const opts = { mine: [ME], officeDomain: 'bcco.example.com' };

describe('screen', () => {
  it('passes the manager’s own internal email', () => {
    expect(screen(mail(), opts)).toEqual({ ok: true });
  });

  it('ignores anyone not marked as the manager’s, even someone the CEO may email', () => {
    expect(screen(mail({}, 'ada@acme.example.com'), { ...opts, mine: [ME] })).toEqual({ ok: false, reason: 'not yours' });
    expect(screen(mail({ internetMessageHeaders: [{ name: 'Authentication-Results', value: 'dmarc=pass' }] }, 'ada@acme.example.com'), opts)).toEqual({ ok: false, reason: 'not yours' });
  });

  it('refuses a From that doesn’t match the sender, or a spoof from outside', () => {
    expect(screen(mail({ sender: { emailAddress: { address: 'eve@evil.example.com' } } }), opts)).toEqual({ ok: false, reason: 'failed sender check' });
    expect(screen(mail({ internetMessageHeaders: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Anonymous' }] }), opts)).toEqual({ ok: false, reason: 'failed sender check' });
    expect(screen(mail({ internetMessageHeaders: [] }), opts)).toEqual({ ok: false, reason: 'failed sender check' });
    // The office's own domain must be internal: a DMARC pass from outside isn't enough.
    expect(screen(mail({ internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dmarc=pass' }] }), opts)).toEqual({ ok: false, reason: 'failed sender check' });
  });

  it('believes only the topmost Authentication-Results for another domain', () => {
    const home = 'me@home.example.org';
    const o = { ...opts, mine: [home] };
    const res = (...values: string[]) => mail({ internetMessageHeaders: values.map((value) => ({ name: 'authentication-results', value })) }, home);
    expect(screen(res('spf=pass; dkim=pass; dmarc=pass action=none header.from=home.example.org'), o)).toEqual({ ok: true });
    expect(screen(res('dmarc=fail action=quarantine', 'dmarc=pass (forged by the sender)'), o)).toEqual({ ok: false, reason: 'failed sender check' });
  });

  it('skips auto-replies and bounces, so out-of-office answers never loop', () => {
    const auto = { ok: false, reason: 'auto-reply or bounce' };
    expect(screen(mail({ internetMessageHeaders: [...INTERNAL, { name: 'Auto-Submitted', value: 'auto-replied' }] }), opts)).toEqual(auto);
    expect(screen(mail({ internetMessageHeaders: [...INTERNAL, { name: 'Auto-Submitted', value: 'no' }] }), opts)).toEqual({ ok: true });
    expect(screen(mail({ internetMessageHeaders: [...INTERNAL, { name: 'X-Auto-Response-Suppress', value: 'All' }] }), opts)).toEqual(auto);
    expect(screen(mail({ subject: 'Automatic reply: Weekly report' }), opts)).toEqual(auto);
    expect(screen(mail({}, 'postmaster@bcco.example.com'), opts)).toEqual(auto);
    expect(screen(mail({}, 'MAILER-DAEMON@bcco.example.com'), opts)).toEqual(auto);
  });
});

describe('ceoText', () => {
  it('names the email and its subject, then only the new text', () => {
    expect(ceoText(mail({ uniqueBody: { content: 'First.\r\n\r\n\r\n\r\nSecond.  \r\n' } }))).toBe('Email from the manager. Subject: Re: Weekly report\n\nFirst.\n\nSecond.');
    expect(ceoText(mail({ subject: '  ', uniqueBody: { content: '' } }))).toBe('Email from the manager. Subject: (no subject)\n\n(no text)');
  });

  it('cuts a long body to what the CEO takes, and counts attachments without opening them', () => {
    const t = ceoText(mail({ uniqueBody: { content: 'x'.repeat(10_000) }, hasAttachments: true, attachments: [{ id: 'a' }, { id: 'b' }, { id: 'logo', isInline: true }] }));
    expect(t.length).toBe(CEO_MAX);
    expect(t).toMatch(/x…\n\n\(2 attachments, not read\)$/);
    expect(ceoText(mail({ hasAttachments: true, attachments: undefined }))).toMatch(/\(attachments, not read\)$/);
  });
});

describe('inboxUrl', () => {
  it('asks for the Inbox since the cursor, oldest first, with only the fields the screen needs', () => {
    const u = new URL(inboxUrl('assistance@bcco.example.com', '2026-11-18T15:00:00Z'));
    expect(u.pathname).toBe('/v1.0/users/assistance%40bcco.example.com/mailFolders/inbox/messages');
    expect(u.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-11-18T15:00:00Z');
    expect(u.searchParams.get('$orderby')).toBe('receivedDateTime asc');
    expect(u.searchParams.get('$select')).toContain('uniqueBody');
    expect(u.searchParams.get('$select')).toContain('internetMessageHeaders');
    expect(u.searchParams.get('$select')).not.toMatch(/(^|,)body(,|$)/);
  });
});

// ---------- the poller, through a fake Graph ----------

function rig(o: { settings?: Partial<EmailSettings>; state?: InboxState; replies?: { status: number; body: unknown }[] } = {}) {
  let now = T0;
  const state = o.state ?? emptyInbox();
  const settings = emailSettings(DEFAULT_EMAIL, { enabled: true, from: 'assistance@bcco.example.com', mine: [ME], ...o.settings });
  settings.inbox = o.settings?.inbox ?? true;
  const calls: { url: string; fresh: boolean }[] = [];
  const replies = o.replies ?? [];
  const delivered: string[] = [];
  const notes: string[] = [];
  const saved: string[] = [];
  const views: EmailInboxView[] = [];
  const inbox = new MailInbox({
    state: () => state,
    settings: () => settings,
    ready: () => true,
    get: async (url, fresh) => {
      calls.push({ url, fresh });
      return replies.shift() ?? { status: 200, body: { value: [] } };
    },
    persist: async () => void saved.push(JSON.stringify(state)),
    deliver: (text) => void delivered.push(text),
    note: (text) => void notes.push(text),
    changed: (v) => void views.push(v),
    log: () => undefined,
    now: () => now,
  });
  return { inbox, state, settings, calls, replies, delivered, notes, saved, views, advance: (ms: number) => (now += ms) };
}

const page = (...value: GraphMessage[]) => ({ status: 200, body: { value } });

describe('MailInbox', () => {
  it('reads nothing while it’s off, and says why when asked to check', async () => {
    const r = rig({ settings: { inbox: false } });
    r.inbox.tick();
    expect(r.calls).toEqual([]);
    await expect(r.inbox.check(true)).rejects.toBeInstanceOf(HttpError);
  });

  it('starts from now on its first check, so older mail is never replayed', async () => {
    const r = rig();
    await r.inbox.check();
    expect(r.state.cursor).toBe(new Date(T0).toISOString());
    expect(r.calls[0].url).toContain(encodeURIComponent(`ge ${new Date(T0).toISOString()}`));
    // Saved before anything was read.
    expect(JSON.parse(r.saved[0]).cursor).toBe(new Date(T0).toISOString());
  });

  it('delivers the manager’s email once, saved before it’s delivered, and logs the ignored ones with why', async () => {
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0) } });
    const other = mail({ id: 'AAMk-2', internetMessageId: '<m2@acme>', receivedDateTime: iso(T0 + 30_000) }, 'ada@acme.example.com');
    r.replies.push(page(mail(), other));
    const view = await r.inbox.check();
    expect(r.delivered).toEqual(['Email from the manager. Subject: Re: Weekly report\n\nPut the checkout fix first.']);
    expect(view.items.map((i) => [i.from, i.outcome, i.reason])).toEqual([
      [ME, 'delivered', undefined],
      ['ada@acme.example.com', 'ignored', 'not yours'],
    ]);
    // The delivered email's id and the cursor past it were saved before delivery.
    const before = JSON.parse(r.saved.at(-1)!) as InboxState;
    expect(before.seen).toContain('<m1@bcco.example.com>');
    expect(before.cursor).toBe(iso(T0 + 60_000));
    // Graph lists it again (the cursor is inclusive), and after a restart: still once.
    r.replies.push(page(mail()));
    await r.inbox.check();
    const again = rig({ state: loadInbox(JSON.parse(JSON.stringify(r.state))), replies: [page(mail())] });
    await again.inbox.check();
    expect(r.delivered).toHaveLength(1);
    expect(again.delivered).toHaveLength(0);
    expect(again.calls[0].url).toContain(encodeURIComponent(`ge ${iso(T0 + 60_000)}`));
  });

  it('keeps the last 500 ids', async () => {
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0), seen: Array.from({ length: KEEP_IDS }, (_, i) => `old-${i}`) } });
    r.replies.push(page(mail()));
    await r.inbox.check();
    expect(r.state.seen).toHaveLength(KEEP_IDS);
    expect(r.state.seen.at(-1)).toBe('<m1@bcco.example.com>');
  });

  it('checks every 2 minutes, one check at a time', async () => {
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0) } });
    await Promise.all([r.inbox.check(), r.inbox.check()]);
    expect(r.calls).toHaveLength(1);
    r.inbox.tick();
    expect(r.calls).toHaveLength(1);
    r.advance(INBOX_EVERY_MS);
    r.inbox.tick();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.calls).toHaveLength(2);
  });

  it('gets a new token and tries once more after a 401', async () => {
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0) }, replies: [{ status: 401, body: null }, page(mail())] });
    await r.inbox.check();
    expect(r.calls.map((c) => c.fresh)).toEqual([false, true]);
    expect(r.delivered).toHaveLength(1);
  });

  it('tells the manager once about a 403, then checks every 30 minutes until one succeeds', async () => {
    const denied = { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } };
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0) }, replies: [denied, denied] });
    const v = await r.inbox.check();
    expect(v.lastError).toMatch(/HTTP 403.*Mail\.Read for assistance@bcco\.example\.com/);
    expect(r.notes).toHaveLength(1);
    r.advance(INBOX_EVERY_MS);
    r.inbox.tick();
    expect(r.calls).toHaveLength(1);
    r.advance(DENIED_EVERY_MS);
    await r.inbox.check();
    expect(r.notes).toHaveLength(1); // no repeat
    r.advance(DENIED_EVERY_MS);
    const ok = await r.inbox.check();
    expect(ok.lastError).toBeNull();
    expect(r.state.deniedAt).toBeNull();
  });

  it('records other errors without delivering anything or telling the phone', async () => {
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0) }, replies: [{ status: 503, body: { error: { code: 'ServiceUnavailable', message: 'Try later' } } }] });
    expect((await r.inbox.check()).lastError).toBe('Graph refused to read the mailbox (HTTP 503, ServiceUnavailable): Try later');
    expect(r.notes).toEqual([]);
  });

  it('starts from now again when reading is switched back on', () => {
    const r = rig({ state: { ...emptyInbox(), cursor: iso(T0 - 86_400_000), lastError: 'old' } });
    r.advance(5000);
    r.inbox.switchedOn();
    expect(r.state.cursor).toBe(new Date(T0 + 5000).toISOString());
    expect(r.state.lastError).toBeNull();
  });
});
