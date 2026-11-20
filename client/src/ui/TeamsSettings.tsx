// Settings → Teams (docs/teams.md): the CEO in one Microsoft Teams channel and, with Direct chat on, in your 1:1 chat
// with its app. The office reads both and the CEO posts as its own bot, with the email sender's app (Settings → Email): no
// other credentials. Your messages (by your Entra object id) reach the CEO as yours; colleague bots' as theirs, never with
// your authority. Decisions are never answered in Teams. Only who wrote each message, where, and what happened to it
// reach the browser, never the text.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { channelId, guid, MAX_MANAGERS, MAX_POLL_SECONDS, MAX_POSTS_PER_DAY, MAX_TEAMS_COLLEAGUES, MAX_TEAMS_NAME, MIN_POLL_SECONDS, serviceUrl } from '../../../shared/teams';
import { CEO_ID, type TeamsDirectView, type TeamsSettings as Teams } from '../../../shared/types';

const DOCS = 'https://github.com/leonvanzyl/cubefarm/blob/main/docs/teams.md';

const DIRECT_STATUS: Record<TeamsDirectView['status'], string> = {
  unknown: 'Not checked yet',
  found: '✓ Chat found',
  'not-added': 'Not added yet',
  error: 'Error',
};

/** A text field saved when it loses focus, if it changed. */
function Field(props: { label: string; value: string; placeholder: string; onSave: (v: string) => void; hint?: string }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <label className="field">
      <span>{props.label}</span>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== props.value && props.onSave(v.trim())} placeholder={props.placeholder} autoComplete="off" spellCheck={false} />
      {props.hint && <span className="muted small">{props.hint}</span>}
    </label>
  );
}

export function TeamsSettings() {
  const teams = useStore((s) => s.settings.teams);
  const view = useStore((s) => s.teams);
  const sender = useStore((s) => s.emailSender);
  const ceo = useStore((s) => s.agents[CEO_ID]?.name ?? 'The CEO');
  const [error, setError] = useState('');
  const [managerAdd, setManagerAdd] = useState('');
  const [colleagueAdd, setColleagueAdd] = useState({ name: '', appId: '' });
  const [check, setCheck] = useState<{ busy: boolean; result: string | null }>({ busy: false, result: null });
  const save = async (patch: Partial<Teams>) => {
    setError('');
    try {
      await api.updateSettings({ teams: { ...teams, ...patch } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const managerOk = !!guid(managerAdd) && !teams.managers.includes(guid(managerAdd)!) && teams.managers.length < MAX_MANAGERS;
  const colleagueOk =
    !!colleagueAdd.name.trim() &&
    (colleagueAdd.appId.trim() === '' || !!guid(colleagueAdd.appId)) &&
    !teams.colleagues.some((c) => c.name.toLowerCase() === colleagueAdd.name.trim().toLowerCase()) &&
    teams.colleagues.length < MAX_TEAMS_COLLEAGUES;
  const runCheck = async () => {
    setCheck({ busy: true, result: null });
    try {
      await api.checkTeams();
      setCheck({ busy: false, result: null });
    } catch (err) {
      setCheck({ busy: false, result: err instanceof Error ? err.message : String(err) });
    }
  };
  const ready = !!teams.teamId && !!teams.channelId;
  return (
    <div className="card notify-settings">
      <h3>💬 Teams</h3>
      <p className="muted small">
        {ceo} reads one Teams channel and answers in it as its own bot. Your messages there reach {ceo} as yours; colleague bots' reach it as theirs, only when they
        @mention it. Decisions are never answered in Teams, not even by you: they stay in the Decision room.
      </p>
      <label className="toggle block">
        <input type="checkbox" checked={teams.enabled} disabled={!ready && !teams.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>{ceo} reads and posts in the Teams channel</span>
      </label>
      <label className="toggle block">
        <input type="checkbox" checked={teams.direct} disabled={teams.managers.length === 0 && !teams.direct} onChange={(e) => void save({ direct: e.target.checked })} />
        <span>Direct chat: {ceo} reads and answers your 1:1 chat with it</span>
      </label>
      {teams.direct && (
        <div className="notify-hook">
          <p className="muted small">
            Only your own chats (the ids below) are read, and only your messages in them count. Add {ceo} in Teams: Apps → {ceo} → Add, then Open. It needs the
            Chat.Read.WhereInstalled permission (see <a href={DOCS}>docs/teams.md</a>).
          </p>
          <ul className="email-list">
            {view.direct.map((d) => (
              <li key={d.id} className="row wrap small">
                <span className="grow">{d.name ? <b>{d.name}</b> : <code>{d.id}</code>}</span>
                <span className={d.status === 'found' ? 'notify-ok' : d.status === 'error' ? 'term-error' : 'muted'} title={d.error}>
                  {d.status === 'not-added' ? `Not added yet: open Apps → ${ceo} → Add` : DIRECT_STATUS[d.status]}
                  {d.error && ` · ${d.error}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="notify-hook">
        <div className="row wrap">
          <b className="grow">Bot</b>
          <span className="small">{sender.set ? `The email sender's app (${sender.hint})` : 'Not set: save the email sender first'}</span>
        </div>
        <p className="muted small">
          It needs {ceo}'s Teams app installed in the team and an Azure Bot for that app: see <a href={DOCS}>docs/teams.md</a>.
        </p>
        <Field label="Team id (the team's group id)" value={teams.teamId} placeholder="44ffe347-85e3-4917-88c2-176352e79788" onSave={(teamId) => void save({ teamId })} />
        <Field
          label="Channel id"
          value={teams.channelId}
          placeholder="19:…@thread.tacv2"
          onSave={(v) => void save({ channelId: v === '' ? '' : (channelId(v) ?? v) })}
          hint="From the channel's “Get link to channel”: the part after /channel/."
        />
        <Field
          label="Bot Framework service URL"
          value={teams.serviceUrl}
          placeholder="https://smba.trafficmanager.net/amer/"
          onSave={(v) => void save({ serviceUrl: serviceUrl(v) ?? v })}
        />
        <label className="field">
          <span>Check the channel every (seconds)</span>
          <input
            type="number"
            min={MIN_POLL_SECONDS}
            max={MAX_POLL_SECONDS}
            step={10}
            defaultValue={teams.pollSeconds}
            key={teams.pollSeconds}
            onBlur={(e) => Number(e.target.value) !== teams.pollSeconds && void save({ pollSeconds: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>
            {ceo}'s posts a day (today: {view.postsToday} of {teams.postsPerDay})
          </span>
          <input
            type="number"
            min={1}
            max={MAX_POSTS_PER_DAY}
            defaultValue={teams.postsPerDay}
            key={teams.postsPerDay}
            onBlur={(e) => Number(e.target.value) !== teams.postsPerDay && void save({ postsPerDay: Number(e.target.value) })}
          />
        </label>
      </div>
      <h4 className="notify-h">Count messages from these people as mine</h4>
      <p className="muted small">Their Entra object ids (Entra admin center → Users → the user → Object ID). Nobody else's messages reach {ceo} as yours, whatever their name.</p>
      {teams.managers.length === 0 && <p className="muted small">Nobody: your messages are ignored.</p>}
      <ul className="email-list">
        {teams.managers.map((m) => (
          <li key={m} className="row wrap">
            <span className="grow small">
              <code>{m}</code>
            </span>
            <button className="btn btn-small btn-ghost" aria-label={`Remove ${m}`} onClick={() => void save({ managers: teams.managers.filter((x) => x !== m) })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!managerOk) return;
          void save({ managers: [...teams.managers, managerAdd.trim()] });
          setManagerAdd('');
        }}
      >
        <input value={managerAdd} onChange={(e) => setManagerAdd(e.target.value)} placeholder="Entra object id" aria-label="Your Entra object id" autoComplete="off" spellCheck={false} className="grow" />
        <button className="btn btn-small btn-good" disabled={!managerOk}>
          Add
        </button>
      </form>
      <h4 className="notify-h">Colleague bots</h4>
      <p className="muted small">
        Other agents' bots in the channel. {ceo} reads their messages as information and requests only, never as your decision or approval, and only when they @mention it.
        It answers a bot at most 3 times per thread, and never an acknowledgement. An app id is safer than a name.
      </p>
      {teams.colleagues.length === 0 && <p className="muted small">None.</p>}
      <ul className="email-list">
        {teams.colleagues.map((c) => (
          <li key={c.name} className="row wrap">
            <span className="grow small">
              <b>{c.name}</b> <span className="muted">{c.appId ? <code>{c.appId}</code> : 'matched by name'}</span>
            </span>
            <button className="btn btn-small btn-ghost" aria-label={`Remove ${c.name}`} onClick={() => void save({ colleagues: teams.colleagues.filter((x) => x.name !== c.name) })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!colleagueOk) return;
          void save({ colleagues: [...teams.colleagues, { name: colleagueAdd.name.trim(), appId: colleagueAdd.appId.trim() }] });
          setColleagueAdd({ name: '', appId: '' });
        }}
      >
        <input value={colleagueAdd.name} onChange={(e) => setColleagueAdd({ ...colleagueAdd, name: e.target.value })} placeholder="Name" aria-label="Bot's name" maxLength={MAX_TEAMS_NAME} className="grow" />
        <input
          value={colleagueAdd.appId}
          onChange={(e) => setColleagueAdd({ ...colleagueAdd, appId: e.target.value })}
          placeholder="App id (optional)"
          aria-label="Bot's app id"
          autoComplete="off"
          spellCheck={false}
          className="grow"
        />
        <button className="btn btn-small btn-good" disabled={!colleagueOk}>
          Add
        </button>
      </form>
      <div className="row wrap">
        <span className="small grow" role="status">
          {view.lastCheck ? `Last checked ${new Date(view.lastCheck).toLocaleTimeString()}` : 'Not checked yet'}
          {view.lastError && <span className="term-error"> · {view.lastError}</span>}
        </span>
        <button className="btn btn-small" disabled={check.busy || !(teams.enabled || teams.direct) || !sender.set} onClick={() => void runCheck()}>
          {check.busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {check.result && <div className="small term-error">{check.result}</div>}
      {view.items.length > 0 && (
        <ul className="email-list inbox-list">
          {view.items.map((i) => (
            <li key={`${i.source ?? 'channel'}:${i.id}`} className="small inbox-item">
              <div>
                <b>{i.from}</b> <span className="muted">· {i.source === 'direct' ? 'direct chat' : 'channel'}</span>
              </div>
              <div>
                <span className={i.outcome === 'ignored' ? 'muted' : 'notify-ok'}>
                  {i.outcome === 'delivered' ? `💬 To ${ceo} as yours${i.source === 'direct' ? ' (Teams DM)' : ''}` : i.outcome === 'colleague' ? `🤝 To ${ceo} as ${i.colleague ?? 'a colleague'}'s, not yours` : `Ignored: ${i.reason}`}
                </span>
                <span className="muted"> · {new Date(i.at).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="term-error small" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
