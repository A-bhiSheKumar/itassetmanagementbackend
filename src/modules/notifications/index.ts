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
export { notificationRoutes } from './notification.routes.js';
