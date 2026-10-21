// The stuck-screen watchdog: a coding-agent CLI at work keeps redrawing its terminal (a spinner with a running timer),
// so an agent "working" whose screen hasn't changed for settings.stuckMinutes is stuck, e.g. at a dialog nobody
// answers. The first time on a task the office restarts it; the second time the task waits for the manager. Claude
// Code's project-MCP dialog is answered at once (Esc: reject them all). The pure rules; swarm.ts samples the screens.

import crypto from 'node:crypto';

export const DEFAULT_STUCK_MIN = 15;
export const MAX_STUCK_MIN = 24 * 60;
/** How often the office looks at busy agents' screens. */
export const SCREEN_TICK_MS = 5000;

/** settings.stuckMinutes from anything: whole minutes, 0 = off. */
export function clampStuckMinutes(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_STUCK_MIN, n)) : DEFAULT_STUCK_MIN;
}

export type StuckAction = 'none' | 'restart' | 'giveUp';

/** What to do about an agent whose screen last changed at lastChange. strikes: restarts already spent on this task. */
export function stuckDecision(o: { status: string; lastChange: number; now: number; strikes: number; stuckMinutes: number }): StuckAction {
  if (o.stuckMinutes <= 0 || (o.status !== 'working' && o.status !== 'preparing')) return 'none';
  if (o.now - o.lastChange < o.stuckMinutes * 60_000) return 'none';
  return o.strikes >= 1 ? 'giveUp' : 'restart';
}

/** A short fingerprint of the visible screen. */
export const screenHash = (screen: string) => crypto.createHash('sha1').update(screen).digest('base64');

/**
 * Claude Code's dialog for a repo's .mcp.json servers ("3 new MCP servers found in this project" or "New MCP server
 * found in this project: x"), which blocks the session until answered. Its options are matched too, so a file
 * that merely mentions the title isn't taken for it.
 */
export function isMcpDialog(screen: string): boolean {
  if (!/\bnew (?:project )?MCP servers? found in this project\b/i.test(screen)) return false;
  return /Select any you wish to enable|Continue without using this MCP server/i.test(screen);
}

/** The screen's last non-empty line, trimmed, for the manager's message. */
export function lastScreenLine(screen: string, max = 120): string {
  const line = screen.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The manager's message about a stuck agent. */
export function stuckMessage(name: string, minutes: number, task: string, action: 'restart' | 'giveUp', line: string): string {
  const head =
    action === 'restart'
      ? `${name} was stuck for ${minutes} min on ${task}; restarted it.`
      : `${name} was stuck again for ${minutes} min on ${task}; stopped it and left the task for you to assign by hand.`;
  return line ? `${head} Last line: "${line}"` : head;
}
