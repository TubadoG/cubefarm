// One email the CEO wrote, as a card (the phone's Team tab and chat, pocket mode's Approvals): who it's to, the
// subject, the text behind a disclosure, and Send / Decline while it waits for the manager's OK.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EmailView } from '../../../shared/types';

const OUTCOME: Record<Exclude<EmailView['status'], 'pending'>, string> = { sent: '📧 sent', declined: '✋ declined', failed: '⚠️ failed' };

export function EmailCard({ email, highlight }: { email: EmailView; highlight?: boolean }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlight]);
  const pending = email.status === 'pending';
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // api() already toasted
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={ref} className={`resume email-card ${highlight ? 'resume-hot' : ''} ${pending ? '' : 'resume-done'}`}>
      <div className="resume-head">
        <span className="email-icon" aria-hidden>
          📧
        </span>
        <div className="grow">
          <div className="resume-name">{email.subject}</div>
          <div className="resume-title">
            To {email.toName} &lt;{email.to}&gt;
          </div>
        </div>
        {email.status !== 'pending' && <span className={`chip ${email.status === 'sent' ? 'chip-good' : ''}`}>{OUTCOME[email.status]}</span>}
      </div>
      <details className="email-preview">
        <summary className="small">Read the email</summary>
        <pre className="email-body">{email.body}</pre>
      </details>
      {email.error && <div className="term-error small">{email.error}</div>}
      {email.note && <div className="muted small">Your note: “{email.note}”</div>}
      {pending && !declining && (
        <div className="row">
          <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setDeclining(true)}>
            Decline
          </button>
          <span className="spacer" />
          <button className="btn btn-small btn-good" disabled={busy} onClick={() => void act(() => api.sendEmail(email.id))}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
      {pending && declining && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.declineEmail(email.id, note));
          }}
        >
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why not? (optional, the CEO reads it)" autoFocus />
          <button className="btn btn-small btn-bad" disabled={busy}>
            Decline
          </button>
        </form>
      )}
    </div>
  );
}
