/**
 * Email HTML, built the way email clients need it.
 *
 * Tables and inline styles, not flexbox and a stylesheet: Outlook renders HTML
 * with Word's engine and Gmail strips <style> blocks in several contexts, so
 * anything modern falls apart in exactly the inboxes business customers use.
 *
 * Every interpolated value is escaped. Asset names, people's names and notes are
 * typed by users, and an unescaped one is HTML injection into a message that
 * arrives looking like it came from us.
 *
 * A plain-text version is derived from the same blocks, never written by hand,
 * so the two cannot drift — and some clients and every spam filter read it.
 */

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'details'; rows: Array<{ label: string; value: string }> }
  | { kind: 'note'; text: string };

export interface EmailContent {
  subject: string;
  /** The grey preview line beside the subject in most inboxes. */
  preheader?: string;
  heading: string;
  blocks: Block[];
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const INK = '#161a19';
const MUTED = '#6a7470';
const ACCENT = '#1b6357';
const BORDER = '#e2e8e6';
const CANVAS = '#f5f7f6';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only http(s) links reach an email.
 *
 * A `javascript:` or `data:` URL in a button is inert in most clients and
 * dangerous in the rest; nothing legitimate here needs one.
 */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">${escapeHtml(block.text)}</p>`;
    case 'note':
      return `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(block.text)}</p>`;
    case 'button':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:6px;background:${ACCENT};"><a href="${escapeHtml(safeUrl(block.url))}" style="display:inline-block;padding:11px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(block.label)}</a></td></tr></table>`;
    case 'details':
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border:1px solid ${BORDER};border-radius:6px;">${block.rows
        .map(
          (row, i) =>
            `<tr><td style="padding:10px 14px;font-size:13px;color:${MUTED};${i > 0 ? `border-top:1px solid ${BORDER};` : ''}width:40%;">${escapeHtml(row.label)}</td><td style="padding:10px 14px;font-size:14px;color:${INK};${i > 0 ? `border-top:1px solid ${BORDER};` : ''}">${escapeHtml(row.value)}</td></tr>`,
        )
        .join('')}</table>`;
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'note':
      return block.text;
    case 'button':
      // Plain text has no buttons, so the link itself must be visible.
      return `${block.label}: ${block.url}`;
    case 'details':
      return block.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
  }
}

export function render(content: EmailContent, options: { productName: string; footer: string }): Rendered {
  const preheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}${'&#8204;&nbsp;'.repeat(40)}</div>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:10px;">
<tr><td style="padding:24px 32px 0;font-size:13px;font-weight:700;letter-spacing:0.02em;color:${ACCENT};">${escapeHtml(options.productName)}</td></tr>
<tr><td style="padding:12px 32px 8px;"><h1 style="margin:0 0 16px;font-size:21px;line-height:28px;color:${INK};">${escapeHtml(content.heading)}</h1>
${content.blocks.map(blockHtml).join('\n')}
</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid ${BORDER};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(options.footer)}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  const text = [content.heading, '', ...content.blocks.map(blockText).flatMap((t) => [t, '']), '—', options.footer].join('\n');

  return { subject: content.subject, html, text };
}
