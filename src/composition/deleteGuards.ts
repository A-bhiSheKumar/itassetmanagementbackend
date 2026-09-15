import { setPersonDeleteGuard } from '../modules/people/index.js';
import { AssignmentModel } from '../modules/assignments/index.js';
import { AssetModel } from '../modules/assets/index.js';
import { addVendorDeleteGuard } from '../modules/vendors/index.js';
import { MaintenanceModel } from '../modules/maintenance/index.js';
import { LicenceModel, LicenceSeatModel } from '../modules/licences/index.js';

/**
 * Refusals a module cannot make on its own.
 *
 * People are depended on by assignments, so the people module cannot ask
 * whether someone still holds equipment. Composition sits above both and
 * answers for it.
 */
export function wireDeleteGuards(): void {
  setPersonDeleteGuard(async (personId) => {
    const [holding, seats] = await Promise.all([
      AssignmentModel.countDocuments({ assigneeType: 'person', assigneeId: personId, status: 'active' }),
      LicenceSeatModel.countDocuments({ assigneeType: 'person', assigneeId: personId, revokedAt: null }),
    ]);
    return [
      { type: 'asset they still hold', count: holding },
      { type: 'licence seat', count: seats },
    ];
  });

  addVendorDeleteGuard(async (vendorId) => {
    const [assets, maintenance, licences] = await Promise.all([
      AssetModel.countDocuments({ 'purchase.vendorId': vendorId }),
      MaintenanceModel.countDocuments({ vendorId }),
      LicenceModel.countDocuments({ vendorId }),
    ]);
    return [
      { type: 'asset bought from them', count: assets },
      { type: 'maintenance record', count: maintenance },
      { type: 'licence', count: licences },
    ];
  });
}
