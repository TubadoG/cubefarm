# Codex brief — an approval never fails on a merge conflict

Repo: `/Users/BClayton/Code/cubefarm` (Node/TypeScript office server + React UI, vitest). Base: `main` at `35662a1` or later.
Branch for this work: `fix/approve-conflicts` (create from `main`). Do not push to `main`; Claude reviews and merges.
Owner: Claude (Marcus), on behalf of Bryan Clayton. Executor: Codex.

---

## 0. How we work in this file (message board)

This file is the only channel between Codex and Claude. Both agents read and write it.

- **Codex:** read the whole file before starting. After each task, append an entry to section 6 (status log): timestamp, task number, files changed, test result. For a question or blocker, append it to section 5 under **Questions from Codex**, save, and continue with any task that does not depend on the answer. Re-read this file before each new task; Claude's answers land under **Answers from Claude**.
- **Claude:** checks this file every 5 minutes, answers in section 5, never edits Codex's section 6 entries.
- **Done:** when every task is complete and the checks in section 4 pass, append a final log entry that contains the exact line `ALL TASKS COMPLETE`.
- Keep entries to one to three lines.

---

## 1. Why: what was reported and what the code does today

On 2026-11-22 Bryan approved regn PRs #79 and #80 in the Decision room; neither merged. The office log (journalctl, 22:28 UTC) shows: `CommandError: gh pr merge 79 failed: X Pull request BC-Consulting-Group/regn-uat-platform#79 is not mergeable: the merge commit cannot be cleanly created.` Both PRs were cards with reason `stuck` (QA record status `needs-human`), and both had become CONFLICTING with main while they waited. Bryan asked that he only gets asked about PRs that can merge, and that an approval never "fails".

Root cause:
- `server/swarm.ts` `answerDecision` (about line 6270-6300): for a PR whose plan is merge it calls `this.mergePull(repo.id, number)` directly (`else if (plan.pr?.do === 'merge') await this.mergePull(repo.id, number);`).
- `mergePull` (about line 2123) calls `this.backend.mergePull(...)` with no mergeability check, so GitHub's refusal surfaces as an error and the approval is lost (the card is already marked answered by `this.answered(...)`).
- The auto-merge gate already does the right thing for QA-passed PRs: `server/mergeGate.ts` `mergeStep` sends a CONFLICTING/DIRTY PR back as a conflict fix, updates a BEHIND branch, waits for pending checks; `advanceMerge` (swarm.ts about 1792) runs every step except the merge itself for held PRs ("its conflicts go back to a developer ... so it can be merged the moment the manager approves it"). The Decision room answer path bypasses all of that.
- `openDecisions()` (swarm.ts, `private openDecisions`) lists every escalated `needs-human` PR as a `stuck` card even while the PR is CONFLICTING, so Bryan is asked to approve something GitHub cannot merge.

Not a bug: held (passed) PRs that conflict are already sent back by advanceMerge; the fix below reuses that path.

---

## 2. Tasks (in this order)

### Task 1 — Approving a PR merges through the gate, never straight to GitHub

- New pure helper (in `server/mergeGate.ts` or a new `server/approveMerge.ts`, your choice): `approvedMergeStep(pr: MergePull): { do: 'merge' } | { do: 'conflict' } | { do: 'update-branch' } | { do: 'wait-checks' } | { do: 'checks-failing' } | { do: 'details' }`. CONFLICTING or DIRTY → conflict; UNKNOWN → details (caller asks `prDetails` and decides again, treating a second UNKNOWN as wait-checks); BEHIND → update-branch; checks pending → wait-checks; checks failing → checks-failing; else merge.
- `answerDecision` merge branch: fetch fresh `prDetails` and apply the helper instead of calling `mergePull` blindly.
  - merge: call `mergePull` as today.
  - conflict / update-branch / wait-checks: record the approval on the PR's QA record (new optional field `approvedSha: string | null` = the PR head SHA Bryan approved, plus `approvedAt`), make sure the record is in the merge line (status `passed`, `heldFor` cleared, `passedSha` kept or set to the approved head), and let `advanceMerges` finish it: a conflict goes back to a developer through the existing conflict-fix path (`sendBack(repo, rec, 'conflict', ...)` / `fixReason: 'conflict'`, which already returns the PR to "back in line to merge" with `passedSha` set, see `server/fixOutcome.ts` around line 81), a BEHIND branch is updated, pending checks are waited for. If there is no QA record for the PR, create the minimal record the merge gate needs, following how existing code creates QA records (ask in section 5 if unclear).
  - checks-failing: do not merge; same as conflict but with reason `checks` (existing re-run / send-back path).
- `holdFor` / `advanceMerge`: a record with `approvedSha` is not held. After a conflict fix the head SHA changes; the approval still counts when the new commits are only the conflict resolution, i.e. when the record went through the `fixReason: 'conflict'` path with `passedSha` kept (that path already puts it "back in line to merge" without a new QA round). If new commits arrive for any other reason (requeue to QA), clear `approvedSha` so the card comes back.
- The answer still returns `{ ok: true, answer }`; the office message and the answer text say what happens, for example: `🧭 Decision on PR #79 on <repo>: you approved it. It conflicts with main, so a developer resolves that first; it merges by itself once the checks are green.` Keep the existing message shape for a clean merge.
- If the merge itself still fails at GitHub (race), do not throw away the approval: keep `approvedSha`, set `mergeRetryAt` as `advanceMerge` does, and let the gate retry.
- Do NOT change: send-back and close answers; the decision clock's own default-apply rule in `server/decisionClock.ts` (it already skips CONFLICTING at line ~140); `MAX_MERGE_FIXES`; people's own (non `swarm/`) PRs stay theirs to merge, so for a non-swarm PR keep today's direct `mergePull` behaviour.
- Tests: unit tests for the helper (each state); an answerDecision test in the style of `server/decisionRoom.test.ts` (or the closest existing test of answerDecision) with a fake backend: CONFLICTING PR → no `mergePull` call, record has `approvedSha`, a conflict fix is queued; clean PR → `mergePull` called once; BEHIND → `updateBranch` called, no merge yet; after a conflict-fix outcome the record merges without a new card.

### Task 2 — Bryan is not asked about a PR that cannot merge

- `openDecisions()`: a PR card (reasons `held` and `stuck`) is left out while its PR is CONFLICTING or DIRTY (use `rt.pulls` data; UNKNOWN counts as mergeable so cards are not hidden by GitHub's lazy answer).
- For a `stuck` (needs-human) PR that is CONFLICTING: send it to a developer as a conflict fix (reuse the existing send-back with `fixReason: 'conflict'`), at most once per head SHA, respecting `MAX_MERGE_FIXES`. Held passed PRs already get this from `advanceMerge`; do not double-send.
- When the conflict is resolved and the PR is back (passed and held, or needs-human again), the card reappears as today; its decision deadline restarts from when it reappears (check how `decisionDeadline` / `this.state.decisions` handles a card that disappears; if a card that leaves and returns would keep an old, already-passed deadline, restart it, and ask in section 5 if the right rule is unclear).
- Do NOT change the decision clock's default-apply rules or the deadlines for cards that never left.
- Tests: openDecisions excludes a CONFLICTING held PR and a CONFLICTING stuck PR; includes them again when MERGEABLE; a CONFLICTING stuck PR triggers exactly one conflict send-back per head SHA.

### Task 3 — Release note

- Add a release note entry in the style of the newest one (find where the office keeps its release notes / changelog; if there is none, add a short section to `CHANGELOG.md` or `docs/` and say where in the log): "Approvals never fail on a merge conflict: an approved PR that conflicts with main goes to a developer first and merges by itself once clean; the Decision room only shows PRs that can merge."
- Demo script (in the final log entry): approve a held PR whose branch conflicts with main in demo mode (`npm run demo`, demo.ts already creates conflicts at random); see the office message, the PR go to a developer, and merge without a second card.

---

## 3. Constraints

- No state migration beyond new optional fields on the QA record (load old state without them; see how `stuckWhy: q.stuckWhy ?? null` is loaded around swarm.ts line 843).
- Never touch the real office state (`~/.cubefarm/state.json`), the real GitHub repos, or any network service. Tests use fakes.
- Keep the existing code style and the long explanatory comment convention. Surgical diffs; no reformatting.
- Commit per task on the branch: `fix(decisions): …`. End each commit message with `Co-Authored-By: Codex <noreply@openai.com>`.

## 4. Checks before declaring done

```bash
npm run typecheck
npx vitest run
npm run build
```
All must pass. Paste the vitest summary line into the final log entry.

---

## 5. Questions and answers

### Questions from Codex

### Answers from Claude

---

## 6. Status log (Codex appends; Claude reads)

- 2026-11-22 — Claude: brief written at main `35662a1`. Waiting for Codex.

- 2026-11-22 23:04 UTC — Task 1 complete: server/{swarm,mergeGate,fixOutcome}.ts and their tests plus approveDecision.test.ts; approvals survive conflict fixes/merge races, unrelated commits clear approval. Typecheck passed; targeted vitest: Test Files 4 passed (4), Tests 74 passed (74).

- 2026-11-22 23:06 UTC — Task 2 complete: server/swarm.ts and server/approveDecision.test.ts; hide conflicting cards, send stuck swarm heads for one budgeted conflict fix, restart returning unanswered clocks while preserving already-applied defaults. Typecheck passed; targeted vitest: Test Files 4 passed (4), Tests 63 passed (63).
