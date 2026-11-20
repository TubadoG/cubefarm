# The decision connector

Answer Decision room cards by voice. A small MCP server on Azure (the connector, a separate repo) is added to Claude as
a custom connector: Claude reads each open card aloud and calls a tool only after you say yes. The connector never
touches GitHub or the office; it only keeps a snapshot of the open cards and a queue of your answers in an Azure
table. The office reads that table (outbound HTTPS, nothing comes in), re-checks every answer and applies it through
the same code as the Room's buttons (`server/decisionConnector.ts`).

It ships **off**.

## What it can do

Three tools, nothing else:

| Tool | What the office does |
| --- | --- |
| `approve_recommendation` | the Room's **Approve recommendation** |
| `choose_option` | the Room's **Option N**, picked by the option's text |
| `retry_qa` | the Room's **Send to QA** on a PR card, plus a comment on the PR: "Retry QA requested by … via the connector." |

On an issue an answer unblocks it (`needs-input` → `decided:manager`); on a PR, a choice to merge as it is merges it
and any other choice sends it back to a developer with the choice as the note, exactly as `answerPlan` does in the
Room. The snapshot tells Claude what approving and each option will do (merge, send back with this note, or unblock)
before you choose, computed by that same `answerPlan`, and lists the office's last 20 results, newest first, so an
answer whose card closed still shows what happened. **Hold**, **Merge in order**, **Close** and
**Send back** with your own note stay in the Room; an answer row asking for anything else is refused.

The GitHub comment is the Room's `Decision: …`, signed "Answered by <you> via the cubefarm decision connector."

## What the office refuses

Every answer is checked again when the office picks it up. It is refused, never applied, when:

- it is older than **30 minutes** at pick-up;
- the PR's head on GitHub isn't the head SHA the answer was given on (or the answer names none);
- the card was already answered, in the Room or through the connector. One answer per card at a time: a second one
  while the first is being applied gets "already answered" (this protects double taps in the Room too);
- it was asked while the connector was switched off, or during quiet hours;
- the card no longer waits for a decision, or has no such option.

Refused answers are audited and get a receipt like applied ones, and the reason shows on the card in Claude.

## When the office checks

- **Off**: nothing. Switching off writes `enabled: false` to the snapshot once, so Claude says "the connector is off".
- **Quiet hours**, midnight to 5 am Eastern (EST or EDT, whichever is in force): no push, no poll. Claude answers
  "decisions are paused overnight" from its own clock; an answer asked in quiet hours is refused when picked up.
- **On**: every 5 minutes with no open decisions, every 30 seconds with some, every 3 seconds while you're talking
  to Claude (the connector's "session active" row is under 10 minutes old), then back to 30 seconds.
- The snapshot is written only when it changes (the open cards, a head SHA or a new result), plus a heartbeat every hour,
  so Claude can say "the office hasn't checked in since …" if the office is down.

## Receipts

After each applied or refused answer (and each Retry QA) the office emails you a receipt from its own sender:

```text
Subject: Decision recorded: owner/repo #12, merged

<card title>

Choice: approved the recommendation: Merge it as it is.
What the office did: merged
Head SHA: abc1234…
Asked: 2026-11-20 20:28 UTC (Nov 20, 3:28 PM Eastern)
Applied: 2026-11-20 20:28 UTC (Nov 20, 3:28 PM Eastern)
Via: connector (answer 6f1c…)
```

They go to the first of **Your addresses** in Settings → Email (else the copy-to address), from the From address, and
need the email sender set up. They have their own cap (**Receipt emails per day**, default 30, a rolling 24 hours),
apart from the CEO's daily email cap, and never appear in the CEO's outbox. One receipt per answer, ever. Replies to
a receipt are never read: the inbox drops anything whose subject is a receipt's, even from you.

## Set it up

The Azure half (resource group `rg-bc-decision-connector`, the storage account and its four tables, the container
app) is built and run from its own repo. For the office:

1. **Table endpoint**: Settings → Decision connector → `https://<account>.table.core.windows.net` (the storage
   account's table endpoint, nothing after it).
2. **SAS token**: Marcus reads it from Key Vault `kv-bcc-comms`, secret `decision-connector-office-sas`, and pastes it
   into **SAS token** → Save. It is a table SAS scoped to the four tables (query, add, update), valid a year. It is
   write-only: saved in `<SWARM_HOME>/secrets.json` under `decisionConnector`, never sent back (the page shows only
   **Set**), never in the state file, the snapshot, events, the journal, logs or agents' environments, and cut out of
   any error text. To rotate it, generate a new SAS, paste it here, done.
3. Switch it **On**. The office writes the first snapshot within seconds; **Check now** runs a check at once.

The status shows the last push, heartbeat and poll, the last error, and the last 24 hours' answers (picked up,
applied, refused) and receipts, with the latest answers and their receipts.

## What goes where

All calls are outbound HTTPS from the office to Azure Table storage, signed by the SAS token in the query string;
nothing listens for the connector, and the office's web server stays on 127.0.0.1. The calls:

| Call | When |
| --- | --- |
| `GET session(PartitionKey='session',RowKey='active')` | every poll: is a voice session active |
| `GET answers()?$filter=PartitionKey eq 'answer' and status eq 'queued'` | every poll (and once after a start, `status eq 'picked'`) |
| `MERGE answers(…)` with `If-Match` | picking an answer (`status: picked`), then its result (`applied` / `refused`, `resultAt`, `detail`) |
| `PUT snapshot(PartitionKey='office',RowKey='current')` | a changed snapshot (or the one `enabled: false`) |
| `MERGE snapshot(…)` | the hourly heartbeat (`heartbeatAt`) |

The tables and their fields are the contract between the two halves (`contract.md` in the connector's brief).

## The audit

Every answer the office applies or refuses, from the Room or the connector, is a JSON line in
`<SWARM_HOME>/decision-audit.jsonl`: `via` (`room` or `connector`), the tool or choice, repo, number, the result and
why, and for the connector its answer id, when it was asked and applied, who asked (the Entra object id) and the
expected and actual head SHA. No brief text and no secrets.
