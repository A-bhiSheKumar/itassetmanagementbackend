export {
  NotificationModel,
  NOTIFICATION_TYPES,
  type Notification,
  type NotificationType,
} from './notification.model.js';
export {
  notify,
  listForRecipient,
  unreadCount,
  markRead,
  markAllRead,
  currentRecipientId,
  type NotifyInput,
} from './notification.service.js';
export {
  getEmailTransport,
  setEmailTransport,
  recordingTransport,
  RecordingEmailTransport,
  type EmailTransport,
  type EmailMessage,
} from './channels.js';
export { notificationRoutes } from './notification.routes.js';
