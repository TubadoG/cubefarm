// Merge holds: PRs that wait for the manager even on a floor with auto-merge on. A floor's hold paths are glob-style
// patterns (`**` any depth, `*` and `?` within one path segment); a PR is held when a changed file matches one, or
// when it carries the swarm:hold label. Pure, for the server's merge loop, its validation and the tests.

import { HOLD_LABEL } from './issues.ts';

/** Most hold patterns a floor keeps, and the longest one. */
export const MAX_HOLD_PATHS = 50;
export const MAX_HOLD_PATH_LENGTH = 200;

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern as a regular expression over forward-slash paths. Like .gitignore: a pattern without a slash matches at
 * any depth (`*.sql`), a leading slash anchors it to the repo root, and a pattern also matches everything under a
 * folder it names (`migrations`, `server/payments/`).
 */
export function holdPattern(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/');
  const anchored = p.startsWith('/') || p.replace(/\/+$/, '').includes('/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        out += '(?:.*/)?'; // "**/": zero or more folders
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}(?:/.*)?$`);
}

/** True when the path (repo-relative) matches the pattern. */
export function matchesHold(pattern: string, file: string): boolean {
  return holdPattern(pattern).test(file.replace(/\\/g, '/').replace(/^\/+/, ''));
}

/**
 * Why a PR waits for the manager, or null when it may merge itself: the label, else the first changed file that
 * matches a pattern. files: null when they aren't known (only asked for when there are patterns).
 */
export function holdReason(labels: readonly string[] | undefined, files: readonly string[] | null, patterns: readonly string[]): string | null {
  if (labels?.some((l) => l.toLowerCase() === HOLD_LABEL)) return `label ${HOLD_LABEL}`;
  if (!files || !patterns.length) return null;
  const res = patterns.map(holdPattern);
  return files.find((f) => res.some((re) => re.test(f.replace(/\\/g, '/').replace(/^\/+/, '')))) ?? null;
}

/** A floor's hold paths from a request body: trimmed, repeats dropped. Throws a message on bad input. */
export function parseHoldPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) throw new Error('holdPaths must be an array of non-empty path patterns');
  const paths = [...new Set(value.map((v: string) => v.trim()))];
  if (paths.length > MAX_HOLD_PATHS) throw new Error(`At most ${MAX_HOLD_PATHS} hold paths per floor`);
  const long = paths.find((p) => p.length > MAX_HOLD_PATH_LENGTH);
  if (long) throw new Error(`Hold path too long (max ${MAX_HOLD_PATH_LENGTH} characters): ${long.slice(0, 40)}…`);
  return paths;
}
