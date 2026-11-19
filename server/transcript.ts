// A terminal-runtime Claude session's tokens, from Claude Code's transcript on disk (docs/kimai.md): the session's JSONL
// and its subagents', each assistant message counted once (streaming writes one message on several lines), only the
// lines inside the session's own time window (a resumed conversation's earlier turns aren't this session's). Read as a
// stream, line by line: these files can be tens of MB. Any problem means no tokens, never a failed timesheet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { SessionTokens } from './timesheets.ts';

/** Where a session's transcript is: the file Claude's hooks reported, else found from its folder and session id. */
export interface TranscriptRef {
  file: string | null;
  cwd: string;
  sessionId: string | null;
}

const MAX_SLUG = 200; // Claude Code shortens longer folder names and adds a hash of the path
const MAX_SUBAGENTS = 200;

/** Claude Code's projects folder: under CLAUDE_CONFIG_DIR when set (the office passes it on to agents), else ~/.claude. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
}

/** A folder's name under projects/, the way Claude Code writes it: every character but A-Z, a-z and 0-9 becomes '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The transcript file, or null when there's none to read. */
export async function locateTranscript(ref: TranscriptRef, projects = claudeProjectsDir()): Promise<string | null> {
  if (ref.file && (await isFile(ref.file))) return ref.file;
  if (!ref.sessionId || !/^[\w-]+$/.test(ref.sessionId)) return null;
  const name = `${ref.sessionId}.jsonl`;
  const slug = projectSlug(ref.cwd);
  if (slug.length <= MAX_SLUG) {
    const file = path.join(projects, slug, name);
    return (await isFile(file)) ? file : null;
  }
  // A long path's folder ends in a hash we don't reproduce: the folder with its first 200 characters that has the file.
  const dirs = await fs.promises.readdir(projects).catch(() => [] as string[]);
  for (const d of dirs.filter((x) => x.startsWith(`${slug.slice(0, MAX_SLUG)}-`))) {
    const file = path.join(projects, d, name);
    if (await isFile(file)) return file;
  }
  return null;
}

async function isFile(file: string) {
  return fs.promises
    .stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
}

type Usage = { input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown };

/**
 * The tokens of the assistant messages in `file` and its subagents' transcripts (`<file without .jsonl>/subagents/`)
 * stamped within [from, to] (epoch ms). Undefined when there are none or the file can't be read.
 */
export async function transcriptTokens(file: string, from: number, to: number): Promise<SessionTokens | undefined> {
  const t: SessionTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const seen = new Set<string>();
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const add = (line: string) => {
    // Most lines are tool results and prompts: skip them before parsing.
    if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
    let e: { type?: unknown; timestamp?: unknown; message?: { id?: unknown; usage?: Usage } };
    try {
      e = JSON.parse(line);
    } catch {
      return; // a line still being written
    }
    const usage = e.message?.usage;
    if (e.type !== 'assistant' || !usage || typeof e.timestamp !== 'string') return;
    const at = Date.parse(e.timestamp);
    if (!(at >= from && at <= to)) return;
    const id = typeof e.message?.id === 'string' ? e.message.id : '';
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    t.input += n(usage.input_tokens);
    t.output += n(usage.output_tokens);
    t.cacheWrite += n(usage.cache_creation_input_tokens);
    t.cacheRead += n(usage.cache_read_input_tokens);
  };
  try {
    await eachLine(file, add);
  } catch {
    return undefined;
  }
  const subDir = path.join(file.replace(/\.jsonl$/i, ''), 'subagents');
  const subs = await fs.promises.readdir(subDir).catch(() => [] as string[]);
  for (const s of subs.filter((x) => x.endsWith('.jsonl')).slice(0, MAX_SUBAGENTS)) await eachLine(path.join(subDir, s), add).catch(() => undefined);
  return t.input + t.output + t.cacheWrite + t.cacheRead > 0 ? t : undefined;
}

async function eachLine(file: string, fn: (line: string) => void) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) fn(line);
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** A terminal session's tokens from its transcript, or undefined. Never throws. */
export async function sessionTranscriptTokens(ref: TranscriptRef, from: number, to: number, projects?: string): Promise<SessionTokens | undefined> {
  try {
    const file = await locateTranscript(ref, projects);
    return file ? await transcriptTokens(file, from, to) : undefined;
  } catch {
    return undefined;
  }
}
