// Decision briefs: what the office brings the manager when a building agent needs a business decision (a needs-input
// issue, or a PR held with swarm:hold). One template for everyone: the agents write it into the issue or PR body, the
// CEO posts one as a comment when it is missing (write_brief), and the digest and the phone alerts read it back. Pure.

/** The section heading that starts a brief. */
export const BRIEF_HEADING = 'Decision brief';
/** On an issue: the manager has to decide something before it can be built. */
export const NEEDS_INPUT = 'needs-input';
/** On an issue: nobody answered in time, so the office applied the brief's recommendation (server/decisionClock.ts). */
export const DECIDED_DEFAULT = 'decided:default';
/** Hidden in every comment the office posts, so the decision clock can tell them from the manager's replies. */
export const OFFICE_MARK = '<!-- cubefarm -->';

/** How the manager answers a decision, under every brief's deadline. */
export const HOW_TO_ANSWER = "Reply on the Decision room card or comment starting with 'Decision:' to answer.";

export interface Brief {
  background: string;
  decision: string;
  options: string[]; // each with its trade-offs
  recommendation: string; // and why
  risk: string; // risk and mitigation
  ifNoReply: string; // what the office does when the manager doesn't answer
}

/** The sections in order: the key, the heading, and what goes in it (for the prompts). */
export const BRIEF_SECTIONS: { key: keyof Brief; heading: string; what: string }[] = [
  { key: 'background', heading: 'Background', what: 'what this is about, in plain words for an executive who has not read the code' },
  { key: 'decision', heading: 'The decision', what: 'the one question to answer' },
  { key: 'options', heading: 'Options', what: 'a bullet per option, each with its trade-offs' },
  { key: 'recommendation', heading: 'Recommendation', what: 'the option you would pick, and why' },
  { key: 'risk', heading: 'Risk and mitigation', what: 'what could go wrong with it, and how that is limited' },
  { key: 'ifNoReply', heading: 'If no reply by', what: `what the office does if nobody answers in time (it applies the recommendation). ${HOW_TO_ANSWER}` },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const HEADING = /^\s{0,3}(#{2,6})\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s{0,3}\*\*(.+?):?\*\*:?\s*$/;

/** Which section a heading line names, or null. "If no reply by Fri 13 Nov" counts as If no reply by. */
function sectionOf(title: string): keyof Brief | null {
  const t = norm(title);
  if (t.startsWith('if no reply')) return 'ifNoReply';
  if (t.startsWith('risk')) return 'risk';
  if (/^(the )?decision\b/.test(t)) return 'decision';
  if (t.startsWith('recommend')) return 'recommendation';
  if (/^(the )?options\b/.test(t)) return 'options';
  if (/^(background|context)\b/.test(t)) return 'background';
  return null;
}

/** Bullet or numbered lines as items; other lines join the item before them. */
function listItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) items.push(m[1].trim());
    else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) items.push(line.trim());
  }
  return items.filter(Boolean);
}

/**
 * The brief in a body or comment, or null when there is no "## Decision brief" heading. Its sections are headings
 * under it (### Background, …) or bold lines (**Background**); missing ones are left empty (briefGaps lists them).
 */
export function parseBrief(text: string | null | undefined): Brief | null {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => {
    const m = HEADING.exec(l);
    return !!m && norm(m[2]) === norm(BRIEF_HEADING);
  });
  if (start < 0) return null;
  const level = HEADING.exec(lines[start])![1].length;
  const parts: Partial<Record<keyof Brief, string[]>> = {};
  let current: keyof Brief | null = null;
  for (const line of lines.slice(start + 1)) {
    const h = HEADING.exec(line);
    const b = h ? null : BOLD_HEADING.exec(line);
    const named = h ? sectionOf(h[2]) : b ? sectionOf(b[1]) : null;
    if (h && !named && h[1].length <= level) break; // the next section of the body
    if (named) {
      current = named;
      parts[current] = [];
      continue;
    }
    if (current) parts[current]!.push(line);
  }
  const text_ = (k: keyof Brief) =>
    (parts[k] ?? [])
      .filter((l) => !l.includes(HOW_TO_ANSWER))
      .join('\n')
      .trim();
  return {
    background: text_('background'),
    decision: text_('decision'),
    options: listItems(text_('options')),
    recommendation: text_('recommendation'),
    risk: text_('risk'),
    ifNoReply: text_('ifNoReply'),
  };
}

/** The sections a brief leaves empty, by heading. */
export function briefGaps(b: Brief): string[] {
  return BRIEF_SECTIONS.filter((s) => (s.key === 'options' ? b.options.length === 0 : !b[s.key])).map((s) => s.heading);
}

/** A brief the office can act on: it says what is decided and what it recommends. */
export const usableBrief = (b: Brief | null): b is Brief => !!b && !!b.decision && !!b.recommendation;

/** The newest brief on an issue or PR: the latest comment that has one, else the body. */
export function findBrief(body: string | null | undefined, comments: readonly { body: string }[]): Brief | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const b = parseBrief(comments[i].body);
    if (b) return b;
  }
  return parseBrief(body);
}

/** The brief as markdown, for a comment. `by`: the deadline in words ("Wed 11 Nov 08:00"), when there is one. */
export function renderBrief(b: Brief, by?: string | null): string {
  const out = [`## ${BRIEF_HEADING}`];
  for (const s of BRIEF_SECTIONS) {
    const heading = s.key === 'ifNoReply' ? (by ? `If no reply by ${by}` : 'If no reply') : s.heading;
    const body = s.key === 'options' ? b.options.map((o) => `- ${o}`).join('\n') : b[s.key];
    out.push('', `### ${heading}`, body || '_(not given)_');
    if (s.key === 'ifNoReply') out.push('', `_${HOW_TO_ANSWER}_`);
  }
  return out.join('\n');
}

const oneLine = (s: string, max: number) => {
  const t = s
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * The brief as plain-text lines, one per section, for the digest and the phone. `max`: the most characters per
 * section (the phone has little room). `by`: the office's deadline in words.
 */
export function briefLines(b: Brief, opts: { by?: string | null; max?: number } = {}): string[] {
  const max = opts.max ?? 600;
  const lines = [
    `Background: ${oneLine(b.background || '(not given)', max)}`,
    `The decision: ${oneLine(b.decision || '(not given)', max)}`,
    `Options: ${b.options.length ? b.options.map((o, i) => `(${i + 1}) ${oneLine(o, Math.max(40, Math.floor(max / b.options.length)))}`).join(' ') : '(not given)'}`,
    `Recommendation: ${oneLine(b.recommendation || '(not given)', max)}`,
    `Risk and mitigation: ${oneLine(b.risk || '(not given)', max)}`,
  ];
  const fallback = b.ifNoReply || `the office applies the recommendation`;
  lines.push(`${opts.by ? `If no reply by ${opts.by}` : 'If no reply'}: ${oneLine(fallback, max)}`);
  return lines;
}

/**
 * Whether a recommendation is to merge the PR as it is: its first sentence starts with merging ("Merge it",
 * "I recommend merging as is") and asks for nothing first ("Rename it, then merge" and "Do not merge" are not).
 */
export function recommendsMerge(recommendation: string): boolean {
  const first = recommendation.trim().split(/(?<=[.!?])\s/)[0].toLowerCase();
  if (!/^(?:i\s+)?(?:recommend(?:ed|ation)?:?\s+)?(?:option\s+\w+\s*[:,-]?\s*)?merg(?:e|ing)\b/.test(first)) return false;
  return !/\b(after|once|then|first|when|if|until|before|unless)\b/.test(first);
}

/** The template the building agents get in their prompt, one line per section. */
export const BRIEF_TEMPLATE = [`## ${BRIEF_HEADING}`, ...BRIEF_SECTIONS.map((s) => `### ${s.key === 'ifNoReply' ? 'If no reply by <date>' : s.heading} (${s.what})`)].join('\n');
