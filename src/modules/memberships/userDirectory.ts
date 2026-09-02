/**
 * A port, because the dependency only runs one way.
 *
 * A staff list has to show names, and names live in `identity`. But identity
 * already depends on memberships — signing in means listing the organisations
 * a user belongs to — so memberships importing identity back would put the two
 * modules in a cycle and the boundary would be gone.
 *
 * So memberships declares what it needs and composition supplies it, exactly as
 * `core` declares `PermissionResolver` and gets an implementation wired in at
 * boot. The arrow still points from identity to memberships; this is the
 * interface memberships owns.
 */

export interface UserIdentity {
  name: string;
  email: string;
}

export interface UserDirectory {
  namesFor(userIds: string[]): Promise<Map<string, UserIdentity>>;
}

/**
 * Resolves nothing until something is wired in.
 *
 * Deliberately empty rather than throwing: an unwired directory should degrade
 * to "no name available", which the console already renders honestly, not take
 * down the members endpoint. The wiring is asserted at boot instead.
 */
let directory: UserDirectory = { namesFor: async () => new Map() };

export function setUserDirectory(next: UserDirectory): void {
  directory = next;
}

export function userDirectory(): UserDirectory {
  return directory;
}
