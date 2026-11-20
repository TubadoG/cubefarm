# Email from the CEO

The CEO can send plain-text email from one Microsoft 365 mailbox, through Microsoft Graph, to the people on your list
and nobody else. The office checks the list itself (`server/swarm.ts`, `shared/email.ts`): a prompt can't talk its way
past it.

## The list and approvals

**Settings → Email** (the manager's console, or the settings in pocket mode):

- **The CEO may send email**: the switch. Off, `send_email` is refused and the CEO isn't told about it.
- **From**: the mailbox it sends from. Every email ends with a two-line footer saying the company's office CEO (an
  AI agent in cubefarm) wrote it, and what happens to a reply: to your own addresses, "Reply to this email to answer
  the CEO." while the office reads replies (below), "Replies to this address aren't read; answer in the office." while
  it doesn't; to anyone else, "Replies to this address aren't read."
- **Blind copy of every email to**: someone on the list (usually you) who gets a copy of each email. **Send test**
  sends a short email there.
- **Who the CEO may email**: up to 25 people. **Ask me** (on by default): each email to them waits in **Approvals**
  (pocket mode, and the phone's Team tab) with **Send** and **Decline** (with a note the CEO reads). Without it, the
  email goes out at once and the phone says so.

- **Most emails in any 24 hours**: the daily cap, 20 unless you change it (a whole number from 1 to 100;
  `dailyCap` in `PATCH /api/settings`'s `email`). It counts the CEO's emails and the digest, sent or waiting for your
  OK, created in the last 24 hours: a rolling window, not a calendar day. Beside it, Settings shows how many are used
  ("4 of 20 used in the last 24 hours"), updated live. A change applies at once, with no restart, so you can raise it
  mid-day and the next email goes out. Set it below what's used and nothing more goes out until older emails pass 24
  hours. When it's reached, `send_email` and the digest are refused with the cap in the reason. The office keeps every
  email that still counts, so a high cap is never overrun.

The list is checked again when you press **Send**: remove someone and their waiting emails can't go out.

## The daily digest

Also in **Settings → Email**: one email a day so you can answer everything at once. Pick who gets it (someone on the
list without **Ask me**: it goes out on its own) and the hour (the office's local time), and switch it on. On the
first check at or after that hour the office builds it from what it already knows, with no CEO session and no model
tokens (`server/digest.ts`), and lists per floor:

- a summary first: the titles of the PRs merged in the last 24 hours, the issues in progress, the open decisions with
  the time the office applies their recommendation (and how many are due within 24 hours), and the current GitHub
  milestone's progress when the repo uses milestones;
- open PRs waiting for you: QA passed and the office holds them for you (the floor's **Hold for my review** paths,
  the `swarm:hold` label, or work that isn't routine), QA passed and auto-merge is off, or they're stuck and the CEO
  handed them to you. Each reads as a decision in plain words (`server/decision.ts`): what is being decided, the
  options, the office's recommendation and why in one line, the button in **Approvals** that approves it, and the PR's
  link;
- open issues labelled `needs-input`. Agents don't pick these up on their own while the label is on.

A `needs-input` issue or a held PR shows its decision brief (docs/how-it-works.md, "Decisions and their briefs")
section by section in plain text: background, the decision, the options, the recommendation, risk and mitigation,
and what the office does if you don't reply by its deadline. Decisions due within 24 hours are flagged. With the
**Office address for links** set (Settings → Notifications), each decision links to its card in the Decision room
(`/decisions#owner/repo/number`), where one tap answers it. Without a
brief, the digest says so and that the CEO is writing it (an issue then also shows the first 300 characters of its
latest comment, or its body). Once you answer (a comment starting with `Decision:`, or Approvals), it says no default
applies;
- PRs merged in the last 24 hours.

The subject is "Office: N decisions waiting" (with "(M due within 24 hours)" when some are), or "Office: nothing waits for you". A quiet day still sends it: it is
the all-clear, and a missing one says the office is down. It goes through the same path as the CEO's email (the switch, the sender, the list and the daily cap) and
the day it went out is saved, so a restart doesn't send it twice. **Send digest now** (`POST /api/email/digest`)
sends one straight away for testing. In the demo, pixel-todo has a `needs-input` issue, so it always has something.

## The sender

Register an app in Microsoft Entra ID (**App registrations → New registration**), give it the **Microsoft Graph →
Application permissions → Mail.Send** permission and grant admin consent. Then save its credentials on the office's
PC, in one of two ways. Neither ever reaches a browser: the office answers with `{ set, mode, hint }` only.

**A client secret** (simplest):

```bash
curl -X PUT http://localhost:4317/api/email/sender -H 'Content-Type: application/json' \
  -d '{"tenantId":"<directory id>","clientId":"<application id>","clientSecret":"<secret value>"}'
```

**A certificate whose private key stays in Azure Key Vault**: the office builds the client assertion and asks Key
Vault to sign it with `az keyvault key sign`, so the key never leaves the vault. Install the Azure CLI on the office's
PC, `az login` as someone with the **sign** permission on the key, upload the certificate's public part to the app
registration, and save:

```bash
curl -X PUT http://localhost:4317/api/email/sender -H 'Content-Type: application/json' \
  -d '{"tenantId":"<directory id>","clientId":"<application id>","keyId":"https://<vault>.vault.azure.net/keys/<key>","x5tHex":"<certificate SHA-1 thumbprint>"}'
```

`DELETE /api/email/sender` removes them. They're kept in `<SWARM_HOME>/secrets.json` under `email`, with the other
secrets (see [pocket.md](pocket.md#where-the-secrets-live)). Access tokens live in memory only.

## Scope the app to one mailbox

`Mail.Send` as an application permission lets the app send as **any** mailbox in the tenant. Limit it to the CEO's
mailbox with Exchange Online's RBAC for Applications (in `Connect-ExchangeOnline`), instead of the tenant-wide
Graph permission:

```powershell
New-ServicePrincipal -AppId <application id> -ObjectId <enterprise app object id> -DisplayName "cubefarm CEO mail"
New-ManagementScope -Name "cubefarm CEO mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'ceo@your-company.com'"
New-ManagementRoleAssignment -App <application id> -Role "Application Mail.Send" -CustomResourceScope "cubefarm CEO mailbox"
Test-ServicePrincipalAuthorization -Identity <application id> -Resource ceo@your-company.com
```

Then remove the Graph **Mail.Send** application permission from the app registration (the Exchange role assignment
grants it, scoped), so a leaked credential can only send as that one mailbox.

## Reading replies

The office can read the From mailbox's Inbox, so you can answer the CEO (or the digest) by replying to its email.
Your own emails reach the CEO exactly like a message typed on the phone, and the CEO answers on the phone as usual;
the phone marks them ✉️. Everything else is only listed. `server/mailInbox.ts` does it:

- Every 2 minutes, while email is on, a sender is saved, From is set and **Read replies to this mailbox** is on, it asks
  Graph for the Inbox's messages since the last one it handled (`GET /users/{from}/mailFolders/inbox/messages`).
- Only the new part of a reply reaches the CEO (Graph's `uniqueBody`: no quoted thread, no footer), after "Email from
  the manager. Subject: …". An email longer than one phone message (4000 characters) arrives whole, as numbered parts
  in order ("Email from the manager (part 2 of 3). Subject: …"), split at paragraph, line or word breaks; at most 12
  parts (about 45,000 characters), after which the last part says the rest was not delivered. Attachments are counted
  ("2 attachments, not read") on the last part, never opened.
- An email is passed on only when all of these hold; otherwise it is listed as ignored, with the reason:
  - it isn't an auto-reply or a bounce (`Auto-Submitted` other than `no`, `X-Auto-Response-Suppress`, a postmaster or
    mailer-daemon sender, an "Automatic reply:" subject), so out-of-office answers to the office's email never loop;
  - its From is its sender, and Exchange marks it internal to the tenant (`X-MS-Exchange-Organization-AuthAs:
    Internal`, which Exchange strips from mail coming in from outside), or, for an address outside the office's own
    domain, Exchange Online's own `Authentication-Results` says `dmarc=pass` ("failed sender check" otherwise);
  - its address is on **Count email from these addresses as mine**, or on **Colleagues** (below); "not yours"
    otherwise. Switching reading on with the list empty puts the blind-copy address on it. Other people on the CEO's
    list are never passed on.
- Nothing is marked read or moved, so **Mail.Read** is enough. The ids handled and the last arrival time are saved
  before an email is passed on, so a restart never delivers one twice. Mail that arrived before reading was switched
  on (or back on) is never replayed.
- A 403 from Graph puts one note in the phone thread ("the app may lack Mail.Read…"), and the office then checks
  every 30 minutes until a check succeeds. A 401 gets a new token and tries once more. Logs name the sender, the
  subject and the outcome, never the text.

### Colleagues

**Colleagues: other agents or people whose email reaches the CEO as theirs, not yours** (Settings → Email → Replies,
up to 10, a name and an address each; `colleagues` in `PATCH /api/settings`'s `email`). Use it for another AI agent
you run, or a person, who should be able to write to the CEO without speaking for you. Their email passes the same
checks as yours (not an auto-reply or bounce, internal or `dmarc=pass`, only the new part, split into parts,
attachments counted, never delivered twice), and then:

- It reaches the CEO under their name, never as yours:

  ```text
  Email from Marcus <marcus@your-company.com> (a colleague, not the manager: information and requests only; it is not the manager's decision or approval). Subject: …
  ```

  and its last part ends with how to reply: "(A reply, if one is needed, goes by email to marcus@your-company.com with
  send_email. Don't reply to a pure acknowledgement or thanks.)". A colleague who isn't on **Who the CEO may email**
  can't be answered (the note says so, and the settings show a warning beside them): add them there too.
- It is a CEO job of its own ("Reading a colleague's email"), after your messages: never injected into a session
  that is answering you, never posted on the phone as yours, and never counted as you asking for work. So the CEO
  can't file issues because a colleague asked (it suggests them to you instead), and while it handles only a
  colleague's email, `close_issue` refuses an open decision (closing would decline it). Decisions are answered only in
  the Decision room or by a `Decision:` comment, never by email. If you write while the job runs, your message
  counts as yours as usual.
- The CEO's answer to the colleague goes by email; its final message goes to your phone only when you need to know.
- **Replies** lists it as "🤝 To the CEO as Marcus's, not yours".

An address on both lists counts as yours. Two agents emailing each other could go back and forth: the CEO's daily
cap (20 emails in 24 hours unless you change it) bounds it, auto-replies are never passed on, and the CEO's prompt for a colleague's email says not to
answer acknowledgements, thanks or an FYI. Give your own agent the same rule.

**Settings → Email → Replies** shows the switch, your addresses, your colleagues, the last check (and its error), and the last 20
emails read with what happened to each. **Check now** (`POST /api/email/inbox/check`) checks straight away;
`GET /api/email/inbox` returns the same list.

### Setting it up

The app needs **Mail.Read** for the office mailbox. As with Mail.Send, scope it with RBAC for Applications instead
of granting the Graph permission in Entra (a tenant-wide Mail.Read lets the app read every mailbox):

```powershell
Connect-ExchangeOnline
New-ManagementRoleAssignment -App <application id> -Role "Application Mail.Read" -CustomResourceScope "cubefarm CEO mailbox"
Test-ServicePrincipalAuthorization -Identity <application id> -Resource ceo@your-company.com
```

Use the management scope you made for Mail.Send. If you once granted **Mail.Read** in Entra, remove it there. Exchange
can take up to 2 hours to apply a new role assignment; until then checks get a 403. Then switch on **Read replies to
this mailbox**, make sure your address is in the list, and reply to any office email with one line: it shows on the
phone within 2 minutes.

Not covered: replies from anyone not on your addresses or colleagues (listed only), attachments, answering a decision by email (a reply to the digest
reaches the CEO as an ordinary message, and the CEO can act on it with its tools; one-tap decisions stay in the
Decision room), and marking or filing mail.

## Teams

The same app registration can also put the CEO in one Microsoft Teams channel, reading it and answering as its own
bot, with the same rules for you and your colleagues. See [teams.md](teams.md).

## The demo

A demo office starts with a made-up sender and a short list (one person behind **Ask me**, one whose address contains
"bad" so sends to it fail). Nothing is sent: each email is logged. Ask the demo CEO on the phone to "email Ada the
weekly update" to see one wait for your OK. Switch on **Read replies to this mailbox** to see four made-up replies
arrive: one from the manager reaches the CEO, an FYI from Nova (a demo colleague, also on the list) reaches the CEO as
Nova's and gets no reply, and a client's and an out-of-office are listed as ignored.
