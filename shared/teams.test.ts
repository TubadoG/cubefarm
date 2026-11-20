import { describe, expect, it } from 'vitest';
import { channelId, DEFAULT_SERVICE_URL, DEFAULT_TEAMS, guid, MAX_MANAGERS, MAX_TEAMS_COLLEAGUES, postsToday, serviceUrl, TEAMS_DAY_MS, teamsProblem, teamsSettings } from './teams.ts';

const TEAM = '44ffe347-85e3-4917-88c2-176352e79788';
const CHANNEL = '19:57800f254d1046348418f4e838b40f12@thread.tacv2';
const BRYAN = 'e00b07ab-2f12-4a13-a2cd-156a025ae427';
const MARCUS = 'f3d79295-63b0-49d1-85fa-8e57b094ba1b';

describe('Teams settings', () => {
  it('start off, with the defaults the owner picked', () => {
    expect(teamsSettings(DEFAULT_TEAMS, {})).toEqual({
      enabled: false,
      teamId: '',
      channelId: '',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      pollSeconds: 60,
      managers: [],
      colleagues: [],
      postsPerDay: 40,
    });
  });

  it('migrate an office saved before Teams existed (no teams key) to the defaults, switched off', () => {
    expect(teamsSettings(DEFAULT_TEAMS, undefined)).toEqual(DEFAULT_TEAMS);
    expect(teamsSettings(undefined, { enabled: true })).toEqual(DEFAULT_TEAMS); // no channel: can't be on
  });

  it('take valid ids, lowercased and trimmed, and keep the old value for an invalid one', () => {
    const s = teamsSettings(DEFAULT_TEAMS, { teamId: ` ${TEAM.toUpperCase()} `, channelId: encodeURIComponent(CHANNEL), managers: [BRYAN.toUpperCase(), BRYAN], colleagues: [{ name: ' Marcus ', appId: MARCUS }, { name: 'marcus' }] });
    expect(s).toMatchObject({ teamId: TEAM, channelId: CHANNEL, managers: [BRYAN], colleagues: [{ name: 'Marcus', appId: MARCUS }] });
    const kept = teamsSettings(s, { teamId: 'nope', channelId: 'general', serviceUrl: 'https://evil.example.com/', pollSeconds: 5, postsPerDay: 0, managers: ['bryan'], colleagues: [{ appId: MARCUS }] });
    expect(kept).toEqual(s);
  });

  it('can be switched on only with a team and a channel', () => {
    expect(teamsProblem({ enabled: true })).toBe('Set the team id and the channel id first.');
    expect(teamsProblem({ enabled: true, teamId: TEAM, channelId: CHANNEL })).toBeNull();
    expect(teamsSettings(DEFAULT_TEAMS, { enabled: true, teamId: TEAM, channelId: CHANNEL }).enabled).toBe(true);
    // Clearing the channel switches it off.
    const on = teamsSettings(DEFAULT_TEAMS, { enabled: true, teamId: TEAM, channelId: CHANNEL });
    expect(teamsSettings(on, { channelId: '' }).enabled).toBe(false);
  });

  it('explain what is wrong with a patch', () => {
    expect(teamsProblem({ teamId: 'abc' })).toMatch(/team's group id/);
    expect(teamsProblem({ channelId: 'General' })).toMatch(/19:…@thread.tacv2/);
    expect(teamsProblem({ serviceUrl: 'http://smba.trafficmanager.net/amer/' })).toMatch(/Microsoft host/);
    expect(teamsProblem({ serviceUrl: 'https://smba.trafficmanager.net.evil.com/' })).toMatch(/Microsoft host/);
    expect(teamsProblem({ pollSeconds: 10 })).toMatch(/30 to 3600 seconds/);
    expect(teamsProblem({ pollSeconds: 60.5 })).toMatch(/30 to 3600 seconds/);
    expect(teamsProblem({ postsPerDay: 0 })).toMatch(/from 1 to 200/);
    expect(teamsProblem({ managers: ['bryan@bc.example.com'] })).toBe('"bryan@bc.example.com" isn\'t an Entra object id (a GUID).');
    expect(teamsProblem({ managers: Array.from({ length: MAX_MANAGERS + 1 }, () => BRYAN) })).toMatch(/At most 10/);
    expect(teamsProblem({ colleagues: [{ name: '' }] })).toBe('Each colleague bot needs a name.');
    expect(teamsProblem({ colleagues: [{ name: 'Marcus', appId: 'x' }] })).toMatch(/isn't an app id/);
    expect(teamsProblem({ colleagues: Array.from({ length: MAX_TEAMS_COLLEAGUES + 1 }, (_, i) => ({ name: `b${i}` })) })).toMatch(/At most 10/);
    expect(teamsProblem({ enabled: 'yes' })).toBe('Teams is on or off.');
    expect(teamsProblem({ pollSeconds: 120, postsPerDay: 10, managers: [BRYAN], colleagues: [{ name: 'Marcus', appId: MARCUS }, { name: 'Nova' }] })).toBeNull();
  });
});

describe('ids and URLs', () => {
  it('know a GUID and a channel id', () => {
    expect(guid(TEAM)).toBe(TEAM);
    expect(guid('44ffe347')).toBeNull();
    expect(channelId(CHANNEL)).toBe(CHANNEL);
    expect(channelId('19%3A57800f254d1046348418f4e838b40f12%40thread.tacv2')).toBe(CHANNEL);
    expect(channelId('19:x@thread.tacv2')).toBeNull();
  });

  it('send the bot’s token only to Bot Framework hosts', () => {
    expect(serviceUrl(DEFAULT_SERVICE_URL)).toBe(DEFAULT_SERVICE_URL);
    expect(serviceUrl('https://smba.trafficmanager.net/emea')).toBe('https://smba.trafficmanager.net/emea/');
    expect(serviceUrl('https://smba.trafficmanager.net/amer/?x=1')).toBeNull();
    expect(serviceUrl('https://attacker.example.com/amer/')).toBeNull();
    expect(serviceUrl('https://user:pw@smba.trafficmanager.net/amer/')).toBeNull();
  });
});

describe('the daily count', () => {
  it('counts the posts of the last 24 hours', () => {
    const now = 1_000_000_000_000;
    expect(postsToday([now - TEAMS_DAY_MS, now - TEAMS_DAY_MS + 1, now - 5, now], now)).toBe(3);
  });
});
