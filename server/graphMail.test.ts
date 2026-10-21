import { createSign, generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleJwt, assertionInput, b64url, digestOf, parseSender, sendMailBody, senderHint, toBase64Url, tokenEndpoint } from './graphMail.ts';

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '99999999-8888-4777-8666-555555554321';
const X5T = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';

describe('sender credentials', () => {
  it('takes a client secret', () => {
    expect(parseSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: ' s3cret ' })).toEqual({ tenantId: TENANT, clientId: CLIENT, clientSecret: 's3cret' });
  });

  it('takes a Key Vault key and a thumbprint, written with colons or spaces', () => {
    const keyId = 'https://my-vault.vault.azure.net/keys/cubefarm-mail/0123456789abcdef0123456789abcdef';
    const thumb = X5T.match(/../g)!.join(':');
    expect(parseSender({ tenantId: 'acme.onmicrosoft.com', clientId: CLIENT, keyId, x5tHex: thumb })).toEqual({ tenantId: 'acme.onmicrosoft.com', clientId: CLIENT, keyId, x5tHex: X5T.toLowerCase() });
  });

  it('says what is wrong', () => {
    expect(parseSender({})).toEqual({ error: expect.stringMatching(/tenantId/) });
    expect(parseSender({ tenantId: TENANT, clientId: 'nope' })).toEqual({ error: expect.stringMatching(/clientId/) });
    expect(parseSender({ tenantId: TENANT, clientId: CLIENT })).toEqual({ error: expect.stringMatching(/clientSecret, or keyId/) });
    // anything but a vault key id: it goes through cmd.exe on Windows
    expect(parseSender({ tenantId: TENANT, clientId: CLIENT, keyId: 'https://x.vault.azure.net/keys/a&calc', x5tHex: X5T })).toEqual({ error: expect.stringMatching(/keyId/) });
    expect(parseSender({ tenantId: TENANT, clientId: CLIENT, keyId: 'https://x.vault.azure.net/keys/a', x5tHex: 'abc' })).toEqual({ error: expect.stringMatching(/x5tHex/) });
  });

  it('hints without the secret', () => {
    const hint = senderHint({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'topsecret' });
    expect(hint).toBe('app …4321');
    expect(hint).not.toContain('topsecret');
    expect(senderHint({ tenantId: TENANT, clientId: CLIENT, keyId: 'https://v.vault.azure.net/keys/mail/0123456789abcdef0123456789abcdef', x5tHex: X5T })).toBe('app …4321, key mail');
  });
});

describe('base64url', () => {
  it('encodes bytes and text without padding', () => {
    expect(b64url(Buffer.from([0xfb, 0xff]))).toBe('-_8');
    expect(b64url('{"a":1}')).toBe('eyJhIjoxfQ');
  });

  it('turns base64 or base64url signatures into base64url', () => {
    expect(toBase64Url('ab+/cd==')).toBe('ab-_cd');
    expect(toBase64Url('ab-_cd')).toBe('ab-_cd');
  });
});

describe('the client assertion', () => {
  const now = 1_700_000_000_000;
  const input = assertionInput({ tenantId: TENANT, clientId: CLIENT, x5tHex: X5T.toLowerCase(), now, jti: 'jti-1' });
  const [head, body] = input.split('.').map((p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));

  it('names the certificate by its thumbprint and signs with RS256', () => {
    expect(head).toEqual({ alg: 'RS256', typ: 'JWT', x5t: Buffer.from(X5T, 'hex').toString('base64url') });
  });

  it('claims what Entra wants', () => {
    expect(body).toEqual({ aud: tokenEndpoint(TENANT), iss: CLIENT, sub: CLIENT, jti: 'jti-1', nbf: now / 1000 - 60, exp: now / 1000 + 600 });
    expect(tokenEndpoint(TENANT)).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  });

  it('verifies with the key whose signature Key Vault would return for the digest', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Key Vault signs the SHA-256 digest; signing the input with RSA-SHA256 gives the same bytes.
    const sig = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64');
    const jwt = assembleJwt(input, sig);
    const [h, c, s] = jwt.split('.');
    expect(`${h}.${c}`).toBe(input);
    expect(s).not.toMatch(/[+/=]/);
    expect(createVerify('RSA-SHA256').update(input).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(digestOf(input)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});

describe('sendMail', () => {
  const msg = { from: 'ceo@co.example.com', to: 'ada@acme.example.com', toName: 'Ada', subject: 'Hi', text: 'Hello' };

  it('is plain text, saved to Sent Items', () => {
    expect(sendMailBody(msg)).toEqual({
      message: { subject: 'Hi', body: { contentType: 'Text', content: 'Hello' }, toRecipients: [{ emailAddress: { address: 'ada@acme.example.com', name: 'Ada' } }] },
      saveToSentItems: true,
    });
  });

  it('sends HTML instead when the email has some', () => {
    expect(sendMailBody({ ...msg, html: '<p>Hello</p>' }).message.body).toEqual({ contentType: 'HTML', content: '<p>Hello</p>' });
  });

  it('blind-copies the copy-to address unless it is the recipient', () => {
    expect(sendMailBody({ ...msg, bcc: 'me@co.example.com' }).message.bccRecipients).toEqual([{ emailAddress: { address: 'me@co.example.com' } }]);
    expect(sendMailBody({ ...msg, bcc: 'ada@acme.example.com' }).message).not.toHaveProperty('bccRecipients');
  });
});
