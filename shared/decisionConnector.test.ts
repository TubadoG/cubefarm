import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_TOOLS,
  DEFAULT_DECISION_CONNECTOR,
  decisionConnectorProblem,
  decisionConnectorSettings,
  inQuietHours,
  msUntilQuietEnds,
  POLL_IDLE_MS,
  POLL_OPEN_MS,
  POLL_SESSION_MS,
  pollDelay,
  RECEIPT_SUBJECT,
  sasTokenOf,
  tableEndpointOf,
} from './decisionConnector.ts';

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;
const H = 60 * MIN;

describe('decision connector settings', () => {
  it('is off by default, with 30 receipts a day', () => {
    expect(DEFAULT_DECISION_CONNECTOR).toEqual({ enabled: false, tableEndpoint: '', receiptsPerDay: 30 });
    expect(decisionConnectorSettings(undefined, {})).toEqual(DEFAULT_DECISION_CONNECTOR);
  });

  it('takes only an Azure table endpoint, without a path or a query (where a SAS could hide)', () => {
    expect(tableEndpointOf(' https://stbcdecisionconn01.table.core.windows.net/ ')).toBe('https://stbcdecisionconn01.table.core.windows.net');
    expect(tableEndpointOf('')).toBe('');
    for (const bad of ['http://stbc.table.core.windows.net', 'https://evil.example.com', 'https://stbc.table.core.windows.net/snapshot', 'https://stbc.table.core.windows.net/?sv=1', 'https://stbc.blob.core.windows.net']) {
      expect(tableEndpointOf(bad)).toBeNull();
    }
    expect(decisionConnectorProblem({ tableEndpoint: 'https://evil.example.com' })).toMatch(/table\.core\.windows\.net/);
    expect(decisionConnectorProblem({ receiptsPerDay: 0 })).toMatch(/1 to 100/);
    expect(decisionConnectorProblem({ enabled: 'yes' })).toMatch(/on or off/);
    expect(decisionConnectorSettings({ ...DEFAULT_DECISION_CONNECTOR, receiptsPerDay: 12 }, { receiptsPerDay: 500, tableEndpoint: 'nope' })).toEqual({ ...DEFAULT_DECISION_CONNECTOR, receiptsPerDay: 12 });
  });

  it('takes a SAS token with or without its "?", and nothing that is not one', () => {
    const sas = 'sv=2019-02-02&tn=answers&sp=raud&se=2027-11-20&sig=abcdefghijklmnop%3D';
    expect(sasTokenOf(`?${sas}`)).toBe(sas);
    expect(sasTokenOf('just-a-password-123456')).toBeNull();
    expect(sasTokenOf(`${sas} extra`)).toBeNull();
  });

  it('has exactly three tools: nothing closes, sends back, holds or merges a list', () => {
    expect([...CONNECTOR_TOOLS]).toEqual(['approve_recommendation', 'choose_option', 'retry_qa']);
  });

  it('knows a receipt, and a reply to one, by its subject', () => {
    expect(RECEIPT_SUBJECT.test('Decision recorded: acme/app #12, merged')).toBe(true);
    expect(RECEIPT_SUBJECT.test('RE: Re:Decision recorded: acme/app #12, merged')).toBe(true);
    expect(RECEIPT_SUBJECT.test('Re: the decision recorded yesterday')).toBe(false);
  });
});

describe('quiet hours, midnight to 5 am Eastern', () => {
  it('follows Eastern time in winter (EST, UTC-5) and summer (EDT, UTC-4)', () => {
    expect(inQuietHours(at('2026-01-15T04:59:00Z'))).toBe(false); // 23:59 EST on the 14th
    expect(inQuietHours(at('2026-01-15T05:00:00Z'))).toBe(true); // 00:00 EST
    expect(inQuietHours(at('2026-01-15T09:59:59Z'))).toBe(true); // 04:59:59 EST
    expect(inQuietHours(at('2026-01-15T10:00:00Z'))).toBe(false); // 05:00 EST
    expect(inQuietHours(at('2026-07-15T03:59:00Z'))).toBe(false); // 23:59 EDT
    expect(inQuietHours(at('2026-07-15T04:00:00Z'))).toBe(true); // 00:00 EDT
    expect(inQuietHours(at('2026-07-15T09:00:00Z'))).toBe(false); // 05:00 EDT
  });

  it('ends at 05:00 local on the nights the clocks change', () => {
    // 8 March 2026: 02:00 EST jumps to 03:00 EDT. From 01:30 EST, 5 am EDT is 2.5 hours away, not 3.5.
    expect(msUntilQuietEnds(at('2026-03-08T06:30:00Z'))).toBe(2.5 * H);
    expect(inQuietHours(at('2026-03-08T08:30:00Z'))).toBe(true); // 04:30 EDT
    expect(inQuietHours(at('2026-03-08T09:00:00Z'))).toBe(false); // 05:00 EDT
    // 1 November 2026: 02:00 EDT falls back to 01:00 EST. From 01:30 EDT, 5 am EST is 4.5 hours away.
    expect(msUntilQuietEnds(at('2026-11-01T05:30:00Z'))).toBe(4.5 * H);
    expect(inQuietHours(at('2026-11-01T09:30:00Z'))).toBe(true); // 04:30 EST
    expect(inQuietHours(at('2026-11-01T10:00:00Z'))).toBe(false); // 05:00 EST
    expect(msUntilQuietEnds(at('2026-11-01T15:00:00Z'))).toBe(0);
  });
});

describe('the poll schedule', () => {
  const day = at('2026-11-20T17:00:00Z'); // noon Eastern
  const base = { enabled: true, configured: true, now: day, open: 0, sessionAt: null };

  it('polls nothing when off or not set up', () => {
    expect(pollDelay({ ...base, enabled: false })).toBeNull();
    expect(pollDelay({ ...base, configured: false })).toBeNull();
  });

  it('is slow with no decisions open, faster with some, fastest in a voice session, then back to 30 s', () => {
    expect(pollDelay(base)).toBe(POLL_IDLE_MS);
    expect(POLL_IDLE_MS).toBe(5 * MIN);
    expect(pollDelay({ ...base, open: 2 })).toBe(POLL_OPEN_MS);
    expect(POLL_OPEN_MS).toBe(30_000);
    expect(pollDelay({ ...base, open: 2, sessionAt: day - 9 * MIN })).toBe(POLL_SESSION_MS);
    expect(POLL_SESSION_MS).toBe(3_000);
    expect(pollDelay({ ...base, open: 2, sessionAt: day - 11 * MIN })).toBe(POLL_OPEN_MS);
  });

  it('sleeps through quiet hours, whatever is going on, across DST', () => {
    const night = { ...base, open: 3, sessionAt: at('2026-11-20T06:59:00Z') };
    expect(pollDelay({ ...night, now: at('2026-11-20T07:00:00Z') })).toBe(3 * H); // 02:00 EST → 05:00
    expect(pollDelay({ ...night, now: at('2026-03-08T06:30:00Z'), sessionAt: at('2026-03-08T06:29:00Z') })).toBe(2.5 * H);
    expect(pollDelay({ ...night, now: at('2026-11-01T05:30:00Z'), sessionAt: at('2026-11-01T05:29:00Z') })).toBe(4.5 * H);
  });
});
