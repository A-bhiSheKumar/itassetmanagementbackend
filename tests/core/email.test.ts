import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { env } from '../../src/config/index.js';
import {
  sendEmail,
  deliverEmail,
  setEmailTransport,
  recordingTransport,
  EmailMessageModel,
  SuppressionModel,
  ResendTransport,
  RecordingTransport,
  render,
  verifySvixSignature,
  type EmailTransport,
} from '../../src/modules/email/index.js';

const server = useTestServer(createApp());

/**
 * The email layer, without Resend.
 *
 * The properties that matter are the ones that fail silently in production:
 * a message sent twice, mail to an address that bounced, development mail
 * reaching a real person, a forged bounce stopping someone's mail, and a user's
 * text becoming markup in a message that looks like it came from us.
 */

beforeEach(() => {
  setEmailTransport(new RecordingTransport());
});

afterEach(() => {
  setEmailTransport(undefined);
});

describe('sending', () => {
  it('logs, queues and delivers a message', async () => {
    const result = await sendEmail({
      template: 'notification',
      to: 'Ada@Example.com',
      payload: { title: 'Laptop assigned', body: 'You now hold AST-0001.', actionUrl: '/assets/abc' },
    });

    expect(result.status).toBe('queued');
    const sent = recordingTransport().to('ada@example.com');
    expect(sent).toHaveLength(1);
    // An in-product path becomes an absolute link; a relative one in email goes nowhere.
    expect(sent[0]!.html).toContain(`${env.APP_URL}/assets/abc`);
    expect(sent[0]!.text).toContain('You now hold AST-0001.');

    const logged = await EmailMessageModel.findById(result.messageId).lean();
    expect(logged?.status).toBe('sent');
  });

  it('sends one logical message once, however many times it is asked for', async () => {
    const input = {
      template: 'notification' as const,
      to: 'ada@example.com',
      payload: { title: 'Warranty expiring', body: '30 days left.' },
      dedupeKey: 'warranty:asset-1:30',
    };

    await sendEmail(input);
    const second = await sendEmail(input);

    expect(second.status).toBe('duplicate');
    expect(recordingTransport().to('ada@example.com')).toHaveLength(1);
  });

  it('never mails an address that has bounced, and records why', async () => {
    await SuppressionModel.create({ email: 'gone@example.com', reason: 'bounce' });

    const result = await sendEmail({
      template: 'notification',
      to: 'gone@example.com',
      payload: { title: 'Hello', body: 'x' },
    });

    expect(result.status).toBe('suppressed');
    expect(recordingTransport().to('gone@example.com')).toHaveLength(0);
    expect((await EmailMessageModel.findById(result.messageId).lean())?.status).toBe('suppressed');
  });
});

describe('delivery failures', () => {
  async function queuedMessage(): Promise<string> {
    // Created without delivery, so a failing transport can be put in first.
    const doc = await EmailMessageModel.create({
      template: 'test',
      to: 'ada@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
    return String(doc._id);
  }

  it('throws a retryable failure back to the queue, so it retries with backoff', async () => {
    const id = await queuedMessage();
    setEmailTransport({ name: 'recording', send: async () => ({ ok: false, retryable: true, error: 'Resend 503' }) });

    await expect(deliverEmail(id)).rejects.toThrow('Resend 503');
    const doc = await EmailMessageModel.findById(id).lean();
    expect(doc?.status).toBe('queued');
    expect(doc?.lastError).toBe('Resend 503');
  });

  it('marks a permanent failure failed without retrying it', async () => {
    const id = await queuedMessage();
    setEmailTransport({ name: 'recording', send: async () => ({ ok: false, retryable: false, error: 'Resend 422: invalid to' }) });

    await expect(deliverEmail(id)).resolves.toBeUndefined();
    expect((await EmailMessageModel.findById(id).lean())?.status).toBe('failed');
  });

  it('refuses real delivery outside production unless mail is redirected', async () => {
    const id = await queuedMessage();
    const send = vi.fn();
    const live: EmailTransport = { name: 'resend', send };
    setEmailTransport(live);

    const previous = env.MAIL_REDIRECT_TO;
    env.MAIL_REDIRECT_TO = undefined;
    try {
      await deliverEmail(id);
    } finally {
      env.MAIL_REDIRECT_TO = previous;
    }

    // Seeded data is full of real people's addresses.
    expect(send).not.toHaveBeenCalled();
    expect((await EmailMessageModel.findById(id).lean())?.lastError).toMatch(/MAIL_REDIRECT_TO/);
  });

  it('redirects development mail and says who it was really for', async () => {
    const id = await queuedMessage();
    const send = vi.fn().mockResolvedValue({ ok: true, providerId: 're_1' });
    setEmailTransport({ name: 'resend', send });

    const previous = env.MAIL_REDIRECT_TO;
    env.MAIL_REDIRECT_TO = 'developer@example.com';
    try {
      await deliverEmail(id);
    } finally {
      env.MAIL_REDIRECT_TO = previous;
    }

    expect(send.mock.calls[0]![0]).toMatchObject({ to: 'developer@example.com', subject: '[to ada@example.com] s' });
  });
});

describe('the Resend transport', () => {
  it('sends an idempotency key, so a retried send is not delivered twice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 're_123' }), { status: 200 }));
    const transport = new ResendTransport('re_key', fetchImpl as unknown as typeof fetch);

    const outcome = await transport.send({
      from: 'A <a@x.com>', to: 'b@x.com', subject: 's', html: 'h', text: 't', idempotencyKey: 'msg-1', tags: { template: 'test.v2' },
    });

    expect(outcome).toEqual({ ok: true, providerId: 're_123' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer re_key', 'Idempotency-Key': 'msg-1' });
    // Resend refuses tag values with dots; they are normalised rather than rejected.
    expect(JSON.parse((init as RequestInit).body as string).tags).toEqual([{ name: 'template', value: 'test_v2' }]);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [422, false],
    [403, false],
  ])('treats HTTP %i as retryable: %s', async (status, retryable) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status }));
    const outcome = await new ResendTransport('k', fetchImpl as unknown as typeof fetch).send({
      from: 'a@x.com', to: 'b@x.com', subject: 's', html: 'h', text: 't', idempotencyKey: 'i',
    });
    expect(outcome).toMatchObject({ ok: false, retryable });
  });
});

describe('rendering', () => {
  it("escapes a user's text, so it can never become markup", () => {
    const { html } = render(
      { subject: 's', heading: '<img src=x onerror=alert(1)>', blocks: [{ kind: 'paragraph', text: 'Laptop "<b>Pro</b>"' }] },
      { productName: 'P', footer: 'f' },
    );

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<b>Pro</b>');
  });

  it('refuses a javascript: link in a button', () => {
    const { html } = render(
      { subject: 's', heading: 'h', blocks: [{ kind: 'button', label: 'Open', url: 'javascript:alert(1)' }] },
      { productName: 'P', footer: 'f' },
    );
    expect(html).not.toContain('javascript:');
  });
});

describe('the delivery webhook', () => {
  const secret = `whsec_${Buffer.from('test-signing-secret').toString('base64')}`;

  function sign(body: string, timestamp = Math.floor(Date.now() / 1000), id = 'msg_1') {
    const key = Buffer.from(secret.replace('whsec_', ''), 'base64');
    const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
  }

  let previous: string | undefined;
  beforeEach(() => {
    previous = env.RESEND_WEBHOOK_SECRET;
    env.RESEND_WEBHOOK_SECRET = secret;
  });
  afterEach(() => {
    env.RESEND_WEBHOOK_SECRET = previous;
  });

  it('suppresses an address after a verified hard bounce', async () => {
    const message = await EmailMessageModel.create({
      template: 'test', to: 'bounce@example.com', subject: 's', html: 'h', text: 't', status: 'sent', providerId: 're_abc',
    });
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_abc', to: ['bounce@example.com'], bounce: { type: 'Permanent', message: 'No such user' } } });

    const res = await request(server()).post('/api/v1/webhooks/resend').set(sign(body)).set('Content-Type', 'application/json').send(body);

    expect(res.status).toBe(200);
    expect(await SuppressionModel.exists({ email: 'bounce@example.com' })).not.toBeNull();
    expect((await EmailMessageModel.findById(message._id).lean())?.status).toBe('bounced');
  });

  it('does not suppress on a transient bounce, which may succeed later', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_t', to: ['full@example.com'], bounce: { type: 'Transient' } } });
    await request(server()).post('/api/v1/webhooks/resend').set(sign(body)).set('Content-Type', 'application/json').send(body).expect(200);

    expect(await SuppressionModel.exists({ email: 'full@example.com' })).toBeNull();
  });

  it('refuses a forged bounce, which would otherwise stop all of someone’s mail', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_x', to: ['victim@example.com'] } });
    const headers = sign(body);
    headers['svix-signature'] = `v1,${Buffer.alloc(32).toString('base64')}`;

    const res = await request(server()).post('/api/v1/webhooks/resend').set(headers).set('Content-Type', 'application/json').send(body);

    expect(res.status).toBe(401);
    expect(await SuppressionModel.exists({ email: 'victim@example.com' })).toBeNull();
  });

  it('refuses a replay of a genuine but old event', () => {
    const body = '{}';
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    const headers = sign(body, old);
    expect(
      verifySvixSignature({ secret, id: headers['svix-id'], timestamp: headers['svix-timestamp'], signatureHeader: headers['svix-signature'], body }),
    ).toBe(false);
  });

  it('accepts either signature while the secret is being rotated', () => {
    const body = '{"type":"email.delivered"}';
    const headers = sign(body);
    const rotated = `v1,${Buffer.alloc(32).toString('base64')} ${headers['svix-signature']}`;
    expect(
      verifySvixSignature({ secret, id: headers['svix-id'], timestamp: headers['svix-timestamp'], signatureHeader: rotated, body }),
    ).toBe(true);
  });
});
