/** Display helpers with no I/O and no business logic — safe for any layer. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Whole days from now until `date`, in the tenant's zone.
 *
 * "Expires in 30 days" has to mean the same thing to a Sydney tenant and a Los
 * Angeles one, which it does not if you subtract UTC timestamps and divide.
 */
export function daysUntil(date: Date, from: Date = new Date()): number {
  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((startOfDay(date) - startOfDay(from)) / 86_400_000);
}
