export { DocumentModel, type DocumentRecord, type DocumentRecordDocument } from './document.model.js';
export {
  presignUpload,
  confirmUpload,
  listDocuments,
  downloadUrl,
  deleteDocument,
  restoreDocument,
  purgeDeletedDocuments,
  sweepAbandonedUploads,
  type PresignInput,
} from './document.service.js';
export { documentRoutes } from './document.routes.js';
