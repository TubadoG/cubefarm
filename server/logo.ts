// The company's logo (Settings → Company): one image the lobby sign draws beside the company name. Kept as
// <SWARM_HOME>/logo.<png|jpg|webp> (the demo's as demo-logo.*); `settings.logoAt` says whether there is one and is
// the cache key the browser asks with. Only PNG, JPEG and WebP: their first bytes are checked, not the request's word.
import fs from 'node:fs/promises';
import path from 'node:path';

export const LOGO_MAX_BYTES = 1024 * 1024;

export const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
export type LogoType = keyof typeof LOGO_TYPES;

/** The image type of these bytes, from their signature, or null when they aren't a PNG, JPEG or WebP. */
export function logoType(b: Buffer): LogoType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Why these bytes can't be the logo, worded for the settings page; null when they can. */
export function logoProblem(b: unknown): string | null {
  if (!Buffer.isBuffer(b) || b.length === 0) return 'Send the image itself as the request body.';
  if (b.length > LOGO_MAX_BYTES) return 'The logo must be 1 MB or smaller.';
  if (!logoType(b)) return 'The logo must be a PNG, JPEG or WebP image.';
  return null;
}

const files = (dir: string, base: string) => Object.entries(LOGO_TYPES).map(([type, ext]) => ({ type: type as LogoType, file: path.join(dir, `${base}.${ext}`) }));

/** The saved logo's file and type, or null when there is none. */
export async function findLogo(dir: string, base: string): Promise<{ file: string; type: LogoType } | null> {
  for (const f of files(dir, base)) if (await fs.stat(f.file).then((s) => s.isFile(), () => false)) return f;
  return null;
}

/** Saves the logo (already checked), replacing any other. */
export async function saveLogo(dir: string, base: string, b: Buffer): Promise<void> {
  await removeLogo(dir, base);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${base}.${LOGO_TYPES[logoType(b)!]}`);
  await fs.writeFile(`${file}.tmp`, b);
  await fs.rename(`${file}.tmp`, file);
}

export async function removeLogo(dir: string, base: string): Promise<void> {
  for (const f of files(dir, base)) await fs.rm(f.file, { force: true, maxRetries: 3 });
}
