// The decisions audit (docs/decision-connector.md): one JSON line per answer the office applied or refused, from a
// Room card or the decision connector, in <SWARM_HOME>/decision-audit.jsonl (demo-decision-audit.jsonl in a demo).
// Appended, never rewritten; no brief text or secrets, just who asked for what and what the office did.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AnswerVia } from './decisionAnswer.ts';

export interface AuditRow {
  at: string; // ISO, when the row was written
  via: AnswerVia;
  tool: string; // the connector's tool, or the Room's choice (approve, option, send-back, close)
  repo: string;
  number: number;
  choice: string; // what was asked, in words
  result: 'applied' | 'refused';
  detail: string; // what the office did, or why it refused
  answerId?: string; // the connector's answer id
  askedAt?: string | null; // the connector: when Bryan asked
  appliedAt?: string; // when the office applied (or refused) it
  askedBy?: string | null; // the connector: the Entra object id the sign-in token named
  expectedHeadSha?: string | null;
  actualHeadSha?: string | null;
}

/** Most rows kept in memory for the settings page and tests; the file keeps them all. */
const KEEP = 200;

export class DecisionAudit {
  private queue: Promise<void> = Promise.resolve();
  readonly rows: AuditRow[] = [];

  constructor(
    private file: string,
    private log: (line: string) => void = console.warn,
  ) {}

  /** Appends a row (in order, one write at a time). Failing to write is logged, never thrown at the answer. */
  write(row: AuditRow): Promise<void> {
    this.rows.push(row);
    if (this.rows.length > KEEP) this.rows.splice(0, this.rows.length - KEEP);
    this.queue = this.queue
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.appendFile(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      })
      .catch((err) => this.log(`could not write the decisions audit: ${(err as Error).message}`));
    return this.queue;
  }
}
