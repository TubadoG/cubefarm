import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLogo, LOGO_MAX_BYTES, logoProblem, logoType, removeLogo, saveLogo } from './logo.ts';

// The company logo (server/logo.ts): only real PNG, JPEG or WebP bytes up to 1 MB, one file at a time.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

describe('logoType', () => {
  it('knows PNG, JPEG and WebP by their first bytes, and nothing else', () => {
    expect(logoType(PNG)).toBe('image/png');
    expect(logoType(JPEG)).toBe('image/jpeg');
    expect(logoType(WEBP)).toBe('image/webp');
    expect(logoType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(logoType(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('logoProblem', () => {
  it('refuses an empty body, a big file and anything not an image', () => {
    expect(logoProblem(PNG)).toBeNull();
    expect(logoProblem(undefined)).toMatch(/request body/);
    expect(logoProblem({ logo: 'x' })).toMatch(/request body/);
    expect(logoProblem(Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]))).toMatch(/1 MB/);
    expect(logoProblem(Buffer.from('hello'))).toMatch(/PNG, JPEG or WebP/);
  });
});

describe('saving the logo', () => {
  it('keeps one file, under the type its bytes are, and removes it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cubefarm-logo-'));
    try {
      expect(await findLogo(dir, 'logo')).toBeNull();
      await saveLogo(dir, 'logo', PNG);
      expect(await findLogo(dir, 'logo')).toEqual({ type: 'image/png', file: path.join(dir, 'logo.png') });
      await saveLogo(dir, 'logo', JPEG);
      expect(await findLogo(dir, 'logo')).toEqual({ type: 'image/jpeg', file: path.join(dir, 'logo.jpg') });
      expect((await fs.readdir(dir)).sort()).toEqual(['logo.jpg']);
      await removeLogo(dir, 'logo');
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
