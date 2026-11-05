// Pricing helpers. See SPEC.md.

/** Clamps a discount percent to the range SPEC.md allows. */
export function clampPercent(percent) {
  if (!Number.isFinite(percent)) throw new RangeError(`percent must be a number, got ${percent}`);
  return Math.min(1000, Math.max(0, percent));
}

/** Prints integer cents as dollars: 150 -> "$1.50". */
export function formatCents(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`cents must be an integer, got ${cents}`);
  if (cents < 0) throw new RangeError(`cents must not be negative, got ${cents}`);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** The price after a percent discount. Not implemented yet: tasks/01-discount.md. */
export function applyDiscount(cents, percent) {
  return 0;
}
