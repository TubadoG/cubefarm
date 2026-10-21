// Settings → Email (docs/email.md): whether the CEO may email at all, the mailbox it sends from, who gets a blind
// copy, and the list of people it may write to (each sent at once, or after the manager's OK). The sender's
// credentials are set over REST and never reach the browser: only whether they're set. The daily digest (server/digest.ts)
// goes to one of them, once a day.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { EMAILS_PER_DAY, emailAddress, MAX_NAME, MAX_RECIPIENTS } from '../../../shared/email';
import type { EmailRecipient, EmailSettings as Email } from '../../../shared/types';
import { confirmDialog } from './Confirm';

const DOCS = 'https://github.com/leonvanzyl/cubefarm/blob/main/docs/email.md';

export function EmailSettings() {
  const email = useStore((s) => s.settings.email);
  const sender = useStore((s) => s.emailSender);
  const [from, setFrom] = useState(email.from);
  const [add, setAdd] = useState({ email: '', name: '', approve: true });
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ busy: boolean; result: string | null; ok: boolean }>({ busy: false, result: null, ok: false });
  const [digestRun, setDigestRun] = useState<{ busy: boolean; result: string | null; tone: string }>({ busy: false, result: null, tone: '' });
  useEffect(() => setFrom(email.from), [email.from]);
  const digest = email.digest;
  const direct = email.recipients.filter((r) => !r.approve);
  const save = async (patch: Partial<Email>) => {
    setError('');
    try {
      await api.updateSettings({ email: { ...email, ...patch } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const setRecipients = (recipients: EmailRecipient[]) => void save({ recipients });
  const addOk = !!emailAddress(add.email) && !email.recipients.some((r) => r.email === emailAddress(add.email)) && email.recipients.length < MAX_RECIPIENTS;
  const runTest = async () => {
    setTest({ busy: true, result: null, ok: false });
    try {
      const r = await api.testEmail();
      setTest({ busy: false, result: `✓ Sent to ${r.to}`, ok: true });
    } catch (err) {
      setTest({ busy: false, result: err instanceof Error ? err.message : String(err), ok: false });
    }
  };
  const runDigest = async () => {
    setDigestRun({ busy: true, result: null, tone: '' });
    try {
      const r = await api.sendDigest();
      setDigestRun({ busy: false, result: r.sent ? `✓ Sent “${r.subject}” to ${r.to}` : (r.reason ?? 'Not sent'), tone: r.sent ? 'notify-ok' : 'muted' });
    } catch (err) {
      setDigestRun({ busy: false, result: err instanceof Error ? err.message : String(err), tone: 'term-error' });
    }
  };
  return (
    <div className="card notify-settings">
      <h3>📧 Email</h3>
      <p className="muted small">
        The CEO can email people on this list, and only them, at most {EMAILS_PER_DAY} a day. Emails to anyone marked “Ask me” wait for your OK in Approvals.
      </p>
      <label className="toggle block">
        <input type="checkbox" checked={email.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>The CEO may send email</span>
      </label>
      <div className="notify-hook">
        <div className="row wrap">
          <b className="grow">Sender</b>
          <span className="small">{sender.set ? `🔑 Set (${sender.mode === 'keyvault' ? 'Key Vault certificate' : 'client secret'}) ${sender.hint}` : 'Not set'}</span>
        </div>
        {!sender.set && (
          <p className="muted small">
            Register an app in Microsoft Entra with Mail.Send, then save it with <code>PUT /api/email/sender</code>: see <a href={DOCS}>docs/email.md</a>.
          </p>
        )}
        <label className="field">
          <span>From (the mailbox it sends from)</span>
          <input
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onBlur={() => from.trim().toLowerCase() !== email.from && void save({ from: from.trim() })}
            placeholder="ceo@your-company.com"
            inputMode="email"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Blind copy of every email to</span>
          <select value={email.copyTo} onChange={(e) => void save({ copyTo: e.target.value })}>
            <option value="">Nobody</option>
            {email.recipients.map((r) => (
              <option key={r.email} value={r.email}>
                {r.name} &lt;{r.email}&gt;
              </option>
            ))}
          </select>
        </label>
        <div className="row wrap">
          <button className="btn btn-small" disabled={test.busy || !email.copyTo || !sender.set} onClick={() => void runTest()}>
            {test.busy ? 'Sending…' : 'Send test'}
          </button>
          {test.result && (
            <span className={`small ${test.ok ? 'notify-ok' : 'term-error'}`} role="status">
              {test.result}
            </span>
          )}
        </div>
      </div>
      <h4 className="notify-h">Who the CEO may email</h4>
      {email.recipients.length === 0 && <p className="muted small">Nobody yet.</p>}
      <ul className="email-list">
        {email.recipients.map((r) => (
          <li key={r.email} className="row wrap">
            <span className="grow">
              <b>{r.name}</b> <span className="muted small">{r.email}</span>
            </span>
            <label className="toggle small" title="Each email to them waits for your OK">
              <input type="checkbox" checked={r.approve} onChange={(e) => setRecipients(email.recipients.map((x) => (x.email === r.email ? { ...x, approve: e.target.checked } : x)))} /> Ask me
            </label>
            <button
              className="btn btn-small btn-ghost"
              aria-label={`Remove ${r.name}`}
              onClick={() =>
                void confirmDialog({ tone: 'danger', title: `Remove ${r.name}?`, body: 'The CEO can no longer email them. Emails to them still waiting for your OK won’t go out.', confirm: 'Remove' }).then((ok) => {
                  if (ok) setRecipients(email.recipients.filter((x) => x.email !== r.email));
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="notify-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!addOk) return;
          setRecipients([...email.recipients, { email: add.email.trim(), name: add.name.trim(), approve: add.approve }]);
          setAdd({ email: '', name: '', approve: true });
        }}
      >
        <div className="row wrap">
          <input type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} placeholder="name@example.com" aria-label="Email address" autoComplete="off" className="grow" />
          <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Name" aria-label="Name" maxLength={MAX_NAME} className="grow" />
        </div>
        <div className="row wrap">
          <label className="toggle small grow">
            <input type="checkbox" checked={add.approve} onChange={(e) => setAdd({ ...add, approve: e.target.checked })} /> Ask me before each email to them
          </label>
          <button className="btn btn-small btn-good" disabled={!addOk}>
            Add
          </button>
        </div>
      </form>
      <h4 className="notify-h">Daily digest</h4>
      <p className="muted small">
        Once a day, one email with every PR and issue waiting for you on each floor, and what merged in the last 24 hours. Built by the office, not the CEO; sent only
        when there's something to say, and it counts toward the {EMAILS_PER_DAY} a day.
      </p>
      <div className="notify-hook">
        <label className="field">
          <span>Send it to (someone without “Ask me”)</span>
          <select value={digest.to} onChange={(e) => void save({ digest: { ...digest, to: e.target.value, enabled: digest.enabled && !!e.target.value } })}>
            <option value="">Nobody</option>
            {direct.map((r) => (
              <option key={r.email} value={r.email}>
                {r.name} &lt;{r.email}&gt;
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>At (office time)</span>
          <select value={digest.hour} onChange={(e) => void save({ digest: { ...digest, hour: Number(e.target.value) } })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
        <label className="toggle block">
          <input type="checkbox" checked={digest.enabled} disabled={!digest.to} onChange={(e) => void save({ digest: { ...digest, enabled: e.target.checked } })} />
          <span>Send the digest every day</span>
        </label>
        <div className="row wrap">
          <button className="btn btn-small" disabled={digestRun.busy || !digest.to || !sender.set || !email.enabled} onClick={() => void runDigest()}>
            {digestRun.busy ? 'Sending…' : 'Send digest now'}
          </button>
          {digestRun.result && (
            <span className={`small ${digestRun.tone}`} role="status">
              {digestRun.result}
            </span>
          )}
        </div>
      </div>
      {error && (
        <div className="term-error small" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
