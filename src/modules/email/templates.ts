import type { EmailContent } from './render.js';

/**
 * Every email the product sends, as typed data.
 *
 * A template is a function from its payload to content blocks — never an HTML
 * string with placeholders, which is how an unescaped name ends up as markup.
 * The payload type is the contract: a caller cannot forget a field a template
 * needs, and renaming one fails to compile everywhere it is used.
 */

export interface TemplatePayloads {
  /** A generic in-product notification mirrored to email. */
  notification: {
    title: string;
    body: string;
    actionUrl?: string | null;
    actionLabel?: string;
  };
  /** A delivery check from the operations screen. */
  test: { requestedBy: string };

  /** Someone was invited into an organisation. Carries a single-use link. */
  invitation: {
    organisationName: string;
    inviterName: string | null;
    roleNames: string[];
    acceptUrl: string;
    expiresAt: string;
  };

  /** Please confirm you received this equipment. Carries a single-use link. */
  receiptRequest: {
    personName: string;
    organisationName: string;
    assetName: string;
    assetTag: string;
    serialNumber: string | null;
    confirmUrl: string;
    reminder: boolean;
  };

  /** Something is due back, or overdue. */
  returnReminder: {
    personName: string;
    organisationName: string;
    assetName: string;
    assetTag: string;
    dueDate: string;
    overdue: boolean;
  };

  /** A reset was requested. Carries a single-use link. */
  passwordReset: { name: string; resetUrl: string; expiresInMinutes: number };

  /** Security notice after any password change or reset. */
  passwordChanged: { name: string; changedAt: string };
}

/**
 * Templates whose body carries a credential — a link that signs someone in,
 * accepts an invitation or confirms receipt. Their rendered body is erased from
 * the message log once delivery is settled: a copy of the link sitting in the
 * database would be a working credential for anyone who can read it.
 */
export const SENSITIVE_TEMPLATES: ReadonlySet<TemplateName> = new Set(['invitation', 'receiptRequest', 'passwordReset']);

export type TemplateName = keyof TemplatePayloads;

type TemplateFn<N extends TemplateName> = (payload: TemplatePayloads[N], app: { url: string; name: string }) => EmailContent;

const templates: { [N in TemplateName]: TemplateFn<N> } = {
  notification: (p, app) => ({
    subject: p.title,
    preheader: p.body.slice(0, 120),
    heading: p.title,
    blocks: [
      { kind: 'paragraph', text: p.body },
      ...(p.actionUrl
        ? [{ kind: 'button' as const, label: p.actionLabel ?? 'Open', url: absolute(p.actionUrl, app.url) }]
        : []),
    ],
  }),

  invitation: (p, app) => ({
    subject: `You're invited to ${p.organisationName} on ${app.name}`,
    preheader: `${p.inviterName ?? 'Someone'} invited you to help manage ${p.organisationName}'s equipment.`,
    heading: `Join ${p.organisationName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${p.inviterName ?? 'An administrator'} has invited you to ${p.organisationName} on ${app.name}, where the organisation keeps track of its equipment and who has it.`,
      },
      ...(p.roleNames.length > 0 ? [{ kind: 'details' as const, rows: [{ label: 'Your role', value: p.roleNames.join(', ') }] }] : []),
      { kind: 'button', label: 'Accept invitation', url: p.acceptUrl },
      { kind: 'note', text: `This link works once and expires on ${p.expiresAt}. If you weren't expecting it, you can ignore this email.` },
    ],
  }),

  receiptRequest: (p) => ({
    subject: p.reminder ? `Reminder: please confirm you have ${p.assetName}` : `Please confirm you received ${p.assetName}`,
    preheader: `${p.organisationName} has recorded ${p.assetName} as issued to you.`,
    heading: p.reminder ? 'A quick reminder' : 'Did you receive this?',
    blocks: [
      { kind: 'paragraph', text: `Hi ${p.personName}, ${p.organisationName} has recorded the following as issued to you. Please confirm you have it.` },
      {
        kind: 'details',
        rows: [
          { label: 'Item', value: p.assetName },
          { label: 'Asset tag', value: p.assetTag },
          ...(p.serialNumber ? [{ label: 'Serial number', value: p.serialNumber }] : []),
        ],
      },
      { kind: 'button', label: 'Yes, I have it', url: p.confirmUrl },
      { kind: 'note', text: `If you don't have this item, don't confirm — reply to let ${p.organisationName} know.` },
    ],
  }),

  returnReminder: (p) => ({
    subject: p.overdue ? `${p.assetName} is overdue for return` : `${p.assetName} is due back on ${p.dueDate}`,
    heading: p.overdue ? 'This is overdue' : 'Due back soon',
    blocks: [
      {
        kind: 'paragraph',
        text: p.overdue
          ? `Hi ${p.personName}, ${p.organisationName} expected ${p.assetName} back by ${p.dueDate}. Please return it, or reply if you need longer.`
          : `Hi ${p.personName}, ${p.assetName} is due back to ${p.organisationName} on ${p.dueDate}.`,
      },
      { kind: 'details', rows: [{ label: 'Item', value: p.assetName }, { label: 'Asset tag', value: p.assetTag }, { label: 'Due', value: p.dueDate }] },
    ],
  }),

  passwordReset: (p, app) => ({
    subject: `Reset your ${app.name} password`,
    heading: 'Reset your password',
    blocks: [
      { kind: 'paragraph', text: `Hi ${p.name}, someone asked to reset the password for your ${app.name} account. If it was you, choose a new one below.` },
      { kind: 'button', label: 'Choose a new password', url: p.resetUrl },
      {
        kind: 'note',
        text: `The link works once and expires in ${p.expiresInMinutes} minutes. If you didn't ask for this, ignore this email — your password stays as it is.`,
      },
    ],
  }),

  passwordChanged: (p, app) => ({
    subject: `Your ${app.name} password was changed`,
    heading: 'Your password was changed',
    blocks: [
      { kind: 'paragraph', text: `Hi ${p.name}, the password for your ${app.name} account was changed on ${p.changedAt}, and every device was signed out.` },
      { kind: 'note', text: `If this wasn't you, reset your password straight away and tell your ${app.name} administrator.` },
    ],
  }),

  test: (p, app) => ({
    subject: `Test email from ${app.name}`,
    heading: 'Email delivery is working',
    blocks: [
      { kind: 'paragraph', text: `${p.requestedBy} sent this to check that email from ${app.name} arrives.` },
      { kind: 'note', text: 'Nothing needs doing.' },
    ],
  }),
};

/**
 * In-product links are paths (`/assets/abc`). Email needs absolute URLs, and a
 * relative link in a message goes nowhere at all.
 */
export function absolute(pathOrUrl: string, appUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${appUrl.replace(/\/+$/, '')}/${pathOrUrl.replace(/^\/+/, '')}`;
}

export function buildContent<N extends TemplateName>(
  name: N,
  payload: TemplatePayloads[N],
  app: { url: string; name: string },
): EmailContent {
  return (templates[name] as TemplateFn<N>)(payload, app);
}
