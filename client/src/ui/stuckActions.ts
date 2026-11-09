// A stuck PR's buttons (Kanban, the manager's console, pocket Approvals): the office's pick (server/decision.ts
// stuckPrPick) comes first and is the highlighted one, with its one-line why; the others follow. Pure.
import type { QaView, StuckAction } from '../../../shared/types';

export const STUCK_ACTIONS: readonly StuckAction[] = ['send-back', 'retry-qa', 'merge', 'close'];

export const STUCK_LABEL: Record<StuckAction, string> = { 'retry-qa': 'Retry QA', 'send-back': 'Send back', merge: 'Merge anyway', close: 'Close' };

/** The buttons in order, the pick first and primary. No pick: none is highlighted. */
export function stuckButtons(pick: QaView['stuckPick']): { action: StuckAction; primary: boolean }[] {
  const a = pick?.action ?? null;
  return (a ? [a, ...STUCK_ACTIONS.filter((x) => x !== a)] : STUCK_ACTIONS).map((action) => ({ action, primary: action === a }));
}

/** The line under the buttons: what the office recommends and why. */
export function stuckPickLine(pick: QaView['stuckPick']): string | null {
  if (!pick) return null;
  return pick.action ? `Recommended: ${STUCK_LABEL[pick.action]}. ${pick.why}` : pick.why;
}
