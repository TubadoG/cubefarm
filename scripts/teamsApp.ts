// Builds the CEO's Teams app package (docs/teams.md): teams-app/manifest.json filled in with the email sender's app id
// (the bot and the resource-specific consent are that one app), the tab's host, and two generated icons, zipped for
// Teams' "Upload a custom app". No dependencies and no network: a small PNG and zip writer live here.
//
//   node --import tsx scripts/teamsApp.ts --app-id <application (client) id> --tab-url https://<host>/<path>/ [--name Zander]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppOptions {
  appId: string;
  tabUrl: string; // where config.html and content.html are hosted, ending in /
  name: string;
  developer: string;
  website: string;
  manifestId: string;
  out: string;
}

/** The options from the command line, or a message saying what's wrong. */
export function parseArgs(argv: readonly string[]): AppOptions | { error: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? '').trim() : '';
  };
  const appId = get('--app-id').toLowerCase();
  if (!GUID.test(appId)) return { error: "--app-id must be the email sender's application (client) id: Settings → Email shows its last characters." };
  let tab: URL;
  try {
    tab = new URL(get('--tab-url'));
  } catch {
    return { error: '--tab-url must be the https address config.html and content.html are hosted at, e.g. https://example.z13.web.core.windows.net/office-ceo/' };
  }
  if (tab.protocol !== 'https:' || tab.search || tab.hash) return { error: '--tab-url must be a plain https address.' };
  const name = get('--name') || 'Office CEO';
  if (name.length > 30) return { error: '--name is at most 30 characters (Teams’ short name).' };
  const website = get('--website') || 'https://github.com/leonvanzyl/cubefarm';
  if (!/^https:\/\//.test(website)) return { error: '--website must be an https address.' };
  const manifestId = (get('--manifest-id') || manifestIdFor(appId)).toLowerCase();
  if (!GUID.test(manifestId)) return { error: '--manifest-id must be a GUID.' };
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'office-ceo';
  return {
    appId,
    tabUrl: `${tab.origin}${tab.pathname.replace(/\/*$/, '/')}`,
    name,
    developer: get('--developer') || 'cubefarm',
    website,
    manifestId,
    out: get('--out') || path.join(ROOT, 'teams-app', 'build', `${slug}-teams-app.zip`),
  };
}

/** The Teams app's own id: a stable name-based UUID (v5 style) from the bot's app id, so rebuilding updates the same app. */
export function manifestIdFor(appId: string): string {
  const h = createHash('sha1').update(`cubefarm-teams-app:${appId.toLowerCase()}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The manifest template with every {{PLACEHOLDER}} filled (JSON-escaped). Throws when one is left. */
export function fillManifest(template: string, o: Pick<AppOptions, 'appId' | 'tabUrl' | 'name' | 'developer' | 'website' | 'manifestId'>): string {
  const values: Record<string, string> = {
    APP_ID: o.appId,
    MANIFEST_ID: o.manifestId,
    TAB_BASE: o.tabUrl,
    TAB_HOST: new URL(o.tabUrl).host,
    NAME: o.name,
    DEVELOPER: o.developer,
    WEBSITE: o.website,
  };
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (all, k: string) => (k in values ? JSON.stringify(values[k]).slice(1, -1) : all));
  const left = out.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`The manifest still has ${left[0]}.`);
  JSON.parse(out); // still valid JSON
  return out;
}

// ---------- PNG and zip ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An RGBA PNG; `pixel` gives [r, g, b, a] for each point. */
export function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // no filter
    for (let x = 0; x < size; x++) rows.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Whether a point is on a "C" for CEO: a thick ring with its right side open. */
function onMark(x: number, y: number, size: number): boolean {
  const c = (size - 1) / 2;
  const d = Math.hypot(x - c, y - c);
  return d >= size * 0.2 && d <= size * 0.32 && !(x > c && Math.abs(y - c) < size * 0.14);
}

/** Teams' two icons: 192 px in colour, and a 32 px white outline on transparent. */
export function icons(): { color: Buffer; outline: Buffer } {
  return {
    color: png(192, (x, y) => (onMark(x, y, 192) ? [255, 255, 255, 255] : [0x2f, 0x4a, 0x3a, 255])),
    outline: png(32, (x, y) => (onMark(x, y, 32) ? [255, 255, 255, 255] : [0, 0, 0, 0])),
  };
}

/** A zip of these files (deflated, no folders), as Teams' app upload takes. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** The package: manifest.json and the two icons at the zip's root. */
export function buildPackage(template: string, o: AppOptions): Buffer {
  const { color, outline } = icons();
  return zip([
    { name: 'manifest.json', data: Buffer.from(fillManifest(template, o), 'utf8') },
    { name: 'color.png', data: color },
    { name: 'outline.png', data: outline },
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(o.error);
    process.exit(1);
  }
  const data = buildPackage(readFileSync(path.join(ROOT, 'teams-app', 'manifest.json'), 'utf8'), o);
  mkdirSync(path.dirname(o.out), { recursive: true });
  writeFileSync(o.out, data);
  console.log(`Built ${o.out} (bot and app ${o.appId}, Teams app id ${o.manifestId}, tab at ${o.tabUrl}).`);
  console.log(`Host teams-app/tab/config.html and content.html at ${o.tabUrl}, then upload the zip in Teams (docs/teams.md).`);
}
