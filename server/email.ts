// The sender's credentials for outbound email (docs/email.md), kept in the secrets file under `email`. Only their kind
// and a hint ever leave the server. The allowlist, approvals and the outbox are the swarm's (swarm.ts, shared/email.ts).
import type { EmailSenderView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { parseSender, senderHint, senderMode, type EmailSender, type EmailTransport, type OutgoingEmail } from './graphMail.ts';
import { mergeSecrets, readSecrets } from './secrets.ts';

export interface MailerDeps {
  transport: EmailTransport;
  secretsFile: string;
  changed(view: EmailSenderView): void;
}

export class Mailer {
  private sender: EmailSender | null = null;

  constructor(private deps: MailerDeps) {}

  async init() {
    const s = await readSecrets(this.deps.secretsFile);
    if (s.email === undefined && this.deps.transport.demoSender) {
      this.sender = this.deps.transport.demoSender;
      await mergeSecrets(this.deps.secretsFile, { email: this.sender }).catch(() => undefined);
      return;
    }
    const parsed = parseSender(s.email);
    this.sender = 'error' in parsed ? null : parsed;
  }

  view(): EmailSenderView {
    return { set: !!this.sender, mode: this.sender ? senderMode(this.sender) : null, hint: senderHint(this.sender) };
  }

  get ready() {
    return !!this.sender;
  }

  /** PUT /api/email/sender: saves the credentials (validated), and answers only whether they're set. */
  async setSender(body: unknown): Promise<EmailSenderView> {
    const parsed = parseSender(body);
    if ('error' in parsed) throw new HttpError(400, parsed.error);
    await mergeSecrets(this.deps.secretsFile, { email: parsed });
    this.sender = parsed;
    return this.changed();
  }

  /** DELETE /api/email/sender. Null rather than gone, so a demo office doesn't put its fake sender back. */
  async removeSender(): Promise<EmailSenderView> {
    await mergeSecrets(this.deps.secretsFile, { email: null });
    this.sender = null;
    return this.changed();
  }

  /** Sends one email, or throws why not. The caller has checked the allowlist. */
  async send(msg: OutgoingEmail): Promise<void> {
    if (!this.sender) throw new Error('No email sender is set up on the office.');
    await this.deps.transport.send(this.sender, msg);
  }

  private changed() {
    const v = this.view();
    this.deps.changed(v);
    return v;
  }
}
