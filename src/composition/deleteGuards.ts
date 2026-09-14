import { setPersonDeleteGuard } from '../modules/people/index.js';
import { AssignmentModel } from '../modules/assignments/index.js';

/**
 * Refusals a module cannot make on its own.
 *
 * People are depended on by assignments, so the people module cannot ask
 * whether someone still holds equipment. Composition sits above both and
 * answers for it.
 */
export function wireDeleteGuards(): void {
  setPersonDeleteGuard(async (personId) => {
    const holding = await AssignmentModel.countDocuments({ assigneeType: 'person', assigneeId: personId, status: 'active' });
    return [{ type: 'asset they still hold', count: holding }];
  });
}
