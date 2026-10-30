// Authentication failure formatting (ADR-0025).
//
// Formats authentication failure messages for:
// - an environment variable: `credential in <VAR> was present and refused`
// - a list of credential labels: `credentials <label1>, <label2> were present and refused (first error: ...)`
//   (or singular `credential <label> was present and refused (first error: ...)`).

export function formatAuthenticationFailure(
  provider: string,
  target: string | string[],
  firstError?: string,
): string {
  if (Array.isArray(target)) {
    const labelsText =
      target.length === 1 ? `credential ${target[0]} was` : `credentials ${target.join(", ")} were`;
    const firstErrSuffix = firstError ? ` (first error: ${firstError})` : "";
    return `lykos: authentication failure for provider "${provider}" — ${labelsText} present and refused${firstErrSuffix}`;
  }
  const firstErrSuffix = firstError ? ` (first error: ${firstError})` : "";
  return `lykos: authentication failure for provider "${provider}" — credential in ${target} was present and refused${firstErrSuffix}`;
}
