export {
  sendEmail,
  deliverEmail,
  recordDeliveryEvent,
  isSuppressed,
  getEmailTransport,
  setEmailTransport,
  recordingTransport,
  type SendEmailInput,
  type SendEmailResult,
} from './email.service.js';
export { EmailMessageModel, SuppressionModel, type EmailStatus } from './email.model.js';
export { RecordingTransport, ResendTransport, type EmailTransport, type OutgoingEmail } from './transport.js';
export { render, escapeHtml, type Block, type EmailContent } from './render.js';
export { buildContent, absolute, SENSITIVE_TEMPLATES, type TemplateName, type TemplatePayloads } from './templates.js';
export { verifySvixSignature } from './webhook.js';
export { emailWebhookRoutes } from './email.routes.js';
