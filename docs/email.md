# Email from the CEO

The CEO can send plain-text email from one Microsoft 365 mailbox, through Microsoft Graph, to the people on your list
and nobody else. The office checks the list itself (`server/swarm.ts`, `shared/email.ts`): a prompt can't talk its way
past it.

## The list and approvals

**Settings → Email** (the manager's console, or the settings in pocket mode):

- **The CEO may send email**: the switch. Off, `send_email` is refused and the CEO isn't told about it.
- **From**: the mailbox it sends from. Replies go there; every email ends with a two-line footer saying the
  company's office CEO (an AI agent in cubefarm) wrote it.
- **Blind copy of every email to**: someone on the list (usually you) who gets a copy of each email. **Send test**
  sends a short email there.
- **Who the CEO may email**: up to 25 people. **Ask me** (on by default): each email to them waits in **Approvals**
  (pocket mode, and the phone's Team tab) with **Send** and **Decline** (with a note the CEO reads). Without it, the
  email goes out at once and the phone says so.

The CEO sends at most 10 emails a day (sent plus waiting). The list is checked again when you press **Send**: remove
someone and their waiting emails can't go out.

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

## The demo

A demo office starts with a made-up sender and a short list (one person behind **Ask me**, one whose address contains
"bad" so sends to it fail). Nothing is sent: each email is logged. Ask the demo CEO on the phone to "email Ada the
weekly update" to see one wait for your OK.
