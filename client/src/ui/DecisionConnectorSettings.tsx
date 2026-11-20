// Settings → Decision connector (docs/decision-connector.md): Bryan's voice Claude answers Decision room cards through a
// small MCP server on Azure; the office pushes the open cards to an Azure table and pulls the answers. The switch (off by
// default), the table endpoint, the SAS token (saved over REST, never shown again), receipts per day, and the status.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { MAX_RECEIPTS_PER_DAY, MIN_RECEIPTS_PER_DAY, QUIET_LABEL } from '../../../shared/decisionConnector';
import type { DecisionConnectorSettings as Settings } from '../../../shared/types';

const DOCS = 'https://github.com/TubadoG/cubefarm/blob/main/docs/decision-connector.md';

const when = (at: number | null) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'never');

export function DecisionConnectorSettings() {
  const c = useStore((s) => s.settings.decisionConnector);
  const view = useStore((s) => s.decisionConnector);
  const [endpoint, setEndpoint] = useState(c.tableEndpoint);
  const [receipts, setReceipts] = useState(String(c.receiptsPerDay));
  const [sas, setSas] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setEndpoint(c.tableEndpoint), [c.tableEndpoint]);
  useEffect(() => setReceipts(String(c.receiptsPerDay)), [c.receiptsPerDay]);

  const save = async (patch: Partial<Settings>) => {
    setError('');
    try {
      await api.updateSettings({ decisionConnector: { ...c, ...patch } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card notify-settings">
      <h3>🎙️ Decision connector</h3>
      <p className="muted small">
        Answer Decision room cards by voice from Claude: approve the recommendation, choose an option, or retry QA. The office sends the open cards to an Azure table
        and picks up your answers from it, outbound only; it re-checks every answer and applies it as the Room would, then emails you a receipt. Paused {QUIET_LABEL}.
        See <a href={DOCS}>docs/decision-connector.md</a>.
      </p>
      <label className="row">
        <input type="checkbox" checked={c.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>On</span>
      </label>
      <div className="notify-hook">
        <label className="field">
          <span>Table endpoint</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            onBlur={() => endpoint.trim() !== c.tableEndpoint && void save({ tableEndpoint: endpoint.trim() })}
            placeholder="https://<account>.table.core.windows.net"
            autoComplete="off"
          />
        </label>
        <div className="row wrap">
          <b className="grow">SAS token</b>
          <span className="small">{view.sasSet ? '🔑 Set' : 'Not set'}</span>
        </div>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (sas.trim()) void run(() => api.setDecisionConnectorSas(sas.trim()), () => setSas(''));
          }}
        >
          <input
            type="password"
            className="grow"
            value={sas}
            onChange={(e) => setSas(e.target.value)}
            placeholder={view.sasSet ? 'Paste a new token to replace it' : 'Paste the table SAS token'}
            aria-label="Decision connector SAS token"
            autoComplete="off"
          />
          <button className="btn btn-small btn-good" disabled={!sas.trim() || busy}>
            Save
          </button>
          {view.sasSet && (
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => api.setDecisionConnectorSas(''))}>
              Remove
            </button>
          )}
        </form>
        <label className="field">
          <span>Receipt emails per day (apart from the CEO's daily cap)</span>
          <input
            type="number"
            min={MIN_RECEIPTS_PER_DAY}
            max={MAX_RECEIPTS_PER_DAY}
            value={receipts}
            onChange={(e) => setReceipts(e.target.value)}
            onBlur={() => Number(receipts) !== c.receiptsPerDay && void save({ receiptsPerDay: Number(receipts) })}
          />
        </label>
      </div>

      <h4 className="notify-h">Status</h4>
      <ul className="email-list small">
        <li>
          {!c.enabled ? 'Off: the office neither sends cards nor checks for answers.' : view.quiet ? `Paused for quiet hours (${QUIET_LABEL}).` : `On${view.nextPollAt ? `, next check ${when(view.nextPollAt)}` : ''}.`}
        </li>
        <li>
          Last push: {when(view.lastPush)} · last heartbeat: {when(view.lastHeartbeat)} · last poll: {when(view.lastPoll)}
        </li>
        <li>
          Last 24 hours: {view.pickedToday} picked up, {view.appliedToday} applied, {view.refusedToday} refused, {view.receiptsToday} of {c.receiptsPerDay} receipts
        </li>
        {view.lastError && <li className="term-error">Last error: {view.lastError}</li>}
      </ul>
      <div className="row wrap">
        <button className="btn btn-small" disabled={busy || !c.enabled} onClick={() => void run(api.checkDecisionConnector)}>
          Check now
        </button>
      </div>
      {view.results.length > 0 && (
        <>
          <h4 className="notify-h">Latest answers</h4>
          <ul className="email-list">
            {view.results.map((r) => (
              <li key={r.answerId} className="small">
                <span className={r.status === 'applied' ? 'notify-ok' : 'term-error'}>{r.status === 'applied' ? '✓ Applied' : '✗ Refused'}</span> <b>{r.key}</b> · {r.choice} ·{' '}
                {r.detail} <span className="muted">· {when(r.at)} · receipt {r.receipt}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <div className="term-error small" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
