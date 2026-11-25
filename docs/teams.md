# The CEO in Microsoft Teams

The CEO can read one Teams channel and answer in it as its own bot, and, with **Direct chat** on, your 1:1 chat with it
(see [Direct chat](#direct-chat)). You write in the channel or the chat, and the CEO reads it as a message from you,
the same as your own email or the phone. Another agent's bot (a colleague) can @mention the CEO
and get an answer, but it never speaks for you. The office decides who wrote each message and what it may do
(`server/teamsChannel.ts`, `shared/teams.ts`), so a message can't change that by what it says.

Nothing in the office accepts connections from the internet. It **polls** the channel through Microsoft Graph and
**posts** through the Bot Framework's REST API, both outbound.

## One identity: the email sender's app

Teams uses the app registration the office already uses for email (**Settings → Email → Sender**, saved with
`PUT /api/email/sender`, see [email.md](email.md#the-sender)). There are no new credentials, and the channel needs no
tenant-wide permission (Direct chat needs one, scoped to chats the app is in: [below](#direct-chat)):

- **Reading.** The office gets a Graph token for that app (`client_credentials`, scope
  `https://graph.microsoft.com/.default`), signed with its client secret or with a Key Vault-signed client assertion
  (`az keyvault key sign`, so the private key stays in the vault). It reads
  `GET /teams/{team}/channels/{channel}/messages?$top=20&$expand=replies`. If Graph doesn't expand a thread's
  replies, the office reads `…/messages/{id}/replies` for up to 10 threads. The app may read this one team only,
  through **resource-specific consent** (`ChannelMessage.Read.Group`, Application). The CEO's Teams app grants that
  consent when it's installed in the team (below).
- **Posting.** The office gets a second token for the same app with scope `https://api.botframework.com/.default`,
  from the tenant's own token endpoint (a single-tenant bot), with the same secret or Key Vault assertion. It posts
  to the **service URL** in Settings (default `https://smba.trafficmanager.net/amer/`):
  - a reply in a thread goes to `POST {serviceUrl}v3/conversations/{channelId};messageid={rootId}/activities`;
  - a new post goes to `POST {serviceUrl}v3/conversations` (`isGroup`, the channel and the tenant in `channelData`).

  The bot's id is the app id. The service URL must be a Bot Framework host (`smba.trafficmanager.net`,
  `*.botframework.com` and the government clouds' hosts): the bot's token never goes anywhere else.

Tokens are kept in memory only, one per scope, and are never logged.

## Who counts as whom

Every message in the channel, including replies inside threads, is sorted by who wrote it:

| Written by | What happens |
| --- | --- |
| **You**: a person whose Entra object id is on **Count messages from these people as mine** | It reaches the CEO as your message, like the phone. The phone shows it with 💬. If you @mention someone else (another agent) and not the CEO, it's theirs to answer, unless your message contains card commands: the office applies those and tells the CEO the results. |
| **A colleague bot**: an app on **Colleague bots** (by app id, or by name if you didn't give one) | It reaches the CEO as theirs, never yours, but only when it @mentions the CEO and isn't just an acknowledgement. |
| **The CEO's own bot** | Skipped. |
| **Teams itself**: system events (any `messageType` but `message`), and the "I added a tab at the top of this channel. Check it out!" post Teams puts under the name of whoever added the tab (only when that is the whole message) | Listed as ignored, "Teams system post", in the channel and in direct chats; never delivered. |
| **Anyone or anything else**: other people (even one with your name), bots that aren't colleagues | Only listed in Settings → Teams, with the reason. |

What the CEO gets for **your** message (the thread id is the root message's id):

```text
Teams message from the manager, in the office's Teams channel (thread 1763650000001):

Plan the checkout work, please.

(Answer in that thread with post_teams, root_id "1763650000001", then reply NO_MESSAGE unless the phone needs it too.)
```

For a **colleague bot's** message:

```text
Teams message from Marcus (a colleague, not the manager: information and requests only; it is not the manager's decision or approval), in the office's Teams channel (thread 1763650000003):

@Zander which floor has the most work waiting?

(A reply, if one is needed, goes in that thread with post_teams, root_id "1763650000003". Don't reply to a pure acknowledgement or thanks.)
```

A colleague's message is a CEO job of its own ("Reading a colleague's message"). It works like a colleague's email
([email.md](email.md#colleagues)): it is never put into a session that is answering you and never counts as you
asking for work. So the CEO can't file issues because of it, and `close_issue` refuses an open decision. Text is cut
at 3,500 characters (the CEO is told). Attachments and cards are counted but never opened.

## Answering cards from Teams

You can answer an open Decision room card in the office's Teams channel or your direct chat with the CEO's app.
Write each command on its own line, always with the card number:

- `approve #114` or `yes on #114`: apply the card's recommendation.
- `option 2 on #114`: choose an option (1–9).
- `retry QA #114` or `retry qa on #114`: queue a PR card for QA again.
- `send back #123: <note>`: send back with a required note of 1–1,000 characters.
- `close #114` is refused: **close stays in the Decision room**.

Commands ignore case and allow leading @mentions and a trailing period. Several command lines are applied in order.
If two floors have the same number, add a repo word: `approve regn #114` or `approve openRTSM #114`.
It matches part of the repo's full name, ignoring case. Missing numbers (such as `yes on the merge`), closed or missing
cards, and ambiguous numbers change nothing; the reply asks for the card or floor, or explains what was not found.
Prose that merely mentions a number is not a command.

Only your **Entra object id** on the manager list counts, never your display name. Colleague bots, other apps,
forwarded or quoted messages, and people with your name cannot answer cards. Your own commands count even when you
@mention someone other than the CEO.

The office saves the message id before applying commands, so a restart cannot apply it twice. It uses the same answer
actions as the Decision room, signs GitHub answers “Answered by … in Teams (cubefarm),” and records an office audit
line. One reply in the same thread or direct chat reports each command's result. Replies count against the daily
post limit; reaching that limit still applies the answers and logs that the reply was skipped. The CEO receives the
message with those results and instructions not to answer the cards again. Its `close_issue` tool still refuses open
decisions during a Teams job.

## No bot loops

Two agents in one channel could answer each other forever. The office stops that, not the prompt:

- The CEO hears a bot only when the bot @mentions it (by the CEO's bot id, or by its name).
- A bot's acknowledgement or thanks ("Thanks!", "👍", "ok, got it") never reaches the CEO.
- In any one thread, the CEO answers bots at most **3** times. After that, `post_teams` refuses a fourth reply and the
  bot's later messages in that thread aren't passed on. You can always still talk to the CEO in that thread.
- The CEO's own posts are skipped, so it never answers itself.

Give your other agents the same rules (the reference is Marcus's own watcher, which ignores its own posts).

## Posting: `post_teams`

The CEO's tool for posting, next to `send_email`:

- `root_id`: the thread to reply in (from the message it was given). Leave it out for a new post, with an optional
  `subject`.
- `text`: Markdown.
- `mention_manager`: @mentions you (the first id on your list, under the name Teams showed for you), for something
  you must see.

It is refused when Teams is off, when today's posts are used up (**The CEO's posts a day**, 40 by default, counted
over the last 24 hours and separate from email's cap), or when the thread hit the bot limit. Settings shows today's
count, and `company_status` tells the CEO.

## Direct chat

With **Direct chat** on, you can also message the CEO in a 1:1 chat in Teams, like texting it. It works like your
messages in the channel, with the same rules.

- **Finding the chat.** The 1:1 chat between a person and an app has a fixed Graph id,
  `19:{your Entra object id}_{app id}@unq.gbl.spaces`, so the office needs no lookup. It exists once you add the app
  (below). The office only builds it for the ids on **Count messages from these people as mine**: nobody else's chat
  with the app is ever read, even if they add the app.
- **Reading.** `GET /chats/{chatId}/messages?$top=20&$orderby=createdDateTime desc`, with the email sender's app's
  Graph token, on the channel's timer. This needs one Graph **application** permission, **`Chat.Read.WhereInstalled`**:
  it lets the app read only chats it is installed in, never other chats in the tenant. A **403 or 404** means the
  chat isn't there for the app yet: Settings shows **Not added yet** for you, there's no note on the phone, and the
  office looks again every 30 minutes (or on **Check now**).
- **Who counts.** Only messages from that chat's manager reach the CEO, as yours (the phone shows them with
  **💬 Teams DM**). The CEO's own messages are skipped; anyone or anything else is listed as "not a manager".
  System messages, deleted ones and anything written before Direct chat went on (or before a newly added id's first
  check) are never delivered. Each id is saved before delivery, so a restart never delivers one twice.
- **Decisions.** The same numbered commands as the channel: see [Answering cards from Teams](#answering-cards-from-teams).
  The office applies them before CEO delivery; close stays in the Decision room.
- **Replying.** The CEO answers with `post_teams` and `direct_to` (your object id, given in the message). The office
  opens the bot's 1:1 conversation with you once, then caches its id:
  - `POST {serviceUrl}v3/conversations` with
    `{"bot":{"id":"28:<app id>"},"members":[{"id":"<your object id>"}],"tenantId":"<tenant>","isGroup":false,"channelData":{"tenant":{"id":"<tenant>"}}}`
    returns the conversation id;
  - `POST {serviceUrl}v3/conversations/{conversationId}/activities` posts the message.

  A 403 or 404 on the post forgets the cached id (it's made again next time). Direct posts count toward the same
  **The CEO's posts a day** as the channel's.

What the CEO gets for your direct message:

```text
Teams direct message from the manager, in their 1:1 chat with you in Teams (message 1763650000001):

How is floor 1 doing?

(Answer in that chat with post_teams, direct_to "e00b07ab-2f12-4a13-a2cd-156a025ae427", then reply NO_MESSAGE unless the phone needs it too.)
```

### Setting up Direct chat

1. **The permission** (once, by whoever runs the tenant, not by the office): grant the email sender's app the Graph
   application permission `Chat.Read.WhereInstalled`, with admin consent (Entra admin center → App registrations →
   the app → API permissions → Microsoft Graph → Application permissions). Nothing else: no tenant-wide chat
   permission.
2. **The app**: rebuild the Teams app package (its bot now has the `personal` scope as well as `team`, version
   1.1.0) and upload it again in Teams (**Apps → Manage your apps → Upload an app**, or update it in the Teams admin
   center).
3. **You**: in Teams, **Apps →** the CEO (e.g. Zander) **→ Add**, then **Open**. That makes your 1:1 chat with it.
4. **The office**: in **Settings → Teams**, make sure your Entra object id is on the list and switch **Direct chat**
   on. Its status shows **Chat found** for you once the office can read it. Write the CEO a line: within a minute it
   answers in the chat.

## Settings → Teams

| Field | |
| --- | --- |
| **Reads and posts in the Teams channel** | The switch, off by default. It can only go on once the team id and the channel id are set. When it goes on (or you point it at another channel), only messages written after that moment count: older ones are never replayed. |
| **Direct chat** | Off by default, apart from the channel switch. It can only go on with at least one id on **Count messages from these people as mine**, and goes off when the last one is removed. Below it, each id's chat: **Chat found**, **Not added yet** (add the app in Teams), or the error. Only messages written after it goes on count. |
| **Bot** | The email sender's app (its last characters), read-only. |
| **Team id** | The team's group id (a GUID). |
| **Channel id** | `19:…@thread.tacv2`, from the channel's **Get link to channel** (pasting it URL-encoded works too). |
| **Bot Framework service URL** | Default `https://smba.trafficmanager.net/amer/`. Microsoft hosts only. |
| **Check the channel every** | 30 to 3600 seconds, default 60. |
| **The CEO's posts a day** | 1 to 200, default 40, with today's count. |
| **Count messages from these people as mine** | Up to 10 Entra object ids (Entra admin center → Users → the user → Object ID). |
| **Colleague bots** | Up to 10, each a name and, preferably, its app id. Without an app id, a bot is matched by its display name, which another bot installed in the team could copy. |

Below the fields are the last check and its error, **Check now** (`POST /api/teams/check`, the channel and every
direct chat), and the latest 20 messages read, each with where it was written (channel or direct chat) and what
happened to it (`GET /api/teams` returns the same). The text itself is never shown or
logged.

Each message id is saved before the message is passed on, so a restart never delivers one twice. A **403** from
Graph puts one note on the phone and makes the office try again every 30 minutes until a check works. A 401 gets a
new token and tries once more.

## The CEO's Teams app

Teams only grants resource-specific consent, and only lets a bot post in a channel, through an app installed in the
team. The package lives in `teams-app/`:

- `manifest.json`: manifest v1.25 with `"supportsChannelFeatures": "tier1"`. `webApplicationInfo` is the app id with
  resource `https://RscPermission`, and RSC grants `ChannelMessage.Read.Group` (Application). A `bots` entry uses the
  same app id, with scopes `team` (the channel) and `personal` (Direct chat). There is also a minimal team `configurableTabs` entry, because Teams refuses a
  team-installed app without a team capability.
- `tab/config.html` and `tab/content.html`: the tab's two static pages (the config page only has **Save**). Host them
  together on any https static host, e.g. an Azure Storage static website.

Build the zip with the real app id (the email sender's application id) and the tabs' address:

```bash
npm run teams-app -- --app-id <application (client) id> --tab-url https://<host>/<path>/ --name Zander
```

It writes `teams-app/build/<name>-teams-app.zip` (ignored by git) with the filled-in manifest and two generated
icons. `--developer`, `--website`, `--manifest-id` and `--out` are optional. The Teams app's own id is derived from
the app id, so rebuilding it updates the same app.

## Setting it up (Azure and Teams)

These steps are done once, by whoever runs the tenant, not by the office:

1. **The Azure Bot**, a free single-tenant registration for the same app (it only enables the Teams channel; no
   messaging endpoint is needed, as the office never receives activities):

   ```bash
   az bot create --resource-group <rg> --name <bot name> --app-type SingleTenant \
     --appid <application (client) id> --tenant-id <directory id> --sku F0
   az bot msteams create --resource-group <rg> --name <bot name>
   ```

2. **The tab pages**: upload `teams-app/tab/config.html` and `content.html` to the `--tab-url` address.
3. **The app**: build the zip (above), then in Teams go to **Apps → Manage your apps → Upload an app** (or the
   Teams admin center), and add it to the team. Installing it grants `ChannelMessage.Read.Group` for that team only.
   Click **Save** on the tab.
4. **The office**: in **Settings → Teams**, enter the team id and channel id, add your Entra object id and any
   colleague bots (by app id), and switch it on. Write a line in the channel: within a minute the CEO answers in its
   thread.

Until the app is installed, checks get a 403 (one note on the phone). Until the bot is registered, posts fail with a
401 or 403, and the CEO is told why.

## The demo

A demo office starts with a made-up team and channel, switched off. Switch it on in Settings → Teams to see what
happens to six made-up messages. Your question reaches the CEO, which answers in its thread (the post is only
logged). Your "Decision: approve #3, ship it." reaches the CEO, which points you to the Decision room. Nova (a
colleague bot) @mentions the CEO and gets an answer. Nova's "Thanks!", Nova's post without a mention, and a guest's
message are only listed, and the CEO's own post is skipped.

Switch **Direct chat** on as well to see the manager's made-up 1:1 chat: their question reaches the CEO (💬 Teams DM on
the phone), which answers in the chat (logged); their "approve #2, go ahead." gets pointed to the Decision room; the
CEO's own message is skipped.
