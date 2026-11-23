# Codex brief — Decision room answers from Teams

Repo: `/Users/BClayton/Code/cubefarm` (TypeScript, Node, Express server in `server/`, React client, vitest). Base: `main` at `860c258` or later.
Branch for this work: `feat/teams-decision-answers` (create from `main`). Do not push to `main`; Claude reviews and merges.
Owner: Claude, on behalf of Bryan Clayton. Executor: Codex.

---

## 0. How we work in this file (message board)

This file is the only channel between Codex and Claude. Both agents read and write it.

- **Codex:** read the whole file before starting. After each task, append an entry to section 6 (status log): timestamp, task number, files changed, test result. For a question or blocker, append it to section 5 under **Questions from Codex**, save, and continue with any task that does not depend on the answer. Re-read this file before each new task; Claude's answers land under **Answers from Claude**.
- **Claude:** checks this file every 5 minutes, answers in section 5, never edits Codex's section 6 entries.
- **Done:** when every task is complete and the checks in section 4 pass, append a final log entry that contains the exact line `ALL TASKS COMPLETE`.
- Keep entries to one to three lines.

---

## 1. Why: what was asked and what the code does today

Bryan (the manager) answers Decision room cards. He often answers in Teams instead ("approve #152", "retry QA on #86"), and today the office refuses those on purpose: `server/teamsChannel.ts` `looksLikeDecision` (DECISION_LIKE, about line 176) only adds a line to the CEO's text telling the manager that decisions are answered in the Decision room (`managerText` / `directText`, about lines 195-216). On 2026-11-22 Bryan decided Teams answers should count, and on 2026-11-23 he approved this exact wording by email ("1 yes, 2 yes. Go ahead with the build."):

1. The card number is always required. Commands:
   - `approve #114` or `yes on #114`: apply the card's recommendation (same as the Decision room's Approve).
   - `option 2 on #114`: pick option 2.
   - `retry QA #114` (also `retry qa on #114`): send the PR back to QA (same as the stuck card's "retry QA" pick and the doctor's `retry-qa` fix in `server/swarm.ts` doctorFix, about line 5674: `clearPrepStrikes` then `setQa(rec, { status: 'queued', qaAgentId: null })`).
   - `send back #123: <note>`: send back with that note (the Decision room's send-back choice).
   - Anything without a card number (`yes on the merge`), a number with no open card, or a closed card: nothing happens, and the office replies in the same thread asking which card, or saying it is closed / not found.
   - Close stays in the Decision room only. `close #N` from Teams must NOT close anything; the reply says close is only in the Decision room.

Security (agreed with Zander, the CEO agent): only the manager counts, and only by identity, never by name. The office already decides this in `author()` (`server/teamsChannel.ts` about line 88): `kind: 'manager'` only when `from.user.id` is in `settings.managers`. A bot, a colleague app, a forwarded message, or a person with the same display name never counts. Only messages read from the office's own Teams channel or the manager's direct chat with the CEO's app count (the two sources `TeamsChannel` already reads).

Answers are applied by the existing `swarm.answerDecision(repoId, number, body)` (`server/swarm.ts` about line 6383, uses `parseDecisionChoice` and `answerPlan` in `server/decisionAnswer.ts`). Open cards come from `openDecisions()` (about line 6318) and `openDecision(repoId, number)` (about line 6371). The comment it posts is signed "_Answered by <name> in the cubefarm Decision room._" (decisionAnswer.ts `sign`).

---

## 2. Tasks (in this order)

### Task 1 — Parse Teams decision commands (pure)

- New file `server/teamsDecision.ts` with `parseTeamsDecisions(text: string): TeamsDecisionCommand[]`.
- A command is a whole line of the message (after `messageText`; trim, ignore case, optional leading "@Name " mentions, optional trailing period). Prose lines that merely contain "#114" are NOT commands. Several command lines in one message are all returned, in order.
- Optional repo word before the number, for when two floors share a number: `approve regn #114`, `approve openRTSM #114` (matched later against the repo full name, case-insensitive substring).
- Kinds: `approve`, `option` (1-9), `retry-qa`, `send-back` (note required, 1..MAX_DECISION_TEXT chars, from `shared/decisions.ts`), `close` (parsed only so it can be refused), and `no-number` for a whole line that reads like a card answer but has no card number (keep it conservative so normal chat is not caught).
- Test: `server/teamsDecision.test.ts` covering every form above, the repo word, multiple lines, prose that must not match ("I'm holding #86 until I hear back", "Zander, one more: I merged #146"), and `yes on the merge` gives no-number.

### Task 2 — Apply them in the office

- `TeamsChannel` (`server/teamsChannel.ts`): for a message whose author kind is `manager` (channel or direct chat; also when it @mentions someone else), run `parseTeamsDecisions`. If there are commands, call a new dep `decide(cmds, ctx)` (ctx: source channel or direct, thread root id, chat id) BEFORE delivering to the CEO. Wire the dep in `server/swarm.ts` where `new TeamsChannel({...})` is built (about line 751).
- In swarm: resolve each command to one open card across all repos by number (plus the optional repo word). 0 matches: "No open card #N." More than 1: "#N is open on more than one floor: write approve regn #N or approve openRTSM #N." approve/option/send-back: `answerDecision(repoId, n, body)` with the same body shape the Decision room sends. retry-qa: only for a PR card; same effect as doctorFix `retry-qa`. close: refused. Errors from answerDecision (HttpError message) go in the reply.
- Sign: the GitHub comment must say Teams, not the Decision room: add an optional `via?: 'room' | 'teams'` to the answerPlan input and sign "_Answered by <name> in Teams (cubefarm)._" for teams. Do not change the room's wording.
- Reply: one post in the same thread (channel: `root_id` = thread root; direct: the same chat) through the existing `post`, one line per command, for example "Done: #152 approved the recommendation (merge)." or "Not done: no open card #999." Bot posts count against `postsPerDay` like any CEO post; if the limit is hit, still apply the decision and log that the reply was skipped.
- CEO text: the CEO still gets the message, but `managerText`/`directText` replace the "Decisions are never answered in Teams" line with "(The office already applied these card answers from this message: .... Do not answer them again.)". Messages with no commands keep today's text, except the old refusal line becomes: "(If this was meant as a card answer, it needs a card number, for example approve #114.)" Update the CEO prompt text anywhere else that says decisions are never answered in Teams (grep for it) to match.
- Idempotent: a message id is applied once (the existing `seen` list plus persist-before-act already gives this; keep the order: persist, then decide, then deliver).
- Audit: `this.postMessage('office', ...)` a line per applied command ("Teams: <manager> approved #152 (regn)").
- Do NOT change `author()` rules, the colleague path, or anything in the Decision room UI.
- Test: `server/teamsOffice.test.ts` (extend): manager approve applies once; a colleague bot and a non-manager user with the manager's display name do nothing; unknown number replies "No open card"; close refused; retry QA on a stuck PR queues QA; ambiguous number asks for the floor; reply limit reached still applies.

### Task 3 — Docs and release note

- `docs/teams.md`: a short "Answering cards from Teams" section with the command list and the identity rule.
- `CHANGELOG.md`: an entry in the style of the newest one.

---

## 3. Constraints

- No database; the office state is JSON. Keep the persisted state shape backward compatible (new fields optional).
- Keep the existing code style and comment convention (short doc comments, plain English). Surgical diffs; no reformatting.
- Never post to real Teams or GitHub from tests; use the existing fakes in the Teams tests.
- Commit per task on the branch: `feat(teams): ...`. End each commit message with `Co-Authored-By: Codex <noreply@openai.com>`.

## 4. Checks before declaring done

```bash
npx tsc --noEmit -p .
npx vitest run
npm run build
```
All must pass. Paste the vitest summary line into the final log entry.

---

## 5. Questions and answers

### Questions from Codex
(none yet)

### Answers from Claude
(none yet)

---

## 6. Status log (Codex appends; Claude reads)

- 2026-11-23 — Claude: brief written at main `860c258`. Waiting for Codex.
- 2026-11-23 16:09 UTC — Task 1 complete: added `server/teamsDecision.ts` and `server/teamsDecision.test.ts`; whole-line commands, repo hints, bounded notes and conservative missing-number detection. Vitest: 1 file, 21 tests passed.
