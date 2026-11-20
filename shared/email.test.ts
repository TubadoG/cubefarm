import { describe, expect, it } from 'vitest';
import { capRefusal, capUsage, colleaguesOffList, dailyCap, DAY_MS, DEFAULT_DAILY_CAP, MAX_DAILY_CAP, DEFAULT_DIGEST, DEFAULT_EMAIL, emailAddress, findColleague, MAX_COLLEAGUES, emailHtml, emailFooter, emailProblem, emailSettings, emailsToday, emailText, findRecipient, MAX_MINE, MAX_NAME, MAX_RECIPIENTS, replyNote } from './email.ts';

const ada = { email: 'ada@acme.example.com', name: 'Ada', approve: true };
const base = { enabled: true, from: 'ceo@co.example.com', copyTo: '', recipients: [ada], digest: DEFAULT_DIGEST, inbox: false, mine: [] as string[], colleagues: [] as { email: string; name: string }[], dailyCap: 20 };

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
    expect(emailSettings(DEFAULT_EMAIL, {})).toEqual({ enabled: false, from: '', copyTo: '', recipients: [], digest: { enabled: false, hour: 8, to: '' }, inbox: false, mine: [], colleagues: [], dailyCap: 20 });
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

  it('keeps a daily cap from 1 to 100; anything else keeps the old one', () => {
    expect(emailSettings(base, { dailyCap: 25 }).dailyCap).toBe(25);
    expect(emailSettings(base, { dailyCap: 1 }).dailyCap).toBe(1);
    expect(emailSettings(base, { dailyCap: MAX_DAILY_CAP }).dailyCap).toBe(MAX_DAILY_CAP);
    const set = { ...base, dailyCap: 35 };
    for (const bad of [0, -3, 101, 2.5, '30', null, NaN]) expect(emailSettings(set, { dailyCap: bad }).dailyCap).toBe(35);
    expect(emailSettings(set, { enabled: false }).dailyCap).toBe(35);
  });

  it('gives settings saved before the cap could change the default of 20', () => {
    const { dailyCap: _, ...old } = { ...base, dailyCap: 0 };
    expect(emailSettings(DEFAULT_EMAIL, old).dailyCap).toBe(DEFAULT_DAILY_CAP);
    expect(DEFAULT_DAILY_CAP).toBe(20);
    expect(dailyCap({})).toBe(20);
    expect(dailyCap({ dailyCap: 500 })).toBe(20);
  });

  it('says what is wrong with a patch', () => {
    for (const bad of [0, 101, 2.5, '30']) expect(emailProblem({ dailyCap: bad })).toBe('The daily cap must be a whole number from 1 to 100.');
    expect(emailProblem({ dailyCap: 40 })).toBeNull();
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

  it('refuses at the configured cap, and says so with its number', () => {
    const now = 10 * DAY_MS;
    const three = [1, 2, 3].map((i) => ({ status: 'sent' as const, createdAt: now - i * 1000 }));
    expect(capRefusal({ dailyCap: 4 }, three, now)).toBeNull();
    expect(capRefusal({ dailyCap: 3 }, three, now)).toBe("The office sends at most 3 emails in any 24 hours, and they're used up.");
    expect(capRefusal({ dailyCap: 1 }, three, now)).toBe("The office sends at most 1 email in any 24 hours, and they're used up.");
    expect(capRefusal({ dailyCap: 3 }, three, now + DAY_MS)).toBeNull(); // the window rolled on
  });

  it('shows the count beside the cap', () => {
    expect(capUsage(4, 20)).toBe('4 of 20 used in the last 24 hours');
  });
});

describe('the footer', () => {
  it('says who sent it and what happens to a reply, in two lines under the body', () => {
    expect(emailFooter('Acme', 'read').split('\n')).toHaveLength(2);
    const text = emailText('Hello.\n\n', 'Acme', 'office');
    expect(text).toBe("Hello.\n\n-- \nSent by the CEO of Acme's office, an AI agent running in cubefarm.\nReplies to this address aren't read; answer in the office.");
    expect(emailFooter('Acme', 'read')).toMatch(/Reply to this email to answer the CEO\.$/);
    expect(emailFooter('Acme', 'unread')).toMatch(/Replies to this address aren't read\.$/);
  });

  it('promises an answer only to the manager’s own addresses, and only while the office reads its mailbox', () => {
    const s = { inbox: true, mine: ['me@co.example.com'] };
    expect(replyNote(s, 'ME@co.example.com')).toBe('read');
    expect(replyNote({ ...s, inbox: false }, 'me@co.example.com')).toBe('office');
    expect(replyNote(s, 'client@acme.example.com')).toBe('unread');
  });
});

describe('reading replies', () => {
  const withCopy = emailSettings(base, { recipients: [ada], copyTo: ada.email });

  it('is off with nobody listed by default', () => {
    expect(emailSettings(base, {})).toMatchObject({ inbox: false, mine: [] });
  });

  it('counts the blind-copy address as the manager’s when switched on with nobody listed', () => {
    expect(emailSettings(withCopy, { inbox: true })).toMatchObject({ inbox: true, mine: [ada.email] });
    // Already on, and the list emptied on purpose: it stays empty.
    const on = emailSettings(withCopy, { inbox: true });
    expect(emailSettings(on, { mine: [] }).mine).toEqual([]);
  });

  it('takes a list of addresses, lowercased and deduplicated, and refuses a bad one', () => {
    expect(emailSettings(base, { mine: ['Me@Co.example.com', 'me@co.example.com', 'you@co.example.com'] }).mine).toEqual(['me@co.example.com', 'you@co.example.com']);
    expect(emailProblem({ mine: ['nope'] })).toMatch(/isn't a valid email address/);
    expect(emailProblem({ mine: 'me@co.example.com' })).toMatch(/missing/);
    expect(emailProblem({ mine: Array.from({ length: MAX_MINE + 1 }, (_, i) => `a${i}@co.example.com`) })).toMatch(/At most/);
    expect(emailProblem({ inbox: 'yes' })).toMatch(/on or off/);
    expect(emailSettings(base, { mine: ['nope'] }).mine).toEqual([]);
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
    const html = emailHtml('<p>Hi</p>', 'A<B', 'unread');
    expect(html).toContain('<p>Hi</p>');
    expect(html).toContain("Sent by the CEO of A&lt;B's office".replace("'", '&#39;'));
    expect(html).toContain('Replies to this address aren&#39;t read.');
  });
});

describe('colleagues', () => {
  const marcus = { email: 'marcus@co.example.com', name: 'Marcus' };

  it('cleans the list like the others: lowercased, trimmed, deduped, a name from the address when there is none', () => {
    const s = emailSettings(base, { colleagues: [{ email: ' Marcus@CO.example.com ', name: '  Marcus \n the agent ' }, { email: 'marcus@co.example.com', name: 'Again' }, { email: 'ops@co.example.com' }] });
    expect(s.colleagues).toEqual([
      { email: 'marcus@co.example.com', name: 'Marcus the agent' },
      { email: 'ops@co.example.com', name: 'ops' },
    ]);
  });

  it('refuses a bad address or too many, and keeps the old list', () => {
    const s = emailSettings(base, { colleagues: [marcus] });
    expect(emailProblem({ colleagues: [{ email: 'nope', name: 'X' }] })).toBe('"nope" isn\'t a valid email address.');
    expect(emailProblem({ colleagues: 'marcus' })).toBe('The list of colleagues is missing.');
    const many = Array.from({ length: MAX_COLLEAGUES + 1 }, (_, i) => ({ email: `a${i}@co.example.com`, name: '' }));
    expect(emailProblem({ colleagues: many })).toBe(`At most ${MAX_COLLEAGUES} colleagues fit on the list.`);
    expect(emailProblem({ colleagues: [marcus] })).toBeNull();
    expect(emailSettings(s, { colleagues: [{ email: 'nope' }] }).colleagues).toEqual([marcus]);
    expect(emailSettings(s, { colleagues: many }).colleagues).toEqual([marcus]);
    expect(emailSettings(s, { colleagues: [] }).colleagues).toEqual([]);
  });

  it('migrates a saved state without the field to an empty list, and keeps the list through other patches', () => {
    const { colleagues: _, ...old } = base;
    expect(emailSettings(DEFAULT_EMAIL, old).colleagues).toEqual([]);
    const s = emailSettings(base, { colleagues: [marcus] });
    expect(emailSettings(s, { enabled: false }).colleagues).toEqual([marcus]);
  });

  it('lets the manager win: an address on both lists is theirs', () => {
    const s = { mine: ['marcus@co.example.com'], colleagues: [marcus] };
    expect(findColleague(s, 'marcus@co.example.com')).toBeUndefined();
    expect(findColleague({ mine: [], colleagues: [marcus] }, ' MARCUS@co.example.com')).toEqual(marcus);
    expect(findColleague({ mine: [], colleagues: [marcus] }, 'ada@acme.example.com')).toBeUndefined();
  });

  it('names the colleagues the CEO can’t answer: not on the send list', () => {
    expect(colleaguesOffList({ recipients: [ada], colleagues: [marcus] })).toEqual([marcus]);
    expect(colleaguesOffList({ recipients: [ada, { ...marcus, approve: false }], colleagues: [marcus] })).toEqual([]);
  });

  it('promises a colleague that a reply is read only while the office reads its mailbox', () => {
    expect(replyNote({ inbox: true, mine: [], colleagues: [marcus] }, marcus.email)).toBe('read');
    expect(replyNote({ inbox: false, mine: [], colleagues: [marcus] }, marcus.email)).toBe('unread');
  });
});
