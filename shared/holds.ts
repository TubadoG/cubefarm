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

// ---------- routine work ----------
// A floor with "routine only" on (the default) also holds work that isn't routine, so only small, everyday changes
// merge themselves. Anything that touches the database, sign-in and permissions, secrets, deploys and CI, or
// dependencies, and anything big, waits for the manager. Matched case-insensitively, by the same patterns as above.

/** Changed lines (added plus deleted) above which a PR isn't routine. */
export const ROUTINE_MAX_LINES = 400;
/** How a routine hold's reason starts, so alerts can tell it from the manager's own hold paths. */
export const NOT_ROUTINE = 'not routine: ';

/** What isn't routine, each with the words an alert uses for it. */
export const ROUTINE_RULES: { what: string; patterns: string[] }[] = [
  { what: 'changes database migrations or schema', patterns: ['migrations', 'migration', 'alembic', '*.sql', 'schema.*', '*.prisma'] },
  { what: 'changes sign-in or permissions', patterns: ['auth', '*auth.*', '*permission*', '*rbac*'] },
  { what: 'touches secrets or keys', patterns: ['.env', '.env.*', '*secret*', '*credential*', '*.pem', '*.key'] },
  {
    what: 'changes deploys, CI or infrastructure',
    patterns: ['.github/workflows/', '.gitlab-ci.yml', 'dockerfile', 'dockerfile.*', '*.dockerfile', 'docker-compose*', 'compose.y*ml', '*.tf', 'terraform', 'infra', 'deploy', 'deploy.*', 'k8s', 'helm', '*.service'],
  },
  {
    what: 'changes dependencies',
    patterns: [
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'requirements*.txt',
      'pyproject.toml',
      'poetry.lock',
      'uv.lock',
      'pipfile',
      'pipfile.lock',
      'go.mod',
      'go.sum',
      'cargo.toml',
      'cargo.lock',
      'gemfile',
      'gemfile.lock',
      '*.csproj',
    ],
  },
];

const ROUTINE_RES = ROUTINE_RULES.map((r) => ({ what: r.what, res: r.patterns.map(holdPattern) }));

/**
 * Why a PR isn't routine work (starting with NOT_ROUTINE), or null when it is: the first rule a changed file breaks,
 * else its size. changedLines: additions plus deletions.
 */
export function notRoutine(files: readonly string[], changedLines: number): string | null {
  for (const rule of ROUTINE_RES) {
    const file = files.find((f) => rule.res.some((re) => re.test(f.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())));
    if (file) return `${NOT_ROUTINE}it ${rule.what} (${file})`;
  }
  if (changedLines > ROUTINE_MAX_LINES) return `${NOT_ROUTINE}it is a big change (${changedLines} lines; routine is up to ${ROUTINE_MAX_LINES})`;
  return null;
}
