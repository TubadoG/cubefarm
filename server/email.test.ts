import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { HttpError } from './httpError.ts';
import { Swarm } from './swarm.ts';
import type { OfficeTools } from './ceo.ts';
import { EMAILS_PER_DAY } from '../shared/email.ts';

// The CEO's email (docs/email.md): only to the manager's list, some after the manager's OK, at most a few a day, and
// the list is checked again when the manager approves. Through the demo's fake transport, so nothing is sent.
type Internals = { ensureCeo(interrupted: unknown[]): void; officeTools(): OfficeTools };

const AUTO = { email: 'manager@co.example.com', name: 'Sam', approve: false };
const ASK = { email: 'ada@acme.example.com', name: 'Ada', approve: true };
const BAD = { email: 'bad-box@acme.example.com', name: 'Broken', approve: false };

async function office() {
  const swarm = new Swarm(createDemoBackend());
  (swarm as unknown as Internals).ensureCeo([]);
  await swarm.mailer.init(); // the demo's fake sender
  swarm.updateSettings({ email: { enabled: true, from: 'ceo@co.example.com', copyTo: AUTO.email, recipients: [AUTO, ASK, BAD], digest: { enabled: false, hour: 8, to: '' } } });
  const tools = (swarm as unknown as Internals).officeTools();
  const send = (to: string, subject = 'Weekly report') => tools.call('send_email', { to, subject, body: 'All floors are green.' });
  return { swarm, send, emails: () => swarm.snapshot().emails, messages: () => swarm.snapshot().messages };
}

describe('send_email', () => {
  it('refuses anyone not on the list, and says how to fix it', async () => {
    const { send, emails } = await office();
    expect(await send('eve@evil.example.com')).toBe("Refused: eve@evil.example.com is not on the manager's approved list; ask the manager to add them in Settings → Email.");
    expect(emails()).toEqual([]);
  });

  it('refuses while email is off', async () => {
    const { swarm, send } = await office();
    swarm.updateSettings({ email: { ...swarm.snapshot().settings.email, enabled: false } });
    expect(await send(AUTO.email)).toMatch(/^Refused: Email is off/);
  });

  it('sends at once to someone who needs no OK, and tells the phone', async () => {
    const { send, emails, messages } = await office();
    expect(await send('Manager@CO.example.com')).toBe('Sent to Sam <manager@co.example.com>.');
    expect(emails()).toMatchObject([{ to: AUTO.email, toName: 'Sam', subject: 'Weekly report', body: 'All floors are green.', status: 'sent' }]);
    expect(messages().at(-1)).toMatchObject({ from: 'office', text: '📧 Emailed Sam: Weekly report' });
  });

  it('records a failed send with why', async () => {
    const { send, emails } = await office();
    expect(await send(BAD.email)).toMatch(/^Refused: The email to Broken failed: The demo mail server doesn't know/);
    expect(emails()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('bad-box@acme.example.com') });
  });

  it('waits for the manager when the recipient needs an OK, then sends it', async () => {
    const { swarm, send, emails, messages } = await office();
    expect(await send(ASK.email)).toBe("Waiting for the manager's OK: the email to Ada goes out once they approve it.");
    const [e] = emails();
    expect(e).toMatchObject({ status: 'pending', decidedAt: null });
    expect(messages().at(-1)).toMatchObject({ from: 'ceo', emailId: e.id });
    await swarm.approveEmail(e.id);
    expect(emails()[0]).toMatchObject({ status: 'sent', decidedAt: expect.any(Number) });
    await expect(swarm.approveEmail(e.id)).rejects.toThrow('That email was already sent');
  });

  it('a declined email never goes out, and keeps the note for the CEO', async () => {
    const { swarm, send, emails } = await office();
    await send(ASK.email);
    const id = emails()[0].id;
    swarm.declineEmail(id, 'Not yet');
    expect(emails()[0]).toMatchObject({ status: 'declined', note: 'Not yet' });
    expect(() => swarm.declineEmail(id)).toThrow(HttpError);
    expect(() => swarm.declineEmail('nope')).toThrow('That email no longer exists');
  });

  it('checks the list again when the manager approves', async () => {
    const { swarm, send, emails } = await office();
    await send(ASK.email);
    const id = emails()[0].id;
    swarm.updateSettings({ email: { ...swarm.snapshot().settings.email, recipients: [AUTO] } });
    await expect(swarm.approveEmail(id)).rejects.toThrow("ada@acme.example.com is not on the manager's approved list");
    expect(emails()[0]).toMatchObject({ status: 'failed' });
  });

  it(`stops at ${EMAILS_PER_DAY} a day, counting the ones waiting`, async () => {
    const { send, emails } = await office();
    for (let i = 0; i < EMAILS_PER_DAY; i++) expect(await send(ASK.email, `Report ${i}`)).toMatch(/^Waiting/);
    expect(await send(ASK.email)).toMatch(/^Refused: The office sends at most 10 emails a day/);
    expect(emails()).toHaveLength(EMAILS_PER_DAY);
  });
});

describe('Settings → Email', () => {
  it('refuses a bad address with a readable message', async () => {
    const { swarm } = await office();
    expect(() => swarm.updateSettings({ email: { ...swarm.snapshot().settings.email, from: 'nope' } })).toThrow("The From address isn't a valid email address.");
  });

  it('shows only whether a sender is set, never its secret', async () => {
    const { swarm } = await office();
    const view = swarm.snapshot().emailSender;
    expect(view).toMatchObject({ set: true, mode: 'secret' });
    expect(JSON.stringify(swarm.snapshot())).not.toContain('demo-not-a-secret');
  });

  it('the test email needs a copy-to address', async () => {
    const { swarm } = await office();
    expect(await swarm.testEmail()).toEqual({ ok: true, to: AUTO.email });
    swarm.updateSettings({ email: { ...swarm.snapshot().settings.email, copyTo: '' } });
    await expect(swarm.testEmail()).rejects.toThrow(/copy-to address/);
  });
});

describe('the daily digest', () => {
  type DigestInternals = { syncRepo(id: string): Promise<void>; digestTick(now?: Date): Promise<void>; state: { digestSentDay: string | null } };

  async function withFloor() {
    const o = await office();
    const repo = await o.swarm.connectRepo('demo-co/pixel-todo');
    const internals = o.swarm as unknown as DigestInternals;
    await internals.syncRepo(repo.id);
    const digest = (d: object) => o.swarm.updateSettings({ email: { ...o.swarm.snapshot().settings.email, digest: { ...o.swarm.snapshot().settings.email.digest, ...d } } });
    return { ...o, internals, digest };
  }

  it('goes only to someone on the list without “Ask me”', async () => {
    const { swarm, digest } = await withFloor();
    await expect(swarm.sendDigest()).rejects.toThrow('Pick who gets the digest');
    expect(() => digest({ to: ASK.email })).toThrow(/without “Ask me”/);
    expect(() => digest({ to: 'eve@evil.example.com' })).toThrow(/isn't on the list/);
  });

  it('sends now through the email path: needs-input issues with their latest comment', async () => {
    const { swarm, digest, emails, messages } = await withFloor();
    digest({ to: AUTO.email });
    expect(await swarm.sendDigest()).toEqual({ sent: true, to: AUTO.email, subject: 'Office: 1 decision waiting' });
    const [e] = emails();
    expect(e).toMatchObject({ to: AUTO.email, status: 'sent', subject: 'Office: 1 decision waiting' });
    expect(e.body).toContain('Which colour palette for v2?');
    expect(e.body).toContain('> Two options in the mockups');
    expect(messages().at(-1)?.text).toBe('📧 Sent the daily digest to Sam: Office: 1 decision waiting');
  });

  it('counts toward the daily cap', async () => {
    const { swarm, send, digest } = await withFloor();
    digest({ to: AUTO.email });
    for (let i = 0; i < EMAILS_PER_DAY; i++) await send(ASK.email, `Report ${i}`);
    await expect(swarm.sendDigest()).rejects.toThrow(/at most 10 emails a day/);
  });

  it('goes out once a day at the hour, and remembers the day', async () => {
    const { internals, digest, emails } = await withFloor();
    digest({ to: AUTO.email, enabled: true, hour: 9 });
    await internals.digestTick(new Date(2026, 9, 21, 8, 59));
    expect(emails()).toHaveLength(0);
    await internals.digestTick(new Date(2026, 9, 21, 9, 1));
    expect(emails()).toHaveLength(1);
    expect(internals.state.digestSentDay).toBe('2026-10-21');
    await internals.digestTick(new Date(2026, 9, 21, 12, 0));
    expect(emails()).toHaveLength(1);
  });
});
