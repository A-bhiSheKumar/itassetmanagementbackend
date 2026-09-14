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
}

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
