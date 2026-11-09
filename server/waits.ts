// Waits that aren't business decisions (docs/floor-lead.md): places where a floor used to sit until the manager
// stepped in for a technical reason. The floor lead resolves them first; these rules are the office's own fallback,
// so nothing waits on the manager when the lead is off, busy, or leaves one alone. Only swarm:hold, hold paths and
// decision briefs stay with the manager. Pure: swarm.ts applies them on its scheduler pass.

/** An issue whose PR a person closed goes back in line after this, unless the lead decided sooner (wait 1). */
export const HELD_RELEASE_MS = 24 * 60 * 60_000;
/** An issue skipped after failed sessions (or a terminal frozen twice) is tried again after this (waits 2 and 3). */
export const FAILING_RETRY_MS = 6 * 60 * 60_000;
/** An agent left in an error with nothing to do gets its desk cleared after this, before the 10-minute alarm (wait 4). */
export const ERROR_CLEAR_MS = 9 * 60_000;

/** An issue held after its PR closed. parked: a decision brief parked it (the manager's call), so it stays held. */
export interface HeldFacts {
  since: number;
  parked: boolean;
}

/** Whether a held issue goes back in line on its own now (wait 1). */
export const heldReleaseDue = (h: HeldFacts, now: number) => !h.parked && now - h.since >= HELD_RELEASE_MS;

/** Whether an issue auto-assign skips after failed sessions is tried again now (waits 2 and 3). */
export const failingRetryDue = (f: { count: number; at: number }, max: number, now: number) => f.count >= max && now - f.at >= FAILING_RETRY_MS;

/** The workers whose desk the office clears itself: in an error, idle with it for ERROR_CLEAR_MS (wait 4). */
export function errorDesksToClear<T extends { role: string; status: string; endedAt: number | null }>(agents: readonly T[], now: number): T[] {
  return agents.filter((a) => a.role === 'agent' && a.status === 'error' && a.endedAt !== null && now - a.endedAt >= ERROR_CLEAR_MS);
}
