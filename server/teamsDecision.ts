// Whole-line card answers from Teams. Identity and open-card checks belong to the office, not this parser.
import { MAX_DECISION_TEXT } from '../shared/decisions.ts';

type Card = { number: number; repo?: string };
export type TeamsDecisionCommand =
  | (Card & { kind: 'approve' | 'retry-qa' | 'close' })
  | (Card & { kind: 'option'; option: number })
  | (Card & { kind: 'send-back'; note: string })
  | { kind: 'no-number' };

/** Commands occupy a whole line; mentions and a final period are optional. */
export function parseTeamsDecisions(text: string): TeamsDecisionCommand[] {
  const commands: TeamsDecisionCommand[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^@[^#:\n]+?\s+(?=(?:approve|yes|option|retry|send|close)\b)/i, '').replace(/\.$/, '').trim();
    const m = /^(approve|yes\s+on|option\s+([1-9])(?:\s+on)?|retry\s+qa(?:\s+on)?|send\s+back|close)\s+(?:([\w./-]+)\s+)?#([1-9]\d*)(?:\s*:\s*(.+))?$/i.exec(line);
    if (m) {
      const number = Number(m[4]);
      if (!Number.isSafeInteger(number)) continue;
      const card = { number, ...(m[3] ? { repo: m[3] } : {}) };
      const verb = m[1].toLowerCase();
      if (verb.startsWith('send')) {
        const note = m[5]?.trim();
        if (note && note.length <= MAX_DECISION_TEXT) commands.push({ ...card, kind: 'send-back', note });
      } else if (!m[5]) {
        if (m[2]) commands.push({ ...card, kind: 'option', option: Number(m[2]) });
        else commands.push({ ...card, kind: verb.startsWith('retry') ? 'retry-qa' : verb === 'close' ? 'close' : 'approve' });
      }
    } else if (/^(?:approve|yes\s+on\s+(?:the\s+)?(?:merge|card|recommendation)|option\s+[1-9](?:\s+on\s+(?:the\s+)?card)?|retry\s+qa|send\s+back|close)(?:\s+(?:the\s+)?card)?$/i.test(line)) {
      commands.push({ kind: 'no-number' });
    }
  }
  return commands;
}
