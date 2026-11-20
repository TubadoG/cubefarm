import { describe, expect, it } from 'vitest';
import { BOT_REPLIES_PER_THREAD, DEFAULT_TEAMS, teamsSettings } from '../shared/teams.ts';
import type { TeamsSettings, TeamsView } from '../shared/types.ts';
import { NO_MESSAGE } from './ceo.ts';
import { HttpError } from './httpError.ts';
import {
  activityFor,
  author,
  colleagueText,
  DENIED_EVERY_MS,
  emptyTeams,
  isAck,
  loadTeams,
  looksLikeDecision,
  managerText,
  mentionsCeo,
  messagesUrl,
  messageText,
  postRequest,
  repliesUrl,
  TeamsChannel,
  type ChannelMessage,
  type TeamsState,
} from './teamsChannel.ts';

// The CEO in Teams (docs/teams.md): who a message is from decides what it is, bots can't loop, the cap holds, nothing is
// delivered twice or replayed, and decisions never go through Teams.

const T0 = Date.parse('2026-11-20T15:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const APP = '0d3e0000-0000-4000-8000-00000000c1e0'; // the CEO's bot (the email sender's app)
const BRYAN = 'e00b07ab-2f12-4a13-a2cd-156a025ae427';
const MARCUS = 'f3d79295-63b0-49d1-85fa-8e57b094ba1b';
const TEAM = '44ffe347-85e3-4917-88c2-176352e79788';
const CHANNEL = '19:57800f254d1046348418f4e838b40f12@thread.tacv2';
const SETTINGS: TeamsSettings = teamsSettings(DEFAULT_TEAMS, { enabled: true, teamId: TEAM, channelId: CHANNEL, managers: [BRYAN], colleagues: [{ name: 'Marcus', appId: MARCUS }] });

const atZander = [{ id: 0, mentionText: 'Zander', mentioned: { application: { id: APP, displayName: 'Zander' } } }];
let seq = 1763650000000;
function msg(o: Partial<ChannelMessage> & { by?: 'bryan' | 'marcus' | 'self' | 'guest' | 'otherbot' } = {}): ChannelMessage {
  const by = o.by ?? 'bryan';
  const from = {
    bryan: { user: { id: BRYAN, displayName: 'Bryan Clayton' }, application: null },
    guest: { user: { id: '99999999-0000-4000-8000-000000000001', displayName: 'Bryan Clayton' }, application: null }, // same name, other person
    marcus: { user: null, application: { id: MARCUS, displayName: 'Marcus', applicationIdentityType: 'bot' } },
    otherbot: { user: null, application: { id: '77777777-0000-4000-8000-000000000001', displayName: 'Marcus', applicationIdentityType: 'bot' } }, // a namesake
    self: { user: null, application: { id: APP, displayName: 'Zander', applicationIdentityType: 'bot' } },
  }[by];
  return { id: String(seq++), messageType: 'message', createdDateTime: iso(T0 + 60_000), from, body: { contentType: 'html', content: '<p>Hello</p>' }, mentions: [], ...o };
}

describe('who wrote it', () => {
  const o = { appId: APP, managers: [BRYAN], colleagues: SETTINGS.colleagues };

  it('counts the manager by Entra object id only, never by name', () => {
    expect(author(msg({ by: 'bryan' }), o)).toEqual({ kind: 'manager', id: BRYAN, name: 'Bryan Clayton' });
    expect(author(msg({ by: 'guest' }), o)).toMatchObject({ kind: 'other', reason: 'not yours' });
  });

  it('counts a colleague bot by app id, and a namesake bot as nobody', () => {
    expect(author(msg({ by: 'marcus' }), o)).toMatchObject({ kind: 'colleague', colleague: { name: 'Marcus', appId: MARCUS } });
    expect(author(msg({ by: 'otherbot' }), o).kind).toBe('other');
    // A colleague listed by name only matches its name.
    expect(author(msg({ by: 'otherbot' }), { ...o, colleagues: [{ name: 'marcus', appId: '' }] }).kind).toBe('colleague');
  });

  it('knows its own posts', () => {
    expect(author(msg({ by: 'self' }), o)).toEqual({ kind: 'self' });
  });

  it('sees an @mention of the CEO by app id or name', () => {
    expect(mentionsCeo(msg({ mentions: atZander }), APP, 'Zander')).toBe(true);
    expect(mentionsCeo(msg({ mentions: [{ mentionText: 'zander', mentioned: { user: { id: 'x' } } }] }), APP, 'Zander')).toBe(true);
    expect(mentionsCeo(msg({ mentions: [{ mentionText: 'Marcus', mentioned: { application: { id: MARCUS } } }] }), APP, 'Zander')).toBe(false);
    expect(mentionsCeo(msg(), APP, 'Zander')).toBe(false);
  });
});

describe('the text', () => {
  it('turns Teams HTML into plain lines with @names', () => {
    const m = msg({ body: { contentType: 'html', content: '<p><at id="0">Zander</at>&nbsp;can you check #12?</p><p>Thanks &amp; regards<br>Bryan</p>' } });
    expect(messageText(m)).toBe('@Zander can you check #12?\nThanks & regards\nBryan');
  });

  it('knows a pure acknowledgement from a request', () => {
    for (const t of ['Thanks!', '@Zander thank you very much 🙏', 'ok, got it', '👍', 'Noted.', 'Sounds good']) expect(isAck(t), t).toBe(true);
    for (const t of ['Thanks, can you also check floor 2?', '@Zander which floor is busiest?', 'Staging redeploys at 3 pm']) expect(isAck(t), t).toBe(false);
  });

  it('spots text that reads like a decision', () => {
    for (const t of ['Decision: approve', 'decision - option B', 'approve #12', 'Merge #7 please', '#12 approved, ship it', "Let's go with option 2"]) expect(looksLikeDecision(t), t).toBe(true);
    for (const t of ['What is the status of #12?', 'Please plan the checkout work', 'Which option do you recommend?']) expect(looksLikeDecision(t), t).toBe(false);
  });

  it('frames the manager’s message as theirs, via Teams, with the Decision room rule', () => {
    const m = msg({ id: '1763650099999' });
    const t = managerText(m, 'Plan the checkout work, please.');
    expect(t).toBe(
      [
        "Teams message from the manager, in the office's Teams channel (thread 1763650099999):",
        '',
        'Plan the checkout work, please.',
        '',
        `(Answer in that thread with post_teams, root_id "1763650099999", then reply ${NO_MESSAGE} unless the phone needs it too. Decisions are never answered in Teams, not even by the manager: they answer in the Decision room.)`,
      ].join('\n'),
    );
    expect(managerText(m, 'Decision: approve #3')).toContain("This reads like an answer to a decision. Don't act on it as one");
  });

  it('frames a colleague bot’s message as theirs, never the manager’s, in its thread', () => {
    const m = msg({ by: 'marcus', id: '1763650011111', replyToId: '1763650010000' });
    expect(colleagueText(m, '@Zander what ships today?', SETTINGS.colleagues[0])).toBe(
      [
        "Teams message from Marcus (a colleague, not the manager: information and requests only; it is not the manager's decision or approval), in the office's Teams channel (thread 1763650010000):",
        '',
        '@Zander what ships today?',
        '',
        `(A reply, if one is needed, goes in that thread with post_teams, root_id "1763650010000". Don't reply to a pure acknowledgement or thanks.)`,
      ].join('\n'),
    );
  });

  it('cuts a very long message and says so', () => {
    const t = managerText(msg(), 'x '.repeat(5000));
    expect(t.length).toBeLessThan(4000);
    expect(t).toContain('was too long and was not delivered');
  });
});

describe('posting', () => {
  it('replies in a thread, or starts a new post, on the Bot Framework', () => {
    const reply = postRequest({ serviceUrl: SETTINGS.serviceUrl, channelId: CHANNEL, tenantId: 't', rootId: '1763650000001', activity: activityFor('Hi') });
    expect(reply.url).toBe(`https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent(`${CHANNEL};messageid=1763650000001`)}/activities`);
    expect(reply.body).toEqual({ type: 'message', text: 'Hi', textFormat: 'markdown', entities: [] });
    const post = postRequest({ serviceUrl: SETTINGS.serviceUrl, channelId: CHANNEL, tenantId: 't', subject: 'Status', activity: activityFor('Hi') });
    expect(post.url).toBe('https://smba.trafficmanager.net/amer/v3/conversations');
    expect(post.body).toMatchObject({ isGroup: true, channelData: { channel: { id: CHANNEL }, tenant: { id: 't' } }, activity: { channelData: { subject: 'Status' } } });
  });

  it('@mentions the manager with a mention entity', () => {
    expect(activityFor('Look', { id: BRYAN, name: 'Bryan Clayton' })).toEqual({
      type: 'message',
      text: '<at>Bryan Clayton</at> Look',
      textFormat: 'markdown',
      entities: [{ type: 'mention', text: '<at>Bryan Clayton</at>', mentioned: { id: BRYAN, name: 'Bryan Clayton' } }],
    });
  });

  it('reads the channel with replies, from Graph', () => {
    expect(messagesUrl(TEAM, CHANNEL)).toBe(`https://graph.microsoft.com/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages?$top=20&$expand=replies`);
    expect(repliesUrl(TEAM, CHANNEL, '1')).toContain('/messages/1/replies');
  });
});

// ---------- the poller, through a fake Graph and Bot Framework ----------

type Res = { status: number; body: unknown };

function rig(o: { settings?: Partial<TeamsSettings>; state?: TeamsState; app?: boolean } = {}) {
  let now = T0;
  const state = o.state ?? emptyTeams();
  const settings: TeamsSettings = { ...SETTINGS, ...o.settings };
  const gets: string[] = [];
  const pages: Res[] = [];
  const posts: { url: string; body: unknown; fresh: boolean }[] = [];
  const postReplies: Res[] = [];
  const manager: { text: string; framed: string }[] = [];
  const colleague: string[] = [];
  const notes: string[] = [];
  const saved: string[] = [];
  const views: TeamsView[] = [];
  const delivered: string[] = []; // the state saved last before each delivery
  const teams = new TeamsChannel({
    state: () => state,
    settings: () => settings,
    app: () => (o.app === false ? null : { appId: APP, tenantId: 'b0c5b990-abaf-4c25-b9a0-0ac58ba2b1b4' }),
    ceoName: () => 'Zander',
    managerName: () => 'Bryan',
    get: async (url) => {
      gets.push(url);
      return pages.shift() ?? { status: 200, body: { value: [] } };
    },
    post: async (url, body, fresh) => {
      posts.push({ url, body, fresh });
      return postReplies.shift() ?? { status: 201, body: { id: 'x' } };
    },
    persist: async () => void saved.push(JSON.stringify(state)),
    deliverManager: (text, framed) => {
      manager.push({ text, framed });
      delivered.push(saved.at(-1) ?? '');
    },
    deliverColleague: (framed) => {
      colleague.push(framed);
      delivered.push(saved.at(-1) ?? '');
    },
    note: (t) => void notes.push(t),
    changed: (v) => void views.push(v),
    log: () => undefined,
    now: () => now,
  });
  return { teams, state, settings, gets, pages, posts, postReplies, manager, colleague, notes, saved, views, delivered, advance: (ms: number) => (now += ms) };
}

const page = (...value: ChannelMessage[]): Res => ({ status: 200, body: { value: value.map((m) => ({ replies: [], ...m })) } });
const started = (): TeamsState => ({ ...emptyTeams(), since: iso(T0) });

describe('TeamsChannel: routing', () => {
  it('reads nothing while it’s off or has no app, and says why when asked', async () => {
    const off = rig({ settings: { enabled: false } });
    off.teams.tick();
    expect(off.gets).toEqual([]);
    await expect(off.teams.check(true)).rejects.toBeInstanceOf(HttpError);
    await expect(rig({ app: false }).teams.check(true)).rejects.toThrow(/email sender/);
  });

  it('delivers the manager’s message as theirs, a mentioned colleague bot’s as theirs, and skips its own and everyone else’s', async () => {
    const r = rig({ state: started() });
    const fromBryan = msg({ body: { contentType: 'html', content: '<p>Plan the checkout work</p>' } });
    const fromMarcus = msg({ by: 'marcus', mentions: atZander, body: { contentType: 'html', content: '<p><at id="0">Zander</at> what ships today?</p>' } });
    const own = msg({ by: 'self' });
    const guest = msg({ by: 'guest', body: { contentType: 'html', content: '<p>Decision: approve #1</p>' } });
    const namesake = msg({ by: 'otherbot', mentions: atZander });
    r.pages.push(page(fromBryan, fromMarcus, own, guest, namesake));
    const view = await r.teams.check();
    expect(r.manager.map((m) => m.text)).toEqual(['Plan the checkout work']);
    expect(r.manager[0].framed).toMatch(/^Teams message from the manager, in the office's Teams channel/);
    expect(r.colleague).toHaveLength(1);
    expect(r.colleague[0]).toMatch(/^Teams message from Marcus \(a colleague, not the manager/);
    expect(r.colleague[0]).not.toContain('from the manager,');
    // Its own post is skipped without a trace; the guest and the namesake are listed with why.
    expect(view.items.map((i) => [i.from, i.outcome, i.reason ?? i.colleague])).toEqual([
      ['Marcus', 'ignored', 'a bot or app that isn’t a colleague'],
      ['Bryan Clayton', 'ignored', 'not yours'],
      ['Marcus', 'colleague', 'Marcus'],
      ['Bryan Clayton', 'delivered', undefined],
    ]);
    expect(r.state.seen).toContain(own.id);
  });

  it('leaves the manager’s message to someone else (an @mention, not of the CEO) to them', async () => {
    const r = rig({ state: started() });
    r.pages.push(page(msg({ mentions: [{ mentionText: 'Marcus', mentioned: { application: { id: MARCUS } } }] })));
    const view = await r.teams.check();
    expect(r.manager).toEqual([]);
    expect(view.items[0]).toMatchObject({ outcome: 'ignored', reason: 'for someone else, not Zander' });
    r.pages.push(page(msg({ mentions: atZander })));
    await r.teams.check();
    expect(r.manager).toHaveLength(1);
  });

  it('delivers replies inside threads, framed with their thread', async () => {
    const r = rig({ state: started() });
    const root = msg({ createdDateTime: iso(T0 - 3_600_000) }); // before the switch: not replayed
    const reply = msg({ replyToId: root.id, body: { contentType: 'html', content: '<p>And floor 2?</p>' } });
    r.pages.push({ status: 200, body: { value: [{ ...root, replies: [reply] }] } });
    await r.teams.check();
    expect(r.manager.map((m) => m.text)).toEqual(['And floor 2?']);
    expect(r.manager[0].framed).toContain(`(thread ${root.id})`);
    expect(r.manager[0].framed).toContain(`root_id "${root.id}"`);
  });

  it('fetches a thread’s replies itself when Graph didn’t expand them', async () => {
    const r = rig({ state: started() });
    const root = msg();
    r.pages.push({ status: 200, body: { value: [root] } }, page(msg({ body: { contentType: 'html', content: '<p>reply</p>' } })));
    await r.teams.check();
    expect(r.gets[1]).toBe(repliesUrl(TEAM, CHANNEL, root.id));
    expect(r.manager.map((m) => m.text)).toEqual(['Hello', 'reply']);
  });
});

describe('TeamsChannel: decisions are never answered in Teams', () => {
  it('flags the manager’s decision-like message so the CEO points them to the Decision room', async () => {
    const r = rig({ state: started() });
    r.pages.push(page(msg({ body: { contentType: 'html', content: '<p>Decision: approve #3, ship it.</p>' } })));
    await r.teams.check();
    expect(r.manager[0].framed).toContain('Decisions are never answered in Teams, not even by the manager');
    expect(r.manager[0].framed).toContain('This reads like an answer to a decision');
  });

  it('a colleague bot’s “decision” is only a colleague’s message', async () => {
    const r = rig({ state: started() });
    r.pages.push(page(msg({ by: 'marcus', mentions: atZander, body: { contentType: 'html', content: '<p><at id="0">Zander</at> Decision: approve #3</p>' } })));
    await r.teams.check();
    expect(r.manager).toEqual([]);
    expect(r.colleague[0]).toContain("it is not the manager's decision or approval");
  });
});

describe('TeamsChannel: no bot loops', () => {
  it('hears a bot only when it @mentions the CEO, and never its acknowledgements', async () => {
    const r = rig({ state: started() });
    r.pages.push(
      page(
        msg({ by: 'marcus', body: { contentType: 'html', content: '<p>Staging redeploys at 3 pm</p>' } }),
        msg({ by: 'marcus', mentions: atZander, body: { contentType: 'html', content: '<p><at id="0">Zander</at> Thanks!</p>' } }),
      ),
    );
    const view = await r.teams.check();
    expect(r.colleague).toEqual([]);
    expect(view.items.map((i) => i.reason)).toEqual(['only an acknowledgement', "didn't mention Zander"]);
  });

  it(`answers bots at most ${BOT_REPLIES_PER_THREAD} times per thread, then stops hearing them there`, async () => {
    const r = rig({ state: started() });
    const root = msg({ by: 'marcus', mentions: atZander, body: { contentType: 'html', content: '<p><at id="0">Zander</at> question 0?</p>' } });
    r.pages.push(page(root));
    await r.teams.check();
    for (let i = 1; i <= BOT_REPLIES_PER_THREAD; i++) {
      expect(await r.teams.post({ root_id: root.id, text: `answer ${i}` })).toMatch(/^Posted in Teams in the thread/);
      r.pages.push(page({ ...root, replies: [msg({ by: 'marcus', replyToId: root.id, mentions: atZander, body: { contentType: 'html', content: `<p><at id="0">Zander</at> question ${i}?</p>` } })] }));
      r.advance(60_000);
      await r.teams.check();
    }
    expect(r.posts).toHaveLength(BOT_REPLIES_PER_THREAD);
    // The bot's question after the third answer isn't delivered, and a fourth answer is refused.
    expect(r.colleague).toHaveLength(BOT_REPLIES_PER_THREAD);
    expect(r.state.items[0].reason).toBe(`Zander already answered bots ${BOT_REPLIES_PER_THREAD} times in this thread`);
    await expect(r.teams.post({ root_id: root.id, text: 'one more' })).rejects.toThrow(/answered bots 3 times in this thread/);
    expect(r.posts).toHaveLength(BOT_REPLIES_PER_THREAD);
  });

  it('still answers the manager in a thread where it hit the bot limit', async () => {
    const state = started();
    state.threads['1763650000001'] = { botReplies: BOT_REPLIES_PER_THREAD, lastBot: true, at: T0 };
    const r = rig({ state });
    r.pages.push(page({ ...msg({ id: '1763650000001', createdDateTime: iso(T0 - 1000) }), replies: [msg({ replyToId: '1763650000001' })] }));
    await r.teams.check();
    expect(r.manager).toHaveLength(1);
    await expect(r.teams.post({ root_id: '1763650000001', text: 'Sure' })).resolves.toMatch(/^Posted/);
  });
});

describe('TeamsChannel: the daily cap', () => {
  it('refuses posts past the day’s cap, apart from email’s, and frees them after 24 hours', async () => {
    const r = rig({ state: started(), settings: { postsPerDay: 2 } });
    await r.teams.post({ text: 'one' });
    await r.teams.post({ text: 'two' });
    expect(r.teams.view().postsToday).toBe(2);
    await expect(r.teams.post({ text: 'three' })).rejects.toThrow('The office posts at most 2 Teams messages a day');
    expect(r.posts).toHaveLength(2);
    r.advance(24 * 60 * 60 * 1000 + 1);
    await expect(r.teams.post({ text: 'next day' })).resolves.toMatch(/^Posted in Teams as a new post\. 1 post left today\./);
  });

  it('counts only posts that went out', async () => {
    const r = rig({ state: started(), settings: { postsPerDay: 1 } });
    r.postReplies.push({ status: 403, body: { error: { code: 'BotNotInConversationRoster', message: 'no' } } });
    await expect(r.teams.post({ text: 'x' })).rejects.toThrow(/HTTP 403, BotNotInConversationRoster.*isn’t installed/);
    expect(r.teams.view().postsToday).toBe(0);
  });

  it('refuses when Teams is off, and a root id that isn’t one', async () => {
    await expect(rig({ settings: { enabled: false } }).teams.post({ text: 'x' })).rejects.toThrow('Teams is off');
    await expect(rig({ state: started() }).teams.post({ root_id: '../x', text: 'x' })).rejects.toThrow(/root_id/);
  });

  it('@mentions the manager by id, with the name Teams showed', async () => {
    const r = rig({ state: started() });
    r.pages.push(page(msg()));
    await r.teams.check();
    await r.teams.post({ text: 'Look', mention_manager: true });
    expect((r.posts[0].body as { activity: { entities: unknown[] } }).activity.entities).toEqual([{ type: 'mention', text: '<at>Bryan Clayton</at>', mentioned: { id: BRYAN, name: 'Bryan Clayton' } }]);
  });

  it('gets a fresh token once after a 401', async () => {
    const r = rig({ state: started() });
    r.postReplies.push({ status: 401, body: null });
    await r.teams.post({ text: 'x' });
    expect(r.posts.map((p) => p.fresh)).toEqual([false, true]);
  });
});

describe('TeamsChannel: once only, never replayed', () => {
  it('starts from now: messages written before the switch went on are never delivered', async () => {
    const r = rig();
    r.teams.switchedOn();
    expect(r.state.since).toBe(iso(T0));
    r.pages.push(page(msg({ createdDateTime: iso(T0 - 1) }), msg({ createdDateTime: iso(T0 - 86_400_000) })));
    const view = await r.teams.check();
    expect(r.manager).toEqual([]);
    expect(view.items).toEqual([]);
  });

  it('delivers each message once, saved before delivery, and not again after a restart', async () => {
    const r = rig({ state: started() });
    const m = msg();
    r.pages.push(page(m));
    await r.teams.check();
    expect(r.delivered).toHaveLength(1);
    expect((JSON.parse(r.delivered[0]) as TeamsState).seen).toContain(m.id);
    // Listed again on the next check, and after a restart from the saved state: still once.
    r.pages.push(page(m));
    await r.teams.check();
    const again = rig({ state: loadTeams(JSON.parse(r.saved.at(-1)!)) });
    again.pages.push(page(m));
    await again.teams.check();
    expect(r.manager).toHaveLength(1);
    expect(again.manager).toEqual([]);
  });

  it('a first check with no start time starts now and saves that before reading', async () => {
    const r = rig();
    await r.teams.check();
    expect(JSON.parse(r.saved[0]).since).toBe(iso(T0));
  });
});

describe('TeamsChannel: errors', () => {
  it('tells the manager once about a 403 and backs off to 30 minutes', async () => {
    const r = rig({ state: started() });
    r.pages.push({ status: 403, body: { error: { code: 'Forbidden' } } }, { status: 403, body: null });
    const v = await r.teams.check();
    expect(v.lastError).toMatch(/HTTP 403/);
    expect(r.notes).toHaveLength(1);
    r.advance(SETTINGS.pollSeconds * 1000);
    r.teams.tick();
    expect(r.gets).toHaveLength(1); // still backing off
    r.advance(DENIED_EVERY_MS);
    await r.teams.check();
    expect(r.notes).toHaveLength(1); // told once
    r.pages.push(page());
    await r.teams.check();
    expect(r.state.deniedAt).toBeNull();
    expect(r.teams.view().lastError).toBeNull();
  });

  it('says when the team or channel isn’t found', async () => {
    const r = rig({ state: started() });
    r.pages.push({ status: 404, body: { error: { code: 'NotFound', message: 'x' } } });
    expect((await r.teams.check()).lastError).toMatch(/can't find that team or channel/);
  });

  it('retries a 401 once with a fresh token', async () => {
    const r = rig({ state: started() });
    const calls: boolean[] = [];
    const t = new TeamsChannel({
      ...(r.teams as unknown as { deps: ConstructorParameters<typeof TeamsChannel>[0] }).deps,
      get: async (_url, fresh) => (calls.push(fresh), fresh ? { status: 200, body: { value: [] } } : { status: 401, body: null }),
    });
    await t.check();
    expect(calls).toEqual([false, true]);
  });
});

describe('the saved state', () => {
  it('loads an old or broken state as empty, and keeps what is valid', () => {
    expect(loadTeams(undefined)).toEqual(emptyTeams());
    expect(loadTeams({ since: 'nope', seen: [1, 'a'], threads: { abc: { botReplies: 1 }, '1763650000001': { botReplies: 2, lastBot: true, at: 5 } }, posts: [1, 'x'], names: { a: 'A', b: 2 } })).toEqual({
      ...emptyTeams(),
      seen: ['a'],
      threads: { '1763650000001': { botReplies: 2, lastBot: true, at: 5 } },
      posts: [1],
      names: { a: 'A' },
    });
  });
});
