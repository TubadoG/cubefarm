// The Decision room (shared/decisions.ts): every open decision on every floor as a card, in the 3D office's panel and
// pocket mode's tab. A card shows its decision brief and the time left before the office applies the recommendation,
// and answers it in one tap (the recommendation, an option, a send-back with a note, or a close), or asks the CEO.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { CEO_ID, type BoardChangeView } from '../../../shared/types';
import { countdown, decisionHash, MAX_DECISION_TEXT, type DecisionChoice, type DecisionView } from '../../../shared/decisions';
import { confirmDialog } from './Confirm';
import { Markdown } from './Markdown';

const REASON: Record<DecisionView['reason'], string> = { 'needs-input': '❓ needs your input', held: '✋ held for you', stuck: '⚠️ stuck' };

/** The clock, ticking every `ms`, for the countdowns. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What a choice does, for the confirmation. */
function choiceWords(d: DecisionView, c: DecisionChoice): string {
  const what = d.kind === 'pr' ? `PR #${d.number}` : `#${d.number}`;
  if (c.choice === 'close') return d.kind === 'pr' ? `Close ${what} without merging.` : `Decline ${what}: it closes as not planned.`;
  if (c.choice === 'send-back') return d.kind === 'pr' ? `Send ${what} back to a developer with your note.` : `Answer ${what} with your note; the team builds it.`;
  const text = c.choice === 'approve' ? d.brief?.recommendation : d.brief?.options[c.option - 1];
  return `${c.choice === 'approve' ? 'Approve the recommendation' : `Choose option ${c.option}`} on ${what}: “${short(text ?? '', 160)}”`;
}

export function DecisionCard({ d, focused }: { d: DecisionView; focused?: boolean }) {
  const now = useNow();
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState('');
  const repo = useStore((s) => s.repos.find((r) => r.id === d.repoId));
  const ceoName = useStore((s) => s.agents[CEO_ID]?.name ?? 'The CEO');
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focused]);
  const left = d.answeredAt ? null : countdown(d.deadline, now);
  const b = d.brief;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch {
      return false; // api() already toasted
    } finally {
      setBusy(false);
    }
  };
  const answer = async (c: DecisionChoice) => {
    const ok = await confirmDialog({ icon: '🧭', tone: c.choice === 'close' ? 'danger' : undefined, title: 'Record your decision?', body: choiceWords(d, c), confirm: 'Decide' });
    if (ok && (await act(() => api.answerDecision(d.repoId, d.number, c)))) setNote('');
  };
  const ask = async () => {
    if (await act(() => api.askDecision(d.repoId, d.number, question.trim()))) setQuestion('');
  };
  const name = d.repoId.split('/')[1] ?? d.repoId;
  return (
    <article ref={ref} id={`decision-${decisionHash(d.repoId, d.number)}`} className={`decision-card ${focused ? 'decision-focused' : ''}`} style={{ ['--accent' as string]: repo?.color ?? '#6699CC' }}>
      <header className="decision-head">
        <span className="floor-badge">{d.floor}</span>
        <div className="grow">
          <a href={d.url} target="_blank" rel="noreferrer">
            <b>
              {d.kind === 'pr' ? 'PR ' : ''}#{d.number}
            </b>
          </a>{' '}
          {d.title}
          <div className="muted small">
            {name} · {REASON[d.reason]}
          </div>
        </div>
        {left && <span className={`chip ${left.due ? 'chip-warn' : ''}`} title={d.deadline ? new Date(d.deadline).toLocaleString() : undefined}>⏱️ {left.label}</span>}
      </header>

      {d.answer && <p className="decision-answered">✅ You {d.answer}</p>}
      {!d.answer && d.answeredAt && <p className="decision-answered">✅ You answered on GitHub. The office won't decide this by default.</p>}

      {b ? (
        <dl className="decision-brief">
          <dt>Background</dt>
          <dd>{b.background || '(not given)'}</dd>
          <dt>The decision</dt>
          <dd>
            <b>{b.decision}</b>
          </dd>
          <dt>Options</dt>
          <dd>
            <ol>
              {b.options.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ol>
          </dd>
          <dt>Recommendation</dt>
          <dd>{b.recommendation}</dd>
          <dt>Risk and mitigation</dt>
          <dd>{b.risk || '(not given)'}</dd>
          <dt>{d.deadline && !d.answeredAt ? `If no reply by ${new Date(d.deadline).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'If no reply'}</dt>
          <dd>{d.deadline ? b.ifNoReply || 'The office applies the recommendation.' : d.reason === 'stuck' ? 'It waits for you: stuck PRs are never decided by default.' : 'It waits for you: this floor never decides by default.'}</dd>
        </dl>
      ) : (
        <p className="muted">{d.briefRead ? `No decision brief yet: ${ceoName} is writing it. You can still answer, or ask below.` : 'Reading the brief…'}</p>
      )}

      <div className="decision-actions">
        <button className="btn btn-small btn-good" disabled={busy || !b?.recommendation} onClick={() => void answer({ choice: 'approve' })} title={b?.recommendation}>
          ✓ Approve recommendation
        </button>
        {(b?.options ?? []).map((o, i) => (
          <button key={i} className="btn btn-small" disabled={busy} onClick={() => void answer({ choice: 'option', option: i + 1 })} title={o}>
            Option {i + 1}: {short(o.split(/[:.;]/)[0] ?? o, 32)}
          </button>
        ))}
        <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void answer({ choice: 'close' })}>
          {d.kind === 'pr' ? '✕ Close PR' : '✕ Decline'}
        </button>
      </div>
      <div className="decision-row">
        <input
          value={note}
          maxLength={MAX_DECISION_TEXT}
          onChange={(e) => setNote(e.target.value)}
          placeholder={d.kind === 'pr' ? 'Send back with a note: what to change' : 'Answer in your own words'}
          aria-label={`Note for ${d.kind === 'pr' ? 'PR ' : ''}#${d.number}`}
        />
        <button className="btn btn-small" disabled={busy || !note.trim()} onClick={() => void answer({ choice: 'send-back', note: note.trim() })}>
          {d.kind === 'pr' ? '↩ Send back' : '↩ Answer'}
        </button>
      </div>

      {(d.thread.length > 0 || d.asking) && (
        <ol className="decision-thread" aria-label="Questions and answers">
          {d.thread.map((m, i) => (
            <li key={i} className={`decision-msg decision-msg-${m.from}`}>
              <span className="muted small">{m.from === 'manager' ? 'You' : m.from === 'ceo' ? ceoName : 'Office'} · {new Date(m.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              {m.from === 'ceo' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
            </li>
          ))}
          {d.asking && <li className="decision-msg muted small">{ceoName} is looking into it…</li>}
        </ol>
      )}
      <div className="decision-row">
        <input value={question} maxLength={MAX_DECISION_TEXT} onChange={(e) => setQuestion(e.target.value)} placeholder={`Ask ${ceoName} about this decision`} aria-label={`Question for ${ceoName} about #${d.number}`} onKeyDown={(e) => e.key === 'Enter' && question.trim() && !busy && void ask()} />
        <button className="btn btn-small" disabled={busy || !question.trim()} onClick={() => void ask()}>
          💬 Ask
        </button>
      </div>
    </article>
  );
}

const KIND: Record<BoardChangeView['kind'], string> = { close: '🗂️', merge: '🧷', relabel: '🏷️', reorder: '↕️', split: '✂️', depends: '🔗', release: '↩️' };

/**
 * The floor leads' board changes of the last week (docs/floor-lead.md), each undone in one tap, no approval needed. The
 * Monday digest links each one here (#board-<id>).
 */
export function BoardLog() {
  const log = useStore((s) => s.boardLog);
  const [busy, setBusy] = useState<string | null>(null);
  const focus = typeof location !== 'undefined' && location.hash.startsWith('#board-') ? location.hash.slice('#board-'.length) : null;
  useEffect(() => {
    if (focus) document.getElementById(`board-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, log.length]);
  if (!log.length) return null;
  const undo = async (e: BoardChangeView) => {
    if (!(await confirmDialog({ icon: '↩️', title: 'Undo this board change?', body: `${e.undo}. ${e.by}, the floor lead, made it: ${e.summary}`, confirm: 'Undo' }))) return;
    setBusy(e.id);
    try {
      await api.undoBoardChange(e.id);
    } catch {
      // api() already toasted
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="board-log" aria-label="Board changes this week">
      <h3>Board changes this week</h3>
      <p className="muted small">What the floor leads changed on the boards. Each one can be undone; none needed your approval.</p>
      <ul>
        {log.map((e) => (
          <li key={e.id} id={`board-${e.id}`} className={`board-change ${focus === e.id ? 'decision-focused' : ''}`}>
            <span aria-hidden>{KIND[e.kind]}</span>{' '}
            <span className="grow">
              <span className="floor-badge">{e.floor}</span> {e.summary}
              <span className="muted small">
                {' '}
                · {e.by} · {new Date(e.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                {e.undoError ? ` · undo failed: ${e.undoError}` : ''}
              </span>
            </span>
            {e.undoneAt ? (
              <span className="muted small">undone</span>
            ) : (
              <button className="btn btn-small" disabled={busy === e.id} title={e.undo} onClick={() => void undo(e)}>
                ↩️ Undo
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every open decision, the focused card (a deep link's) scrolled to, then the week's board changes. */
export function DecisionRoom({ focus }: { focus?: string | null }) {
  const decisions = useStore((s) => s.decisions);
  return (
    <div className="decision-room">
      {decisions.length === 0 ? (
        <p className="pk-empty">No decisions wait for you. When the team needs a business call, it shows up here with a brief.</p>
      ) : (
        <p className="muted small">
          {decisions.length} open decision{decisions.length === 1 ? '' : 's'}. Answer here, or comment on GitHub starting with “Decision:”.
        </p>
      )}
      {decisions.map((d) => (
        <DecisionCard key={d.key} d={d} focused={focus === d.key} />
      ))}
      <BoardLog />
    </div>
  );
}
