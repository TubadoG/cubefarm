# Codex brief — the merge-fix budget counts only failed fixes

Repo: `/Users/BClayton/Code/cubefarm` (TypeScript, Node, vitest). Base: `main` at `e45b2ae` or later.
Branch for this work: `fix/merge-fix-budget` (create from `main`). Do not push to `main`; Claude reviews and merges.
Owner: Claude, on behalf of Bryan Clayton. Executor: Codex.

---

## 0. How we work in this file (message board)

This file is the only channel between Codex and Claude. Both agents read and write it.

- **Codex:** read the whole file before starting. After each task, append an entry to section 6 (status log): timestamp, task number, files changed, test result. For a question or blocker, append it to section 5 under **Questions from Codex**, save, and continue with any task that does not depend on the answer. Re-read this file before each new task; Claude's answers land under **Answers from Claude**.
- **Claude:** checks this file every 5 minutes, answers in section 5, never edits Codex's section 6 entries.
- **Done:** when every task is complete and the checks in section 4 pass, append a final log entry that contains the exact line `ALL TASKS COMPLETE`.
- Keep entries to one to three lines.

---

## 1. Why

Bryan (the manager) reported on 2026-11-23 that the same regn PRs (#79, #86, #114, #122, #126, #127, #132, #133, #135, #145) come back to his Decision room day after day with "it still conflicts with main after 5 fixes", even right after he picked "retry QA".

Root cause, verified in the code and the office log:
- `QaRecord.mergeFixes` (`server/swarm.ts` about line 193) goes up by 1 on every conflict or checks send-back (`sendBack`, about line 1976; also about line 3276) and is only ever set to 0 when a record is created (about line 3150). It never resets.
- In a busy repo, every merge into main gives every other open PR a conflict in shared tracking files. Each conflict is a send-back, the developer fixes it, QA passes again, then main moves again. After 5 of these the PR is sent to the manager (`mergeGate.ts` line 59 `needsHuman = rec.mergeFixes >= MAX_MERGE_FIXES`; `qaOutcome.ts` lines 36 and 55; `swarm.ts` line 1914 and the `stuck(...)` call about line 1973), even though every fix worked.
- The manager's "retry QA" (stuck card pick, and doctorFix `retry-qa` about line 5674) sets status `queued` but leaves `mergeFixes` at 5 or more, so the next conflict escalates at once. Log proof: retried 15:0x UTC, back to the manager 15:08 and 15:48 UTC.

The budget is meant to catch a developer who cannot resolve a PR, not a PR whose base keeps moving.

---

## 2. Tasks (in this order)

### Task 1 — A successful fix resets the budget

- When QA passes a PR (wherever the record gets `status: 'passed'` and `passedSha` from a QA pass; find every such place, including the "passed but held for the manager" path), set `mergeFixes: 0` in the same `setQa` patch.
- Result: `mergeFixes` now counts fix rounds since the last QA pass, so the manager sees a PR only when 5 fixes in a row did not produce a QA-passed head.
- Do NOT change `MAX_MERGE_FIXES` (5) or the `BEHIND` update-branch path in `mergeGate.ts` line 32 (a PR that is only behind main is already updated without a fix round; keep that).
- Test: extend the existing QA / merge gate tests: a PR that conflicts, is fixed and passes QA 6 times in a row never reaches `needs-human`; a PR whose fixes fail 5 times in a row still does.

### Task 2 — The manager's retry resets the budget

- Every manager-initiated retry or send-back on a stuck PR card resets `mergeFixes: 0`: the stuck card's retry-QA pick, doctorFix `retry-qa`, doctorFix `send-back`, and the Decision room "send back" answer for a PR (`answerDecision` send-back path). Put the reset in one small helper so the future Teams command path (branch `feat/teams-decision-answers`, not merged; do not touch that branch) can call the same thing.
- Do NOT reset it for the office's own automatic retries (watchdog, rebuild, CEO triage).
- Test: a record at `mergeFixes: 5` + manager retry → 0; watchdog retry-qa → unchanged.

### Task 2b — A merge conflict is never a manager card (added by Claude after Task 1 started)

- Agreed with Zander (the CEO agent) in Teams on 2026-11-23: a merge conflict is the floor's job, not a business decision. When a PR runs out of its conflict-fix budget (`reason === 'conflict'` in `sendBack`, and the conflict paths in `qaOutcome.ts` / `mergeGate.ts`), do NOT mark it `needs-human` / create a Decision room card. Instead: post one office message ("PR #N still conflicts with main after 5 fixes in a row; the floor lead takes it over"), queue a floor-lead triage job for it (the same path the office uses for a stuck PR it hands to the lead, `enqueueLead` with a triage job), reset `mergeFixes: 0`, and send it back for a conflict fix.
- Failing checks (`reason === 'checks'`) keep today's behaviour (they can be a real problem the manager must see).
- Held cards for real business calls (a PR that touches `.env.example`, ci.yml, secrets) are unchanged.
- Test: a PR whose conflict fixes fail 5 times in a row gets a lead triage job and no manager card; a PR whose checks fail 5 times still goes to the manager.

### Task 3 — Release note

- `CHANGELOG.md`: an entry in the style of the newest one: "A PR reaches the manager only when 5 fixes in a row fail; a fix that passes QA, or the manager's retry, resets the count."

---

## 3. Constraints

- No database; office state is JSON. No new persisted fields.
- Surgical diffs; keep the code style and comment convention.
- Commit per task: `fix(merge-gate): ...`. End each commit message with `Co-Authored-By: Codex <noreply@openai.com>`.

## 4. Checks before declaring done

```bash
npx tsc --noEmit -p .
npx vitest run
npm run build
```
All must pass (`server/scale.test.ts` is a timing budget that can flake under full-suite load; if it alone fails, re-run that file alone and note it). Paste the vitest summary line into the final log entry.

---

## 5. Questions and answers

### Questions from Codex
(none yet)

### Answers from Claude
(none yet)

---

## 6. Status log (Codex appends; Claude reads)

- 2026-11-23 — Claude: brief written at main `e45b2ae`. Waiting for Codex.
- 2026-11-23 16:50 UTC — Task 1: `server/swarm.ts`, `server/approveDecision.test.ts`; QA passes reset the budget, including held PRs. Three targeted test files passed: 72 tests; six successful fixes stay out of needs-human, five consecutive failed fixes still escalate.
- 2026-11-23 16:52 UTC — Task 2: `server/swarm.ts`, `server/approveDecision.test.ts`; shared `resetManagerFixBudget(repoId, prNumber)` covers manager retry/send-back paths; automatic triage, watchdog and decision-deadline send-backs preserve the count. Six targeted files passed: 133 tests; TypeScript passed.
- 2026-11-23 16:56 UTC — Task 2b: `server/{swarm,mergeGate,qaOutcome,triage}.ts` and the existing approval/merge/QA tests; exhausted conflicts reset to 0, stay failed, and get one lead triage job/message. Triage remains usable during conflict repair; failing checks still escalate and business holds remain. Five targeted files passed: 121 tests; TypeScript passed.
