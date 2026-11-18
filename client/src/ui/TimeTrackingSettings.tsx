// Settings → Time tracking (docs/kimai.md): each finished task as one Kimai timesheet. The mode (off, dry-run, live),
// the instance and time zone, the mappings from floor, kind of work and agent to Kimai's ids, and the latest entries
// with their status. The API token is saved over REST and never comes back: the page only knows whether it's set.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { KIMAI_WORK, kimaiId, WORK_ACTIVITY_HINT, WORK_LABEL } from '../../../shared/kimai';
import type { KimaiEntryView, KimaiSettings, KimaiWork } from '../../../shared/types';

const DOCS = 'https://github.com/TubadoG/cubefarm/blob/main/docs/kimai.md';
const STATUS: Record<KimaiEntryView['status'], string> = { waiting: '⏳ Waiting', sent: '✓ Sent', failed: '⚠ Parked', 'dry-run': '👁 Dry-run', 'not-logged': '— Not logged' };

/** A Kimai id field: saved when it loses focus; empty clears it. */
function IdInput({ value, label, onSave }: { value: number | null | undefined; label: string; onSave: (id: number | null) => void }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(value) : ''), [value]);
  return (
    <input
      className="kimai-id"
      inputMode="numeric"
      value={text}
      aria-label={label}
      placeholder="id"
      onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
      onBlur={() => (kimaiId(text) ?? null) !== (value ?? null) && onSave(kimaiId(text))}
    />
  );
}

const hm = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

export function TimeTrackingSettings() {
  const k = useStore((s) => s.settings.kimai);
  const view = useStore((s) => s.kimai);
  const repos = useStore((s) => s.repos);
  const agentsById = useStore((s) => s.agents);
  const agents = Object.values(agentsById);
  const [url, setUrl] = useState(k.url);
  const [tz, setTz] = useState(k.timezone);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ busy: boolean; text: string; ok: boolean }>({ busy: false, text: '', ok: false });
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setUrl(k.url), [k.url]);
  useEffect(() => setTz(k.timezone), [k.timezone]);

  const save = async (patch: Partial<KimaiSettings>) => {
    setError('');
    try {
      await api.updateSettings({ kimai: { ...k, ...patch } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const setIn = (key: 'projects' | 'users', id: string, v: number | null) => {
    const next: Record<string, number> = { ...k[key] };
    if (v) next[id] = v;
    else delete next[id];
    void save({ [key]: next });
  };
  const run = async (what: 'test' | 'retry' | 'token', fn: () => Promise<unknown>) => {
    setError('');
    if (what === 'test') setTest({ busy: true, text: '', ok: false });
    try {
      const r = await fn();
      if (what === 'test') {
        const t = r as { version: string; user: string };
        setTest({ busy: false, text: `✓ Kimai ${t.version}, signed in as ${t.user}`, ok: true });
      }
      if (what === 'token') setToken('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (what === 'test') setTest({ busy: false, text: msg, ok: false });
      else setError(msg);
    }
  };

  return (
    <div className="card notify-settings">
      <h3>⏱️ Time tracking</h3>
      <p className="muted small">
        Each finished task becomes one Kimai timesheet with the agent's working time, tagged <code>ai-agent</code>. Start in dry-run: it shows what would be sent
        and sends nothing. See <a href={DOCS}>docs/kimai.md</a>.
      </p>
      <label className="field">
        <span>Mode</span>
        <select value={k.mode} onChange={(e) => void save({ mode: e.target.value as KimaiSettings['mode'] })}>
          <option value="off">Off</option>
          <option value="dry-run">Dry-run (send nothing)</option>
          <option value="live">Live (post to Kimai)</option>
        </select>
      </label>
      <div className="notify-hook">
        <label className="field">
          <span>Kimai URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() !== k.url && void save({ url: url.trim() })} placeholder="https://time.example.com" autoComplete="off" />
        </label>
        <label className="field">
          <span>Time zone of the Kimai user (empty: the office server's)</span>
          <input value={tz} onChange={(e) => setTz(e.target.value)} onBlur={() => tz.trim() !== k.timezone && void save({ timezone: tz.trim() })} placeholder="America/Chicago" autoComplete="off" />
        </label>
        <div className="row wrap">
          <b className="grow">API token</b>
          <span className="small">{view.tokenSet ? '🔑 Set' : 'Not set'}</span>
        </div>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void run('token', () => api.setKimaiToken(token.trim()));
          }}
        >
          <input type="password" className="grow" value={token} onChange={(e) => setToken(e.target.value)} placeholder={view.tokenSet ? 'Paste a new token to replace it' : 'Paste the API token'} aria-label="Kimai API token" autoComplete="off" />
          <button className="btn btn-small btn-good" disabled={!token.trim()}>
            Save
          </button>
          {view.tokenSet && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => void run('token', () => api.setKimaiToken(''))}>
              Remove
            </button>
          )}
        </form>
        <div className="row wrap">
          <button className="btn btn-small" disabled={test.busy || !k.url || !view.tokenSet} onClick={() => void run('test', api.testKimai)}>
            {test.busy ? 'Testing…' : 'Test connection'}
          </button>
          {test.text && (
            <span className={`small ${test.ok ? 'notify-ok' : 'term-error'}`} role="status">
              {test.text}
            </span>
          )}
        </div>
      </div>

      <h4 className="notify-h">Floors → projects</h4>
      {repos.length === 0 && <p className="muted small">No floors yet.</p>}
      <ul className="email-list">
        {repos.map((r) => (
          <li key={r.id} className="row wrap">
            <span className="grow">
              <b>Floor {r.floor}</b> <span className="muted small">{r.fullName}</span>
            </span>
            <label className="toggle small" title="Its tasks log nothing">
              <input type="checkbox" checked={k.skip[r.id] === true} onChange={(e) => void save({ skip: { ...k.skip, [r.id]: e.target.checked } })} /> Don't log
            </label>
            {k.skip[r.id] !== true && (
              <>
                <IdInput value={k.projects[r.id]} label={`Kimai project for ${r.fullName}`} onSave={(v) => setIn('projects', r.id, v)} />
                <label className="toggle small">
                  <input type="checkbox" checked={k.billable[r.id] !== false} onChange={(e) => void save({ billable: { ...k.billable, [r.id]: e.target.checked } })} /> Billable
                </label>
              </>
            )}
          </li>
        ))}
        <li className="row wrap">
          <span className="grow">
            <b>CEO's office-wide jobs</b> <span className="muted small">(planning only)</span>
          </span>
          <IdInput value={k.planningProject} label="Kimai project for the CEO's office-wide jobs" onSave={(v) => void save({ planningProject: v })} />
        </li>
      </ul>

      <h4 className="notify-h">Work → activities</h4>
      <ul className="email-list">
        {KIMAI_WORK.map((w: KimaiWork) => (
          <li key={w} className="row wrap">
            <span className="grow">
              <b>{WORK_LABEL[w]}</b> <span className="muted small">usually “{WORK_ACTIVITY_HINT[w]}”</span>
            </span>
            <IdInput value={k.activities[w]} label={`Kimai activity for ${WORK_LABEL[w]}`} onSave={(v) => void save({ activities: { ...k.activities, [w]: v } })} />
          </li>
        ))}
      </ul>
      <label className="toggle block">
        <input type="checkbox" checked={k.planning} onChange={(e) => void save({ planning: e.target.checked })} />
        <span>Log the CEO's and floor leads' jobs as Planning</span>
      </label>
      <label className="field">
        <span>Shortest task logged (minutes)</span>
        <input type="number" min={0} max={60} value={k.minMinutes} onChange={(e) => void save({ minMinutes: Number(e.target.value) })} />
      </label>

      <h4 className="notify-h">Agents → Kimai users</h4>
      <p className="muted small">Optional. An agent without a user logs to the token's own user. Logging for other users needs that permission in Kimai.</p>
      <ul className="email-list">
        {agents.map((a) => (
          <li key={a.id} className="row wrap">
            <span className="grow">
              <b>{a.name}</b> <span className="muted small">{a.role === 'agent' ? (repos.find((r) => r.id === a.repoId)?.fullName ?? '') : a.role}</span>
            </span>
            <IdInput value={k.users[a.id]} label={`Kimai user for ${a.name}`} onSave={(v) => setIn('users', a.id, v)} />
          </li>
        ))}
      </ul>

      <h4 className="notify-h">
        Latest entries{view.waiting ? ` · ${view.waiting} waiting` : ''}
        {view.failed ? ` · ${view.failed} parked` : ''}
      </h4>
      <div className="row wrap">
        <button className="btn btn-small" disabled={!view.failed || k.mode === 'off'} onClick={() => void run('retry', api.retryKimai)}>
          Retry failed
        </button>
      </div>
      {view.entries.length === 0 && <p className="muted small">{k.mode === 'off' ? 'Time tracking is off.' : 'No finished tasks yet.'}</p>}
      <ul className="email-list">
        {view.entries.map((e) => (
          <li key={e.key}>
            <button className="kimai-entry" aria-expanded={open === e.key} onClick={() => setOpen(open === e.key ? null : e.key)}>
              <span className={`small ${e.status === 'failed' ? 'term-error' : e.status === 'sent' ? 'notify-ok' : ''}`}>{STATUS[e.status]}</span>{' '}
              <b>{e.agentName}</b> · {WORK_LABEL[e.work]} {e.repo && <span className="muted">· {e.repo}</span>} ·{' '}
              {new Date(e.begin).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {hm(e.end - e.begin)}
              {e.kimaiId ? ` · #${e.kimaiId}` : ''}
            </button>
            {e.error && <div className="small term-error">{e.error}</div>}
            {open === e.key && e.payload && <pre className="kimai-payload small">{JSON.stringify(e.payload, null, 2)}</pre>}
          </li>
        ))}
      </ul>
      {error && (
        <div className="term-error small" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
