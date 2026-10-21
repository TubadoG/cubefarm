// Sending email through Microsoft Graph (docs/email.md): an app-only token (client credentials, with a client secret or
// a certificate whose private key stays in Azure Key Vault), then POST /users/{from}/sendMail. The pure parts (the
// client assertion's JWT, the request body, base64url) are exported for tests. Tokens, assertions and secrets are
// never logged or put in an error message.
import { createHash, randomUUID } from 'node:crypto';
import type { EmailSettings } from '../shared/types.ts';
import { run } from './exec.ts';

/** The sender's credentials, from secrets.json's `email`. */
export type EmailSender = { tenantId: string; clientId: string; clientSecret: string } | { tenantId: string; clientId: string; keyId: string; x5tHex: string };

/** One email as the transport sends it. */
export interface OutgoingEmail {
  from: string;
  to: string;
  toName: string;
  subject: string;
  text: string;
  /** Sent instead of `text` when given (Graph takes one body); the text stays for logs and the office's record. */
  html?: string;
  bcc?: string;
}

/** The real one is Graph; the demo's only logs what it would send. */
export interface EmailTransport {
  /** Sends it, or throws why not, in words the manager can act on. */
  send(sender: EmailSender, msg: OutgoingEmail): Promise<void>;
  /** A fake sender a demo office starts with (never used for anything real). */
  demoSender?: EmailSender;
  /** The demo office's made-up email settings, for an office that has none saved. */
  demoSettings?: EmailSettings;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
// A Key Vault key id: https://<vault>.vault.azure.net/keys/<name>[/<version>]. Only these characters, as it goes
// through cmd.exe on Windows.
const KEY_ID = /^https:\/\/[a-z0-9-]+\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net)\/keys\/[A-Za-z0-9-]+(\/[0-9a-f]{32})?$/;

/** Sender credentials from a PUT body or secrets.json, or a message saying what's wrong. */
export function parseSender(raw: unknown): EmailSender | { error: string } {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof x[k] === 'string' ? (x[k] as string).trim() : '');
  const tenantId = str('tenantId');
  const clientId = str('clientId');
  if (!TENANT.test(tenantId)) return { error: 'tenantId must be the directory (tenant) id, or its domain.' };
  if (!GUID.test(clientId)) return { error: "clientId must be the app registration's application (client) id." };
  if (str('clientSecret')) return { tenantId, clientId, clientSecret: str('clientSecret') };
  const keyId = str('keyId');
  const x5tHex = str('x5tHex').replace(/[\s:]/g, '').toLowerCase();
  if (!keyId && !x5tHex) return { error: 'Give either clientSecret, or keyId and x5tHex (a certificate whose key is in Key Vault).' };
  if (!KEY_ID.test(keyId)) return { error: 'keyId must be a Key Vault key id, e.g. https://my-vault.vault.azure.net/keys/cubefarm-mail.' };
  if (!/^[0-9a-f]{40}$/.test(x5tHex)) return { error: "x5tHex must be the certificate's SHA-1 thumbprint (40 hex characters)." };
  return { tenantId, clientId, keyId, x5tHex };
}

export const senderMode = (s: EmailSender): 'secret' | 'keyvault' => ('clientSecret' in s ? 'secret' : 'keyvault');

/** What Settings → Email shows of the sender: its kind and the app id's last characters. */
export function senderHint(s: EmailSender | null): string {
  if (!s) return '';
  return 'keyId' in s ? `app …${s.clientId.slice(-4)}, key ${s.keyId.split('/keys/')[1]?.split('/')[0] ?? ''}` : `app …${s.clientId.slice(-4)}`;
}

// ---------- the pure parts ----------

/** base64url of bytes, or of a string's UTF-8. */
export function b64url(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');
}

/** A signature as base64 or base64url (Key Vault answers base64url; some az versions base64), as base64url. */
export function toBase64Url(sig: string): string {
  return sig.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const tokenEndpoint = (tenantId: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

/** A client assertion's header and claims, joined as JWT signs them; `now` in ms. */
export function assertionInput(o: { tenantId: string; clientId: string; x5tHex: string; now: number; jti: string }): string {
  const header = { alg: 'RS256', typ: 'JWT', x5t: b64url(Buffer.from(o.x5tHex, 'hex')) };
  const t = Math.floor(o.now / 1000);
  const claims = { aud: tokenEndpoint(o.tenantId), iss: o.clientId, sub: o.clientId, jti: o.jti, nbf: t - 60, exp: t + 600 };
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
}

/** The SHA-256 digest Key Vault signs, as base64 (what `az keyvault key sign --digest` takes). */
export const digestOf = (signingInput: string) => createHash('sha256').update(signingInput).digest('base64');

export const assembleJwt = (signingInput: string, signature: string) => `${signingInput}.${toBase64Url(signature)}`;

/** POST /users/{from}/sendMail's body: plain text (or HTML when it has some), saved to Sent Items, the copy as a blind copy. */
export function sendMailBody(m: OutgoingEmail) {
  const bcc = m.bcc && m.bcc !== m.to ? [{ emailAddress: { address: m.bcc } }] : [];
  return {
    message: {
      subject: m.subject,
      body: m.html ? { contentType: 'HTML', content: m.html } : { contentType: 'Text', content: m.text },
      toRecipients: [{ emailAddress: { address: m.to, ...(m.toName ? { name: m.toName } : {}) } }],
      ...(bcc.length ? { bccRecipients: bcc } : {}),
    },
    saveToSentItems: true,
  };
}

// ---------- the real transport ----------

const TIMEOUT_MS = 20_000;
const tokens = new Map<string, { token: string; until: number }>();

/** Key Vault signs the digest; the private key never leaves the vault. */
async function vaultSign(keyId: string, digest: string): Promise<string> {
  const args = ['keyvault', 'key', 'sign', '--id', keyId, '--algorithm', 'RS256', '--digest', digest, '-o', 'json'];
  // az is a .cmd on Windows: through cmd.exe, safe as keyId (KEY_ID) and the base64 digest hold no shell characters.
  const out = await (process.platform === 'win32' ? run('cmd.exe', ['/d', '/s', '/c', ['az', ...args].join(' ')], { timeoutMs: 60_000 }) : run('az', args, { timeoutMs: 60_000 })).catch(
    (err: Error) => {
      throw new Error(`Key Vault didn't sign the token request (is the Azure CLI installed and signed in?): ${err.message.split('\n')[0].slice(0, 200)}`);
    },
  );
  const sig = (JSON.parse(out) as { signature?: unknown }).signature;
  if (typeof sig !== 'string' || !sig) throw new Error("Key Vault's answer had no signature.");
  return sig;
}

async function accessToken(s: EmailSender): Promise<string> {
  const key = `${s.tenantId}/${s.clientId}/${senderMode(s)}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const form = new URLSearchParams({ client_id: s.clientId, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  if ('clientSecret' in s) form.set('client_secret', s.clientSecret);
  else {
    const input = assertionInput({ tenantId: s.tenantId, clientId: s.clientId, x5tHex: s.x5tHex, now: Date.now(), jti: randomUUID() });
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', assembleJwt(input, await vaultSign(s.keyId, digestOf(input))));
  }
  const res = await fetch(tokenEndpoint(s.tenantId), { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    // Entra's error codes (AADSTS…) say what's wrong without any secret in them.
    throw new Error(`Microsoft sign-in refused the app (HTTP ${res.status}${body.error ? `, ${body.error}` : ''}): ${(body.error_description ?? '').split('\n')[0].slice(0, 200)}`);
  }
  // Kept until 5 minutes before it expires.
  tokens.set(key, { token: body.access_token, until: Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 300) * 1000 });
  return body.access_token;
}

export const graphTransport: EmailTransport = {
  async send(sender, msg) {
    const token = await accessToken(sender);
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(msg.from)}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sendMailBody(msg)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 202 || res.ok) return;
    if (res.status === 401) tokens.delete(`${sender.tenantId}/${sender.clientId}/${senderMode(sender)}`);
    const err = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const why = res.status === 403 ? ` The app may lack Mail.Send for ${msg.from} (see docs/email.md).` : '';
    throw new Error(`Graph refused the email (HTTP ${res.status}${err.error?.code ? `, ${err.error.code}` : ''}): ${(err.error?.message ?? '').slice(0, 200)}${why}`);
  },
};
