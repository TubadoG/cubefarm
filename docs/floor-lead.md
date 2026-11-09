# The floor lead

The floor runs around the clock and waits for the manager only when the input is critical: a business decision
(scope, product behaviour, spend, naming, licensing, credentials). Technical and code-quality problems are the office's
job, never the manager's. The floor lead is the standing employee who owns that on each floor.

There is no GitHub issue for this work (issues are off on this fork), so this file is the issue: the approved design,
with the owner's decisions, and what each pull request builds.

## The owner's decisions (binding)

1. **Staffing.** One standing floor lead per floor, **extra** to the floor's team size (not a builder seat). A floor
   setting (🧭 Floor lead in the manager's console) turns it off; default on.
2. **Wake.** On events (a PR becomes needs-human or stuck; the ready backlog drops below the floor's `minReady`) plus a
   board clean-up every 4 hours. A cheap model and effort for clean-ups, a strong one for stuck-PR diagnosis, chosen the
   way the CEO's are (the lead's own model on its card wins for diagnosis), both configurable (Settings → Floor leads).
3. **Triage moves from the CEO to the lead.** The CEO keeps company-level work. The lead's tools: retry QA, send back
   with a note, re-run checks, close, rebuild, escalate (business only), write a decision brief, plus board tools: merge
   duplicate issues, close stale issues with a note, relabel, reorder the backlog, split an oversize issue, set
   dependencies. The rebuild (`server/rebuild.ts`) stays as the safety net when the lead's tries are used up or it is
   off.
4. **Limits the code enforces** (not just prompt text):
   - never merge or close a business-held PR (`swarm:hold`, the floor's hold paths, a decision brief);
   - never message the manager directly: only an escalation's decision brief reaches them, through the Decision room;
   - never create new scope: it may split, merge and order existing issues, and files an issue only for a split (or the
     office files one for a rebuild);
   - never push to main or force-push;
   - escalate = business only: escalate must carry a decision brief that `shared/brief.ts` parses with no gaps, or it is
     refused.
5. **Every board change is logged.** The Monday digest (`server/digest.ts`) lists last week's board changes, each with
   an undo action in the office: reopen a closed issue; unmerge (reopen the duplicate and remove the note); relabel
   back; restore the order; close the split-off issues. No approval needed.
6. **Fix the non-business waits** below. Only `swarm:hold`, hold paths and decision briefs remain business holds.
   Item 9 (the manager stopped a QA session) stays as it is.

## How it works

- **The lead.** An agent with role `lead` on its floor, at the highest free desk (the team fills desks from the lowest
  up). It is not counted in the team size, never gets issues, QA or fixes, can't be let go (turn the floor setting off
  instead) and has no career on the team. On a full 15-desk floor a hire takes the lead's desk; the lead sits down again
  once one frees up, and the rebuild covers the floor meanwhile.
- **Its sessions.** Claude Code, like the CEO's, with the floor's clone read-only and its own notes folder
  (`<SWARM_HOME>/leads/<repo>/NOTES.md`). Its tools are its own MCP server (`server/lead.ts` `createLeadTools`) for its
  own floor only: there is no merge, file-issue, email or chat tool, and Bash/PowerShell are disallowed, so it can't run
  git at all. Its final message goes to its log, not the manager's phone.
- **Stuck PRs.** `swarm.ts stuck()` → `lead.ts stuckStep`: the lead triages (at most `MAX_TRIAGES` per PR), else the
  office gives up on it (`giveUp`). A lead job that ends without moving the PR also gives up. Giving up rebuilds the PR
  unless it has a business hold (`rebuild.ts businessHold`), with the existing loop guard (a rebuild stuck again goes to
  the manager with a park brief). A scheduler pass (`stuckTick`) reroutes any stuck PR that nobody handles (after a
  restart, or a lead turned off) and retries rebuilds GitHub refused.
- **Escalate.** `lead.ts escalationBrief` parses the brief; no brief, a section left empty or a single option is
  refused with what is missing. A complete brief is posted on the PR and shows on its Decision room card.

## The non-business waits

| # | Wait | Where it was | What happens now | PR |
| --- | --- | --- | --- | --- |
| 1 | A PR closed by a person leaves its issue ⏸ for the manager | `closeCleanup.ts` `toHold` | The lead decides (put it back in line, or close it as stale); without a lead it goes back in line after a day. A PR closed by a park brief stays parked (a decision brief). | B |
| 2 | An issue that failed two sessions is skipped until assigned by hand | `MAX_ISSUE_FAILURES` in `swarm.ts` | The lead looks at it (split it, add a note and release it, or close it); without a lead it is retried after a cool-down. | B |
| 3 | A frozen terminal a second time leaves the issue for the manager | `swarm.ts onStuck` | As 2: the issue's failures go through the lead or the cool-down. | B |
| 4 | Agents in error for over 10 minutes raise an alarm for the manager | `metrics.ts ALARM_ERROR_MS` | The office clears the desk itself (the Clear desk action) before the alarm would fire. | B |
| 5 | A stuck PR with no known reason goes to the manager without a brief | `rebuild.ts giveUpStep` | Rebuilt like any technical problem; only a business hold escalates. | A |
| 6 | "Not routine" counts as a business hold for the rebuild decision | `rebuild.ts businessHold` | Ignored for the rebuild decision: size, dependencies and CI are not business calls. It still keeps the PR from merging itself on a routine-only floor. | A |
| 7 | A rebuild GitHub refused escalates | `swarm.ts giveUp` | Tried again every 30 minutes (`REBUILD_RETRY_MS`). | A |
| 8 | Escalate has no business check | the CEO's `escalate` tool | Escalate is the lead's only, and refused without a complete decision brief. The CEO has no triage tools any more. | A |
| 9 | The manager stopped a QA session | `swarm.ts` | Unchanged: the manager's own action. | – |

## Split across two pull requests

- **A** (`feat/floor-lead`): the lead role and seat, its sessions and models, the triage handover from the CEO, the
  enforced limits (business holds, escalate with a brief, no shell, no merge/file/message tools), and waits 5 to 8.
- **B** (`feat/floor-lead-board`, based on A): the board wakes (backlog below `minReady`, the 4-hour clean-up), the board
  tools, the board-change log with undo for each change type, the Monday digest section, and waits 1 to 4.

## Original design notes

The incident that prompted it: on 21 Oct, PR #46 on the openRTSM floor passed testing, then other work kept landing in
the same generated file first, so it could never be added cleanly. It went back to a developer five times, the CEO
looked at it twice as a side job, and then the office handed it to the manager as "needs you", with a Retry QA button
that could not fix it. A purely technical problem reached the manager after about three weeks of churn, because
nobody on the floor owned the PR from start to finish. PR #14 (rebuild instead of escalate, buttons that follow the
office's pick) fixed the symptom; the floor lead gives the job a permanent owner.

Cost: one standing agent session per floor that sleeps when the floor is quiet and wakes on events, so the cost tracks
how busy the floor is. Part of it was already paid by the CEO's triage jobs, which moved to the lead.
