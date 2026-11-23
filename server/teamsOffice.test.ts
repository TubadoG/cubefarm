import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_INPUT } from '../shared/brief.ts';
import type { DecisionView } from '../shared/decisions.ts';
import { DEFAULT_TEAMS, teamsSettings } from '../shared/teams.ts';
import { askedFor, ceoJobPrompt, ceoSystemPrompt, COLLEAGUE_NO_DECISION, jobLabel, mayFileIssue, TEAMS_NO_DECISION, type CeoJob, type OfficeTools } from './ceo.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';
import type { ChannelMessage, TeamsDeps, TeamsState } from './teamsChannel.ts';
import type { PullInfo, QaView } from '../shared/types.ts';

// Teams in the office (docs/teams.md): the manager's Teams message is the manager's (a chat job that may file work),
// a colleague bot's is a colleague job. Numbered card commands are applied before the CEO reads them; close stays in the room.
type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  officeTools(): OfficeTools;
  decisionViews(): DecisionView[];
  ceoAsked: boolean;
  ceoTeams: boolean;
  state: {
    ceo: { job: CeoJob | null; queue: CeoJob[] };
    decisions: { number: number; answeredAt: number | null }[];
    messages: { from: string; text: string; via?: string }[];
    settings: { teams: ReturnType<typeof teamsSettings> };
  };
};

const REPO = 'demo-co/weather-api';
const BRIEF = ['## Decision brief', '### Background', 'Rate limits need a number.', '### The decision', 'How many requests a minute?', '### Options', '- 60: safe', '- 600: generous', '### Recommendation', '60: it protects the free tier.', '### Risk and mitigation', 'Heavy users hit it.'].join('\n');
const FRAMED = 'Teams message from the manager, in the office\'s Teams channel (thread 1763650000001):\n\nDecision: approve #1\n\n(Answer in that thread …)';

async function sync(swarm: Swarm) {
  const rt = (swarm as unknown as { repoRt: Map<string, { syncing?: boolean }> }).repoRt.get(REPO);
  while (rt?.syncing) await new Promise((r) => setTimeout(r, 5));
  await swarm.syncRepo(REPO);
}

async function office() {
  const backend = createDemoBackend();
  const swarm = new Swarm(backend);
  const savedStates: string[] = [];
  // Several demo offices run together in the suite: keep this office's saved JSON apart from their temp files.
  Object.assign(swarm, { writeStateFile: async () => { savedStates.push(JSON.stringify((swarm as unknown as Internals).state)); } });
  // What init() does for a demo office without saved settings: its made-up channel, switched off.
  (swarm as unknown as Internals).state.settings.teams = teamsSettings(DEFAULT_TEAMS, backend.email.demoTeams);
  await swarm.connectRepo(REPO);
  const internals = swarm as unknown as Internals;
  internals.ensureCeo([]);
  const n = await backend.createIssue(REPO, `Rate limit ${Math.random().toString(36).slice(2, 6)}`, BRIEF, [NEEDS_INPUT]);
  await sync(swarm);
  await swarm.decisionTick(Date.now() - 1000);
  return { backend, swarm, internals, n, savedStates };
}

describe('Teams jobs', () => {
  it('a manager’s Teams message is their request; a colleague bot’s is not', () => {
    const manager: CeoJob = { kind: 'chat', text: FRAMED, teams: true, at: 0 };
    const colleague: CeoJob = { kind: 'colleague', text: 'Teams message from Marcus (a colleague, …)', teams: true, at: 0 };
    expect(askedFor(manager)).toBe(true);
    expect(askedFor(colleague)).toBe(false);
    expect(mayFileIssue(colleague, { autoPlan: false })).toBe(false);
    expect(jobLabel(colleague, null)).toBe("Reading a colleague's message");
  });

  it('frames a colleague job with Teams in it, with the rules against loops', () => {
    const p = ceoJobPrompt({ kind: 'colleague', text: 'Teams message from Marcus', teams: true, at: 0 }, null);
    expect(p).toMatch(/^Message from a colleague .*by email or in Teams, not from the manager/);
    expect(p).toContain("never the manager's decision or approval");
    expect(p).toContain('post_teams in its thread');
    expect(p).toContain('Never reply to an acknowledgement, thanks or FYI');
    // Email-only colleague jobs read as before.
    expect(ceoJobPrompt({ kind: 'colleague', text: 'x', at: 0 }, null)).toMatch(/^Email from a colleague/);
  });

  it('tells the CEO the Teams rules only while Teams is on', () => {
    const base = { name: 'Zander', company: 'BC', manager: 'Bryan', notesFile: 'NOTES.md', sessionLimit: 0, maxAgents: 6, scaling: 'approve' as const };
    expect(ceoSystemPrompt({ ...base, teams: true })).toContain("The office applies the manager's numbered Teams card commands");
    expect(ceoSystemPrompt(base)).not.toContain('post_teams');
  });
});

describe('Teams in the office', () => {
  it('the manager’s Teams message reaches the CEO as theirs, marked Teams on the phone, framed for the CEO', async () => {
    const { swarm, internals } = await office();
    await swarm.messageCeo('Decision: approve #1', 'teams', FRAMED);
    const last = internals.state.messages.at(-1)!;
    expect(last).toMatchObject({ from: 'manager', text: 'Decision: approve #1', via: 'teams' });
    const job = internals.state.ceo.queue.find((j) => j.kind === 'chat');
    expect(job).toMatchObject({ text: FRAMED, teams: true });
    // A phone message after it merges into the same job, which stays a Teams job.
    await swarm.messageCeo('Also, how is floor 1?');
    expect(internals.state.ceo.queue.filter((j) => j.kind === 'chat')).toHaveLength(1);
    expect(internals.state.ceo.queue.find((j) => j.kind === 'chat')?.teams).toBe(true);
  });

  it('the manager’s Teams direct message is theirs too, marked Teams DM on the phone, a Teams job', async () => {
    const { swarm, internals } = await office();
    await swarm.messageCeo('How is floor 1?', 'teams-dm', 'Teams direct message from the manager, in their 1:1 chat with you in Teams (message 1):\n\nHow is floor 1?');
    expect(internals.state.messages.at(-1)).toMatchObject({ from: 'manager', text: 'How is floor 1?', via: 'teams-dm' });
    expect(internals.state.ceo.queue.find((j) => j.kind === 'chat')).toMatchObject({ teams: true });
    expect(askedFor(internals.state.ceo.queue.find((j) => j.kind === 'chat')!)).toBe(true);
  });

  it('never closes an open decision in a job with the manager’s Teams direct message', async () => {
    const { swarm, internals, n } = await office();
    await swarm.messageCeo('approve #1', 'teams-dm', 'Teams direct message from the manager …');
    internals.state.ceo.job = internals.state.ceo.queue.find((j) => j.kind === 'chat')!;
    internals.ceoAsked = true;
    expect(await internals.officeTools().call('close_issue', { floor: 1, number: n, reason: 'The manager approved it in a DM.' })).toBe(`Refused: ${TEAMS_NO_DECISION}`);
    expect(internals.state.decisions.find((d) => d.number === n)?.answeredAt).toBeNull();
    internals.state.ceo.job = null;
  });

  it('Direct chat on, the demo manager’s chat reaches the CEO by the rules, and the CEO answers in it', async () => {
    const { swarm, internals } = await office();
    await swarm.mailer.init();
    expect(() => swarm.updateSettings({ teams: { direct: true, managers: [] } as never })).toThrow(/Entra object id first/);
    swarm.updateSettings({ teams: { direct: true } as never });
    const view = await swarm.teams.check(true);
    expect(view.direct).toEqual([{ id: internals.state.settings.teams.managers[0], name: 'The manager', status: 'found' }]);
    expect(view.items.map((i) => [i.outcome, i.source])).toEqual([
      ['delivered', 'direct'],
      ['delivered', 'direct'],
    ]); // the CEO's own message: skipped
    expect(internals.state.messages.filter((m) => m.via === 'teams-dm').map((m) => m.text)).toEqual(['Quick one: how many pull requests are open?', 'Just between us: approve #2, go ahead.']);
    // Queued, or already picked up by the demo CEO.
    const job = [...internals.state.ceo.queue, internals.state.ceo.job].find((j) => j?.kind === 'chat');
    expect(job?.text).toContain('If this was meant as a card answer');
    // The CEO's answer goes in that chat, counted with the channel's posts.
    const before = swarm.teams.view().postsToday;
    expect(await internals.officeTools().call('post_teams', { direct_to: internals.state.settings.teams.managers[0], text: 'Two are open.' })).toMatch(/^Posted in the manager's Teams direct chat/);
    expect(swarm.teams.view().postsToday).toBeGreaterThan(before);
    expect((await swarm.teams.check(true)).items).toHaveLength(2); // nothing twice
  });

  it('a colleague bot’s Teams message is a colleague job, never the manager’s', async () => {
    const { swarm, internals } = await office();
    const before = internals.state.messages.length;
    swarm.colleagueTeams('Teams message from Marcus (a colleague, not the manager: …)');
    expect(internals.state.ceo.queue.find((j) => j.kind === 'colleague')).toMatchObject({ teams: true });
    expect(internals.state.ceo.queue.filter((j) => j.kind === 'chat')).toEqual([]);
    expect(internals.state.messages.slice(before).filter((m) => m.from === 'manager')).toEqual([]);
  });

  it('never closes an open decision in a job with the manager’s Teams message, though the manager asked', async () => {
    const { internals, n } = await office();
    internals.state.ceo.job = { kind: 'chat', text: FRAMED, teams: true, at: Date.now() };
    internals.ceoAsked = true;
    internals.ceoTeams = true;
    const out = await internals.officeTools().call('close_issue', { floor: 1, number: n, reason: 'Decision: the manager said so in Teams.' });
    expect(out).toBe(`Refused: ${TEAMS_NO_DECISION}`);
    expect(internals.decisionViews().some((d) => d.number === n)).toBe(true);
    expect(internals.state.decisions.find((d) => d.number === n)?.answeredAt).toBeNull();
    internals.state.ceo.job = null;
    internals.ceoTeams = false;
  });

  it('nor when the manager’s Teams message arrives in a running job', async () => {
    const { internals, n } = await office();
    internals.state.ceo.job = { kind: 'chat', text: 'From the phone', at: Date.now() };
    internals.ceoAsked = true;
    internals.ceoTeams = true; // what messageCeo(…, 'teams') sets when it injects into the running session
    expect(await internals.officeTools().call('close_issue', { floor: 1, number: n, reason: 'x' })).toBe(`Refused: ${TEAMS_NO_DECISION}`);
    internals.state.ceo.job = null;
    internals.ceoTeams = false;
  });

  it('nor in a colleague bot’s Teams job', async () => {
    const { internals, n } = await office();
    internals.state.ceo.job = { kind: 'colleague', text: 'Teams message from Marcus', teams: true, at: Date.now() };
    internals.ceoAsked = false;
    expect(await internals.officeTools().call('close_issue', { floor: 1, number: n, reason: 'x' })).toBe(`Refused: ${COLLEAGUE_NO_DECISION}`);
    internals.state.ceo.job = null;
  });

  it('refuses post_teams while Teams is off, and a bad settings patch', async () => {
    const { swarm, internals } = await office();
    expect(await internals.officeTools().call('post_teams', { text: 'Hello' })).toBe('Refused: Teams is off. The manager turns it on in Settings → Teams.');
    expect(() => swarm.updateSettings({ teams: { enabled: true, teamId: '', channelId: '' } as never })).toThrow('Set the team id and the channel id first.');
    expect(() => swarm.updateSettings({ teams: { managers: ['bryan'] } as never })).toThrow(/Entra object id/);
  });

  it('switching on starts from now, and the demo’s channel reaches the CEO by the rules', async () => {
    const { swarm, internals } = await office();
    expect(internals.state.settings.teams).toMatchObject({ enabled: false, colleagues: [{ name: 'Nova' }] }); // the demo's made-up channel, off
    await swarm.mailer.init(); // the demo's made-up sender: the CEO's bot (SWARM_HOME is a temp folder in tests)
    swarm.updateSettings({ teams: { enabled: true } as never });
    const view = await swarm.teams.check(true);
    const out = Object.fromEntries(view.items.map((i) => [`${i.from}: ${i.outcome}`, i.reason ?? '']));
    expect(out).toMatchObject({
      'The manager: delivered': '',
      'Nova: colleague': '',
      'Sam (guest): ignored': 'not yours',
    });
    expect(view.items.filter((i) => i.from === 'Nova' && i.outcome === 'ignored').map((i) => i.reason).sort()).toEqual([expect.stringMatching(/^didn't mention/), 'only an acknowledgement']);
    expect(view.items.some((i) => i.from === 'CEO')).toBe(false); // its own post: skipped
    expect(internals.state.messages.filter((m) => m.via === 'teams').map((m) => m.text)).toEqual(['Which floor is busiest right now?', 'Decision: approve #3, ship it.']);
    // Read again: nothing twice.
    const again = await swarm.teams.check(true);
    expect(again.items).toHaveLength(view.items.length);
    expect(internals.state.messages.filter((m) => m.via === 'teams')).toHaveLength(2);
  });

  it('keeps an office’s saved Teams settings, and starts one saved before Teams with them off', () => {
    expect(teamsSettings(DEFAULT_TEAMS, undefined).enabled).toBe(false);
  });
});

// Exercise the real poller and decision actions with the demo GitHub and fake Graph/Bot Framework calls.
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

async function decisionOffice(source: 'channel' | 'direct' = 'channel') {
  const o = await office();
  await o.swarm.mailer.init();
  vi.useFakeTimers();
  o.swarm.updateSettings({ teams: { enabled: source === 'channel', direct: source === 'direct' } as never });
  const deps = (o.swarm.teams as unknown as { deps: TeamsDeps }).deps;
  const state = deps.state();
  const managerId = o.internals.state.settings.teams.managers[0];
  const messages: ChannelMessage[] = [];
  const get = vi.spyOn(o.swarm.mailer, 'get').mockImplementation(async () => ({ status: 200, body: { value: messages } }));
  const post = vi.spyOn(o.swarm.mailer, 'botPost').mockResolvedValue({ status: 201, body: { id: 'fake-direct-conversation' } });
  const comment = vi.spyOn(o.backend, 'commentIssue');
  const decide = vi.spyOn(deps, 'decide');
  const log = vi.spyOn(deps, 'log');
  let seq = Date.now();
  const message = (text: string, patch: Partial<ChannelMessage> = {}) => {
    const m: ChannelMessage = {
      id: String(++seq), createdDateTime: new Date(Date.now() + 1000).toISOString(), messageType: 'message',
      from: { user: { id: managerId, displayName: 'Bryan Clayton' } }, body: { contentType: 'text', content: text }, replies: [], ...patch,
    };
    messages.push(m);
    return m;
  };
  const replies = () => post.mock.calls.filter(([, body]) => (body as { type?: string }).type === 'message');
  return { ...o, deps, state, managerId, messages, message, get, post, comment, decide, log, replies };
}

describe('Teams card answers', () => {
  it.each(['channel', 'direct'] as const)('applies manager approval once from %s, after saving and before CEO delivery', async (source) => {
    const o = await decisionOffice(source);
    const m = o.message(`approve #${o.n}`, source === 'channel' ? { replyToId: '1763650099999' } : {});
    const order: string[] = [];
    const persist = o.deps.persist.bind(o.deps);
    vi.spyOn(o.deps, 'persist').mockImplementation(async () => { await persist(); order.push('saved'); });
    o.comment.mockImplementation(async () => {
      expect(order[0]).toBe('saved');
      expect(o.state.seen).toContain(source === 'direct' ? `dm:${m.id}` : m.id);
      expect(JSON.parse(o.savedStates.at(-1)!).teams.seen).toContain(source === 'direct' ? `dm:${m.id}` : m.id);
      order.push('applied');
    });
    const deliver = o.deps.deliverManager.bind(o.deps);
    vi.spyOn(o.deps, 'deliverManager').mockImplementation(async (...args) => { expect(order).toContain('applied'); await deliver(...args); });
    await o.swarm.teams.check(true);
    await o.swarm.teams.check(true);
    expect(o.decide).toHaveBeenCalledOnce();
    expect(o.decide.mock.calls[0][1]).toMatchObject({ source, rootId: m.replyToId || m.id, managerId: o.managerId });
    if (source === 'direct') expect(o.decide.mock.calls[0][1].chatId).toContain(o.managerId);
    expect(o.comment).toHaveBeenCalledExactlyOnceWith(REPO, o.n, expect.stringContaining('in Teams (cubefarm)._'));
    expect(o.internals.decisionViews().some((d) => d.number === o.n)).toBe(false);
    expect(o.replies()).toHaveLength(1);
    expect(o.replies()[0][1]).toMatchObject({ text: expect.stringContaining(`Done: #${o.n} approved the recommendation`) });
    expect(o.replies()[0][0]).toContain(source === 'channel' ? 'messageid%3D1763650099999' : 'fake-direct-conversation');
    expect(o.swarm.teams.view().postsToday).toBe(1);
    expect(o.internals.state.messages.some((m) => m.from === 'office' && m.text.startsWith('Teams: Bryan Clayton '))).toBe(true);
    expect(o.internals.state.ceo.queue.find((j) => j.kind === 'chat')?.text).toContain('Do not answer them again.');
    // A restarted poller loaded with the saved seen ids also skips it.
    const { TeamsChannel, loadTeams } = await import('./teamsChannel.ts');
    const saved: TeamsState = loadTeams(JSON.parse(JSON.stringify(o.state)));
    await new TeamsChannel({ ...o.deps, state: () => saved }).check(true);
    expect(o.decide).toHaveBeenCalledOnce();
  });

  it('applies commands addressed to another colleague and still delivers them to the CEO', async () => {
    const o = await decisionOffice();
    o.message(`@Nova approve #${o.n}`, { mentions: [{ mentionText: 'Nova', mentioned: { application: { id: 'another-app' } } }] });
    await o.swarm.teams.check(true);
    expect(o.comment).toHaveBeenCalledOnce();
    expect(o.internals.state.messages.some((m) => m.via === 'teams')).toBe(true);
  });

  it('does not apply a colleague bot or a non-manager with the manager’s display name', async () => {
    const o = await decisionOffice();
    const colleague = o.internals.state.settings.teams.colleagues[0];
    o.message(`approve #${o.n}`, { from: { application: { id: colleague.appId, displayName: colleague.name } }, mentions: [{ mentionText: o.deps.ceoName() }] });
    o.message(`approve #${o.n}`, { from: { user: { id: 'not-the-manager', displayName: 'Bryan Clayton' } } });
    await o.swarm.teams.check(true);
    expect(o.decide).not.toHaveBeenCalled();
    expect(o.comment).not.toHaveBeenCalled();
    expect(o.post).not.toHaveBeenCalled();
    expect(o.internals.state.ceo.queue.some((j) => j.kind === 'colleague')).toBe(true);
  });

  it.each(['channel', 'direct'] as const)('does not apply quoted or forwarded commands in %s', async (source) => {
    const o = await decisionOffice(source);
    o.message('', { body: { contentType: 'html', content: `<blockquote><p>approve #${o.n}</p></blockquote>` } });
    o.message(`Forwarded message:\napprove #${o.n}`);
    o.message(`> approve #${o.n}`);
    o.message('', { body: { contentType: 'html', content: '<attachment id="forwarded"></attachment>' }, attachments: [{ content: `approve #${o.n}` }] });
    await o.swarm.teams.check(true);
    expect(o.decide).not.toHaveBeenCalled();
    expect(o.comment).not.toHaveBeenCalled();
  });

  it('replies once with missing, closed, close-only, missing-number and invalid-option results', async () => {
    const o = await decisionOffice();
    o.message(`approve #999999\nclose #${o.n}\nyes on the merge\noption 9 on #${o.n}`);
    await o.swarm.teams.check(true);
    expect(o.comment).not.toHaveBeenCalled();
    expect(o.replies()).toHaveLength(1);
    expect((o.replies()[0][1] as { text: string }).text.split('\n')).toEqual([
      'Not done: No open card #999999.', `Not done: Close #${o.n} only in the Decision room.`,
      'Not done: Which card? Include its number, for example approve #114.', 'Not done: The brief has no option 9.',
    ]);
    await o.backend.closeIssue(REPO, o.n, 'Closed in the test.');
    await o.swarm.syncRepo(REPO);
    o.message(`approve #${o.n}`);
    await o.swarm.teams.check(true);
    expect(o.replies().at(-1)?.[1]).toMatchObject({ text: `Not done: No open card #${o.n}.` });
  });

  it.each([['option 2 on', 'chose option 2: 600: generous'], ['send back', 'answered: Use 90 instead']])('uses the room answer shape for %s', async (command, summary) => {
    const o = await decisionOffice();
    o.message(`${command} #${o.n}${command === 'send back' ? ': Use 90 instead' : ''}`);
    await o.swarm.teams.check(true);
    expect(o.replies()[0][1]).toMatchObject({ text: `Done: #${o.n} ${summary}.` });
    expect(o.comment).toHaveBeenCalledOnce();
  });

  it('asks for the floor when a number is ambiguous, then matches the repo hint case-insensitively', async () => {
    const o = await decisionOffice();
    const other = 'demo-co/pixel-todo';
    await o.swarm.connectRepo(other);
    const x = o.swarm as unknown as { repoRt: Map<string, { syncing?: boolean; issues: { number: number; title: string; url: string; labels: string[]; state: string }[] }> };
    while (x.repoRt.get(other)?.syncing) await Promise.resolve();
    x.repoRt.get(other)!.issues.push({ number: o.n, title: 'Another card', url: '', labels: [NEEDS_INPUT], state: 'OPEN' });
    o.message(`approve #${o.n}`);
    await o.swarm.teams.check(true);
    expect(o.comment).not.toHaveBeenCalled();
    expect(o.replies()[0][1]).toMatchObject({ text: `Not done: #${o.n} is open on more than one floor: write approve weather-api #${o.n} or approve pixel-todo #${o.n}.` });
    o.message(`approve WEATHER #${o.n}`);
    await o.swarm.teams.check(true);
    expect(o.comment).toHaveBeenCalledExactlyOnceWith(REPO, o.n, expect.any(String));
  });

  it('queues a stuck PR for QA and clears prep strikes, but refuses retry on an issue card', async () => {
    const o = await decisionOffice();
    const x = o.swarm as unknown as {
      repoRt: Map<string, { pulls: PullInfo[] }>;
      state: { qa: QaView[] };
      repo(id: string): unknown;
      queueQa(repo: unknown, number: number, dev: null, issue: null): void;
      setQa(rec: QaView, patch: object): void;
      prepStrikes: Map<string, unknown>;
    };
    const pr = 87654;
    x.repoRt.get(REPO)!.pulls.push({ number: pr, title: 'Stuck PR', url: '', state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', headRefName: 'swarm/test' } as PullInfo);
    x.queueQa(x.repo(REPO), pr, null, null);
    const rec = x.state.qa.find((q) => q.prNumber === pr)!;
    x.setQa(rec, { status: 'needs-human', escalated: true, qaAgentId: 'stale-agent' });
    x.prepStrikes.set(`${REPO}#${pr}:qa`, { count: 2 });
    x.prepStrikes.set(`${REPO}#${pr}:fix`, { count: 2 });
    o.message(`retry QA #${pr}\nretry qa on #${o.n}`);
    await o.swarm.teams.check(true);
    expect(rec).toMatchObject({ status: 'queued', qaAgentId: null, escalated: false });
    expect(x.prepStrikes.has(`${REPO}#${pr}:qa`)).toBe(false);
    expect(x.prepStrikes.has(`${REPO}#${pr}:fix`)).toBe(false);
    expect(o.replies()[0][1]).toMatchObject({ text: `Done: #${pr} queued for QA.\nNot done: #${o.n} is not a PR card; retry QA needs a PR.` });
  });

  it('applies the decision even when the reply limit is reached and logs the skipped reply', async () => {
    const o = await decisionOffice();
    o.state.posts = Array(o.internals.state.settings.teams.postsPerDay).fill(Date.now());
    o.message(`approve #${o.n}`);
    await o.swarm.teams.check(true);
    expect(o.comment).toHaveBeenCalledOnce();
    expect(o.post).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalledWith(expect.stringMatching(/card-answer reply skipped:.*today's are used up/));
    expect(o.internals.state.ceo.queue.find((j) => j.kind === 'chat')?.text).toContain('Done:');
  });
});
