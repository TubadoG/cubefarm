import { describe, expect, it } from 'vitest';
import { ERROR_CLEAR_MS, errorDesksToClear, FAILING_RETRY_MS, failingRetryDue, HELD_RELEASE_MS, heldReleaseDue } from './waits.ts';
import { ALARM_ERROR_MS } from './metrics.ts';

// The office's own fallbacks for the non-business waits (docs/floor-lead.md), when the floor lead hasn't resolved them.

describe('wait 1: an issue whose PR a person closed', () => {
  it('goes back in line after a day', () => {
    expect(heldReleaseDue({ since: 0, parked: false }, HELD_RELEASE_MS - 1)).toBe(false);
    expect(heldReleaseDue({ since: 0, parked: false }, HELD_RELEASE_MS)).toBe(true);
  });
  it('stays held when a decision brief parked it: that is the manager’s call', () => {
    expect(heldReleaseDue({ since: 0, parked: true }, 10 * HELD_RELEASE_MS)).toBe(false);
  });
});

describe('waits 2 and 3: an issue skipped after failed sessions or a terminal frozen twice', () => {
  it('is tried again after a few hours', () => {
    expect(failingRetryDue({ count: 2, at: 0 }, 2, FAILING_RETRY_MS - 1)).toBe(false);
    expect(failingRetryDue({ count: 2, at: 0 }, 2, FAILING_RETRY_MS)).toBe(true);
  });
  it('leaves one that is not skipped alone', () => {
    expect(failingRetryDue({ count: 1, at: 0 }, 2, 10 * FAILING_RETRY_MS)).toBe(false);
  });
});

describe('wait 4: an agent left in an error', () => {
  const now = 100 * 60_000;
  const agents = [
    { id: 'a', role: 'agent', status: 'error', endedAt: now - ERROR_CLEAR_MS },
    { id: 'b', role: 'agent', status: 'error', endedAt: now - ERROR_CLEAR_MS + 1 },
    { id: 'c', role: 'agent', status: 'idle', endedAt: now - 10 * ERROR_CLEAR_MS },
    { id: 'd', role: 'ceo', status: 'error', endedAt: now - 10 * ERROR_CLEAR_MS },
    { id: 'e', role: 'agent', status: 'error', endedAt: null },
  ];
  it('gets its desk cleared by the office before the alarm would call the manager', () => {
    expect(ERROR_CLEAR_MS).toBeLessThan(ALARM_ERROR_MS);
    expect(errorDesksToClear(agents, now).map((a) => a.id)).toEqual(['a']);
  });
});
