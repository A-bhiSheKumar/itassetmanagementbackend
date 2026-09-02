import { UserModel } from '../modules/identity/index.js';
import { setUserDirectory } from '../modules/memberships/index.js';

/**
 * Supplies memberships with the one thing it needs from identity.
 *
 * Composition is the only layer allowed to know about both, which is what keeps
 * the modules pointing one way. One batched lookup, never one per row.
 */
export function wireUserDirectory(): void {
  setUserDirectory({
    async namesFor(userIds) {
      if (userIds.length === 0) return new Map();

      const users = await UserModel.find({ _id: { $in: [...new Set(userIds)] } })
        .select('name email')
        .lean();

      return new Map(users.map((u) => [String(u._id), { name: u.name, email: u.email }]));
    },
  });
}
