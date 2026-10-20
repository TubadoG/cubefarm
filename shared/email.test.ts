import { describe, expect, it } from 'vitest';
import { DAY_MS, DEFAULT_EMAIL, emailAddress, emailFooter, emailProblem, emailSettings, emailsToday, emailText, findRecipient, MAX_NAME, MAX_RECIPIENTS } from './email.ts';

const ada = { email: 'ada@acme.example.com', name: 'Ada', approve: true };
const base = { enabled: true, from: 'ceo@co.example.com', copyTo: '', recipients: [ada] };

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
    expect(emailSettings(DEFAULT_EMAIL, {})).toEqual({ enabled: false, from: '', copyTo: '', recipients: [] });
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
