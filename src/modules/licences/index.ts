export {
  LicenceModel,
  LicenceSeatModel,
  LICENCE_TYPES,
  BILLING_CYCLES,
  type Licence,
  type LicenceDocument,
  type LicenceSeat,
} from './licence.model.js';
export {
  listLicences,
  findLicence,
  createLicence,
  updateLicence,
  deleteLicence,
  revealKey,
  allocateSeat,
  revokeSeat,
  revokeAllSeatsFor,
  seatsOn,
  seatsFor,
} from './licence.service.js';
export { licenceRoutes, personLicenceRoutes } from './licence.routes.js';
