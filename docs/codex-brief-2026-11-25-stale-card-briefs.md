# Codex brief — a PR card never shows a brief written before its current decision

Repo: `/Users/BClayton/Code/cubefarm` (TypeScript, Node, vitest). Base: `main` at `c703071` or later.
Branch for this work: `fix/stale-card-briefs` (create from `main`). Do not push to `main`; Claude reviews and merges.
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

Bryan (the manager) reported on 2026-11-25 that the Decision room card for regn-uat-platform PR #135 tells him to "fix GitHub Actions billing" (option A) or "wait for BC self-hosted runners" (option B). Both are out of date: regn CI moved to the self-hosted runner `cubefarm-regn-1` (label `bc-cubefarm-regn`), and the latest #135 run (45540103602) passed all 5 jobs there. The billing failure was run 44841443635 on 2026-11-21, on `ubuntu-latest`.

Root cause:
- The card's brief comes from `findBrief(talk.body, talk.comments)` at `server/swarm.ts:6197` (decision clock). `findBrief` (`shared/brief.ts:114`) returns the newest comment that parses as a brief, with no regard to its age.
- On #135 the newest brief comment is the escalation brief Lead 2 posted on 2026-11-21 (via `server/swarm.ts:4886` escalate → `escalationBrief`). Since then the PR had a conflict (its card was dropped by `reconcileDecisionConflicts`, `server/swarm.ts:6300` area), was fixed, passed QA again, and came back as a new held decision with a new `DecisionRecord.firstSeen` (`server/decisionClock.ts:84`). The new decision reuses the old brief, so the card shows facts from four days ago.
- Because an old brief counts as usable, `missingBriefs()` (`server/swarm.ts:6138`) never lists the card, so the CEO is never asked to write a current one.

The fix: for a PR decision, a brief comment posted before the decision's clock started is stale and is not used. The card then counts as missing a brief, and the existing `missingBriefs` → CEO `write_brief` path produces a fresh one.

---

## 2. Tasks (in this order)

### Task 1 — `findBrief` can ignore comments older than a time

- `shared/brief.ts:114`: add an optional third parameter `since?: number | null` (ms). The comments type becomes `readonly { body: string; createdAt?: string }[]`. When `since` is a number, skip any comment whose `createdAt` parses to a time earlier than `since - BRIEF_STALE_SLACK_MS`. Export `BRIEF_STALE_SLACK_MS = 10 * 60_000` (a lead can post the brief a few seconds before the clock tick that records `firstSeen`). A comment with no or unparsable `createdAt` is kept (today's behaviour).
- The body fallback (`parseBrief(body)`) is unchanged, with or without `since`.
- With `since` absent or null, behaviour is exactly as today.
- Test: `shared/brief.test.ts`, new cases in `describe('findBrief')`: an old brief comment before `since` is skipped and the body (or null) is returned; a brief 5 minutes before `since` is kept; a brief after `since` is kept; the newest fresh brief wins over an older fresh one; no `since` keeps the current test passing unchanged.

### Task 2 — The decision clock uses the decision's start for PR cards

- `server/swarm.ts:6197`: call `findBrief(talk.body, talk.comments, d.kind === 'pr' ? d.firstSeen : null)`.
- Do NOT change the other `findBrief` calls: `server/swarm.ts:4666`, `4823`, `5205` (business-hold checks) and `6214` (stuck escalated cards, whose brief is the escalation itself).
- Do NOT change issue (`needs-input`) decisions.
- Test: in `server/decisionRoom.test.ts` or `server/decisionClock.test.ts` (whichever already drives `decisionTick` with a fake backend `discussion`): a held PR whose only brief comment is dated before the decision's `firstSeen` has no usable brief, appears in `missingBriefs`, and the phone alert is the `no-brief` kind; once a fresh brief comment (after `firstSeen`) exists, the card uses it.

### Task 3 — Release note

- `CHANGELOG.md`: a new `## Unreleased — 2026-11-25` section above the 11-23 one, with the item: "A PR's Decision room card never shows a brief written before its current decision started; the CEO writes a fresh one instead, so cards don't repeat facts that have since changed."

---

## 3. Constraints

- No database; office state is JSON. No new persisted fields.
- Surgical diffs; keep the code style and comment convention.
- Commit per task: `fix(decisions): ...`. End each commit message with `Co-Authored-By: Codex <noreply@openai.com>`.

## 4. Checks before declaring done

```bash
npx tsc --noEmit -p .
npx vitest run
npm run build
```
All must pass (`server/scale.test.ts` and `server/stateFile.test.ts` can flake under full-suite load; if one alone fails, re-run that file alone and note it). Paste the vitest summary line into the final log entry.

---

## 5. Questions and answers

### Questions from Codex
(none yet)

### Answers from Claude
(none yet)

---

## 6. Status log (Codex appends; Claude reads)

- 2026-11-25 — Claude: brief written at main `c703071`. Waiting for Codex.
- 2026-11-25 10:54 EST — Task 1: updated `shared/brief.ts` and `shared/brief.test.ts`; focused vitest 12/12 passed and `npx tsc --noEmit -p .` passed.
- 2026-11-25 10:55 EST — Task 2: updated `server/swarm.ts` and `server/decisionRoom.test.ts`; focused vitest 4/4 passed and `npx tsc --noEmit -p .` passed.
