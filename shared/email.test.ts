import { describe, expect, it } from 'vitest';
import { DAY_MS, DEFAULT_DIGEST, DEFAULT_EMAIL, emailAddress, emailHtml, emailFooter, emailProblem, emailSettings, emailsToday, emailText, findRecipient, MAX_NAME, MAX_RECIPIENTS } from './email.ts';

const ada = { email: 'ada@acme.example.com', name: 'Ada', approve: true };
const base = { enabled: true, from: 'ceo@co.example.com', copyTo: '', recipients: [ada], digest: DEFAULT_DIGEST };

describe('email addresses', () => {
  it('trims and lowercases good ones', () => {
    expect(emailAddress('  Ada.Lovelace+cf@Acme.Example.COM ')).toBe('ada.lovelace+cf@acme.example.com');
  });

  it('refuses what is not one', () => {
    for (const bad of ['', 'ada', 'ada@', '@acme.com', 'ada@acme', 'a da@acme.com', 'ada@acme.com, bob@x.com', '"ada"@acme.com', 42, null]) expect(emailAddress(bad)).toBeNull();
  });
});

describe('email settings', () => {
  it('starts off and empty', () => {
    expect(emailSettings(DEFAULT_EMAIL, {})).toEqual({ enabled: false, from: '', copyTo: '', recipients: [], digest: { enabled: false, hour: 8, to: '' } });
  });

  it('cleans the list: lowercased, deduped, names trimmed and capped, asking by default', () => {
    const s = emailSettings(DEFAULT_EMAIL, {
      recipients: [
        { email: ' Ada@Acme.Example.com ', name: '  Ada  ' },
        { email: 'ada@acme.example.com', name: 'Again', approve: false },
        { email: 'bob@acme.example.com', name: 'x'.repeat(100), approve: false },
        { email: 'cy@acme.example.com' },
      ],
    });
    expect(s.recipients).toEqual([
      { email: 'ada@acme.example.com', name: 'Ada', approve: true },
      { email: 'bob@acme.example.com', name: 'x'.repeat(MAX_NAME), approve: false },
      { email: 'cy@acme.example.com', name: 'cy', approve: true },
    ]);
  });

  it('keeps the old list when the new one has a bad address or too many people', () => {
    expect(emailSettings(base, { recipients: [{ email: 'nope' }] }).recipients).toEqual([ada]);
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ email: `p${i}@x.example.com` }));
    expect(emailSettings(base, { recipients: many }).recipients).toEqual([ada]);
  });

  it('needs a real From address; empty clears it', () => {
    expect(emailSettings(base, { from: 'not an address' }).from).toBe('ceo@co.example.com');
    expect(emailSettings(base, { from: ' CEO@New.example.com' }).from).toBe('ceo@new.example.com');
    expect(emailSettings(base, { from: '' }).from).toBe('');
  });

  it('copies only someone on the list, and drops the copy when they leave it', () => {
    expect(emailSettings(base, { copyTo: 'ADA@acme.example.com' }).copyTo).toBe('ada@acme.example.com');
    expect(emailSettings(base, { copyTo: 'eve@evil.example.com' }).copyTo).toBe('');
    const copied = { ...base, copyTo: ada.email };
    expect(emailSettings(copied, { recipients: [] }).copyTo).toBe('');
  });

  it('says what is wrong with a patch', () => {
    expect(emailProblem({ from: 'nope' })).toMatch(/From address/);
    expect(emailProblem({ recipients: [{ email: 'bad' }] })).toBe('"bad" isn\'t a valid email address.');
    expect(emailProblem({ recipients: Array.from({ length: 26 }, (_, i) => ({ email: `p${i}@x.example.com` })) })).toMatch(/At most 25/);
    expect(emailProblem({ enabled: true, from: '', recipients: [ada] })).toBeNull();
  });
});

describe('the allowlist and the daily cap', () => {
  it('finds people by address, whatever the case', () => {
    expect(findRecipient(base, ' ADA@acme.example.com')).toEqual(ada);
    expect(findRecipient(base, 'eve@evil.example.com')).toBeUndefined();
    expect(findRecipient(base, 'garbage')).toBeUndefined();
  });

  it('counts sent and waiting emails of the last 24 hours', () => {
    const now = 10 * DAY_MS;
    const at = (status: 'sent' | 'pending' | 'declined' | 'failed', ago: number) => ({ status, createdAt: now - ago });
    expect(emailsToday([at('sent', 1000), at('pending', 5000), at('declined', 1000), at('failed', 1000), at('sent', DAY_MS + 1)], now)).toBe(2);
  });
});

describe('the footer', () => {
  it('says who sent it and where replies go, in two lines under the body', () => {
    expect(emailFooter('Acme', 'ceo@acme.example.com').split('\n')).toHaveLength(2);
    const text = emailText('Hello.\n\n', 'Acme', 'ceo@acme.example.com');
    expect(text).toBe("Hello.\n\n-- \nSent by the CEO of Acme's office, an AI agent running in cubefarm.\nReplies go to ceo@acme.example.com.");
  });
});

describe('the daily digest settings', () => {
  const sam = { email: 'sam@co.example.com', name: 'Sam', approve: false };
  const both = { ...base, recipients: [ada, sam] };

  it('takes someone on the list without “Ask me”, an hour and the switch', () => {
    const d = { enabled: true, hour: 7, to: 'SAM@co.example.com' };
    expect(emailProblem({ ...both, digest: d }, both)).toBeNull();
    expect(emailSettings(both, { digest: d }).digest).toEqual({ enabled: true, hour: 7, to: sam.email });
  });

  it('refuses someone off the list, or who needs an OK, with why', () => {
    expect(emailProblem({ digest: { to: 'eve@evil.example.com' } }, both)).toMatch(/isn't on the list/);
    expect(emailProblem({ digest: { to: ada.email } }, both)).toMatch(/without “Ask me”/);
    expect(emailProblem({ digest: { to: 'nope' } }, both)).toMatch(/isn't a valid email address/);
    // Someone added in the same patch counts.
    expect(emailProblem({ recipients: [sam], digest: { to: sam.email } }, base)).toBeNull();
  });

  it('refuses an hour outside 0-23, and turning it on with nobody to send to', () => {
    for (const hour of [-1, 24, 7.5, '8']) expect(emailProblem({ digest: { hour } }, both)).toMatch(/whole hour/);
    expect(emailProblem({ digest: { enabled: true, to: '' } }, both)).toBe('Pick who gets the digest first.');
    expect(emailSettings(both, { digest: { hour: 30 } }).digest.hour).toBe(8);
  });

  it('stops when its recipient leaves the list or starts needing an OK', () => {
    const on = emailSettings(both, { digest: { enabled: true, hour: 8, to: sam.email } });
    expect(emailSettings(on, { recipients: [ada] }).digest).toEqual({ enabled: false, hour: 8, to: '' });
    expect(emailSettings(on, { recipients: [ada, { ...sam, approve: true }] }).digest.to).toBe('');
    // A full patch from Settings → Email that keeps the old digest isn't refused for it.
    expect(emailProblem({ ...on, recipients: [ada] }, on)).toBeNull();
  });
});

describe('emailHtml', () => {
  it('puts the footer under the body, escaped', () => {
    const html = emailHtml('<p>Hi</p>', 'A<B', 'ceo@co.example.com');
    expect(html).toContain('<p>Hi</p>');
    expect(html).toContain("Sent by the CEO of A&lt;B's office".replace("'", '&#39;'));
    expect(html).toContain('Replies go to ceo@co.example.com.');
  });
});
