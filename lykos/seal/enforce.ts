// T232 (spec decision 11): who the seal guard is enforced against.
//
// Every writable specialist is enforced except the ones that write sealed tests (`seal.writers`). A read-only
// specialist cannot change a file, so it has nothing to be guarded from. `seal.enforce_for` is deprecated: its names
// are honoured as extra enforced names, which is what it always meant, and it is reported once so it can be removed.

export interface SealEnforcementInput {
  specialist: string;
  /** The session cannot change files (`read_only` specialist, or a read-only child). */
  readOnly?: boolean | undefined;
  /** `seal.writers`. */
  writers: readonly string[];
  /** `seal.enforce_for`, deprecated. */
  enforceFor: readonly string[];
}

export function sealEnforced(input: SealEnforcementInput): boolean {
  if (input.enforceFor.includes(input.specialist)) return true;
  return input.readOnly !== true && !input.writers.includes(input.specialist);
}

/** The warning a project that still sets `seal.enforce_for` gets; undefined when it does not. */
export function enforceForDeprecation(enforceFor: readonly string[]): string | undefined {
  if (enforceFor.length === 0) return undefined;
  return (
    `lykos: seal.enforce_for is deprecated and still honoured (${enforceFor.join(", ")}): every writable specialist ` +
    `except seal.writers is now enforced, so the key can be removed`
  );
}
