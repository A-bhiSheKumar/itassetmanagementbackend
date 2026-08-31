export {
  getStorage,
  setStorage,
  buildStorageKey,
  LocalStorageAdapter,
  type StorageAdapter,
  type PresignedUpload,
  type StoredObject,
} from './storage.adapter.js';
export {
  verifyMagicBytes,
  extensionOf,
  ALLOWED_EXTENSIONS,
  type VerificationResult,
} from './fileTypes.js';
