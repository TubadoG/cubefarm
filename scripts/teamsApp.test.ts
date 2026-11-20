import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildPackage, crc32, fillManifest, manifestIdFor, parseArgs, type AppOptions } from './teamsApp.ts';

const TEMPLATE = readFileSync(path.join(import.meta.dirname, '..', 'teams-app', 'manifest.json'), 'utf8');
const APP = '0d3e0000-0000-4000-8000-00000000c1e0';

/** The files in a zip, by name (enough of a reader for the zips buildPackage writes). */
function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const data = inflateRawSync(buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size));
    expect(crc32(data)).toBe(buf.readUInt32LE(at + 14));
    out[name] = data;
    at += 30 + nameLen + size;
  }
  return out;
}

describe('the Teams app package', () => {
  const o = parseArgs(['--app-id', APP.toUpperCase(), '--tab-url', 'https://tabs.example.net/office-ceo', '--name', 'Zander']) as AppOptions;

  it('takes the app id and the tab’s address, and refuses bad ones', () => {
    expect(o).toMatchObject({ appId: APP, tabUrl: 'https://tabs.example.net/office-ceo/', name: 'Zander', manifestId: manifestIdFor(APP) });
    expect(parseArgs(['--tab-url', 'https://x.example/'])).toEqual({ error: expect.stringMatching(/--app-id/) });
    expect(parseArgs(['--app-id', APP, '--tab-url', 'http://x.example/'])).toEqual({ error: expect.stringMatching(/--tab-url/) });
    expect(parseArgs(['--app-id', APP])).toEqual({ error: expect.stringMatching(/--tab-url/) });
  });

  it('gives the same app a stable Teams app id of its own', () => {
    expect(manifestIdFor(APP)).toBe(manifestIdFor(APP.toUpperCase()));
    expect(manifestIdFor(APP)).not.toBe(APP);
    expect(manifestIdFor(APP)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is manifest v1.25 with RSC to read channel messages, a team and personal bot and a team tab, all on the one app id', () => {
    const m = JSON.parse(fillManifest(TEMPLATE, o));
    expect(m.manifestVersion).toBe('1.25');
    expect(m.supportsChannelFeatures).toBe('tier1');
    expect(m.webApplicationInfo).toEqual({ id: APP, resource: 'https://RscPermission' });
    expect(m.authorization.permissions.resourceSpecific).toEqual([{ name: 'ChannelMessage.Read.Group', type: 'Application' }]);
    // The bot in the team's channel and in a person's 1:1 chat (direct chat).
    expect(m.bots).toEqual([expect.objectContaining({ botId: APP, scopes: ['team', 'personal'] })]);
    expect(m.version).toBe('1.1.0');
    expect(m.configurableTabs).toEqual([expect.objectContaining({ configurationUrl: 'https://tabs.example.net/office-ceo/config.html', scopes: ['team'] })]);
    expect(m.validDomains).toEqual(['tabs.example.net']);
    expect(m.name.short).toBe('Zander');
    expect(m.id).toBe(manifestIdFor(APP));
  });

  it('escapes what it fills in, and refuses a template with a gap left', () => {
    expect(JSON.parse(fillManifest(TEMPLATE, { ...o, name: 'Z "the" CEO' })).name.short).toBe('Z "the" CEO');
    expect(() => fillManifest('{"x":"{{NOPE}}"}', o)).toThrow('{{NOPE}}');
  });

  it('zips the manifest and two PNG icons at its root', () => {
    const files = unzip(buildPackage(TEMPLATE, o));
    expect(Object.keys(files)).toEqual(['manifest.json', 'color.png', 'outline.png']);
    expect(JSON.parse(files['manifest.json'].toString('utf8')).bots[0].botId).toBe(APP);
    for (const [name, size] of [
      ['color.png', 192],
      ['outline.png', 32],
    ] as const) {
      expect(files[name].subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(files[name].readUInt32BE(16)).toBe(size);
      expect(files[name].readUInt32BE(20)).toBe(size);
    }
  });
});
