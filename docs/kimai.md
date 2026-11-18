# Time tracking in Kimai

The office can log agents' working time to [Kimai](https://www.kimai.org/) (2.x): each finished task becomes one
timesheet, tagged `ai-agent`, so agent hours sit next to people's and can be filtered out of an invoice or shown on
it as their own line. Only the office posts (`server/kimai.ts`); agents never see Kimai or its token.

It ships **off**. Start in **dry-run**, look over a day of entries, then switch to **live**.

## Before you switch it on

You need:

- the Kimai URL, e.g. `https://time.example.com`. When Kimai runs on the office's own machine, use its local
  address (e.g. `http://127.0.0.1:8080`), so the office doesn't depend on a VPN;
- an API token: in Kimai, your profile → **API access** → create a token (Kimai 2.x, sent as `Authorization: Bearer`);
- the Kimai **project** id for each floor (Customers → Projects; the id is in the project's URL);
- the **activity** ids for Build, QA, Fix and, if you log them, Planning (usually Development, QA, Rework, Planning);
- optionally, a Kimai **user** id per agent. Without one, entries go to the token's own user. Logging for other users
  needs that permission (`edit_other_timesheet`) for the token's user. To keep AI time apart from people's, create
  one Kimai user for the agents (nobody signs in as it) and map every agent to it. If teams limit a project, that
  user must be in the project's team, or Kimai refuses its timesheets.

Create the `ai-agent` tag in Kimai first: Kimai does not create a tag from an API call.

Give the office its own API token rather than one other tools share, so you can revoke it on its own.

## Settings → Time tracking

In the manager's console:

- **Mode**: Off (nothing is recorded), Dry-run (every entry is built and shown; no request is made), Live (posted).
- **Kimai URL** and **Time zone**: the Kimai user's IANA zone (e.g. `America/Chicago`); empty means the office
  server's. Begin and end are written in that zone, to the second.
- **API token**: write-only. It is saved in `<SWARM_HOME>/secrets.json` under `kimai` and never sent back: the page
  shows only **Set** or **Not set**. It never goes in the state file, the snapshot, events, the journal, the logs or
  agents' environments, and it's cut out of any error text.
- **Test connection**: asks Kimai for its version and who the token signs in as.
- **Floors → projects**, with **Billable** per floor (on by default) and **Don't log** for a floor whose tasks
  should log nothing, and a project for the CEO's office-wide jobs.
- **Work → activities**, and **Log the CEO's and floor leads' jobs as Planning** (off by default).
- **Shortest task logged**: tasks shorter than this (1 minute by default) log nothing.
- **Agents → Kimai users**.
- **Latest entries**: the last 50 with their status (Dry-run, Waiting, Sent with Kimai's id, Parked with the reason,
  Not logged). Click one to see exactly what is (or would be) posted. **Retry failed** puts parked entries back in
  line after you fix a mapping; they're rebuilt with the current mappings.

Over REST: `PUT`/`DELETE /api/kimai/token`, `POST /api/kimai/test`, `POST /api/kimai/retry`; the settings are
`kimai` in `PATCH /api/settings`.

## What an entry looks like

```json
{
  "begin": "2026-11-17T09:00:00",
  "end": "2026-11-17T09:45:00",
  "project": 11,
  "activity": 21,
  "description": "[Build] Ada · acme/shop #12 / PR #34 · Add a cart · 45m actual · claude-opus-5-5 via claude",
  "tags": "ai-agent",
  "billable": false,
  "user": 4
}
```

`begin` and `end` are local times with no offset; Kimai adds the user's. `tags` is a comma-separated string (an
array is refused). Only `ai-agent` is sent: the kind of work leads the description, since one activity may hold
every kind, and the model and CLI follow it. Send `user` whenever the token belongs to an admin, or the time goes
to the admin.

## How hours are measured

- A task's hours are its session's wall-clock time, start to end. Idle agents log nothing; agents working in parallel
  each log their own time.
- A wait on Claude's usage limit inside a session isn't working time: the entry is split around it.
- The office doesn't round: Kimai's own rounding rules apply. Kimai may round each duration up (e.g. to the next
  30 minutes), so its totals can be higher than the agents' real time. The real minutes are in each description
  ("45m actual").
- A session an office restart or update cut off is logged once, ending when the office last saved its state, with
  "(cut off by an office restart)" in its description. When that end isn't known it is listed as **Not logged**.
  A CLI that kept working through the restart is logged when it finishes, as usual.
- Each session is logged once, by its agent and start time, across restarts. A post that went out just before the
  office stopped is looked up in Kimai (same start and description) before it's sent again.

## Sending

Entries wait in an outbox in the state file and go out one at a time. Network errors, timeouts and 5xx are retried
with backoff (30 s, doubling, at most an hour), up to 8 tries. A 4xx (usually a bad mapping or a missing permission)
parks the entry with Kimai's reason. A floor with no project parks its entries with "No Kimai project for <repo>" and
sends nothing.

The demo office starts in dry-run with made-up ids and never touches the network; in live mode its fake Kimai hands
out ids and logs each "post".

## Not covered

Back-filling past tasks (a script could read them from the office journal), Kimai invoices and rates, creating
customers or projects, and Kimai's old `X-AUTH-USER`/`X-AUTH-TOKEN` login (instances older than 2.x).
