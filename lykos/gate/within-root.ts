/**
 * T30.2's hard boundary, apart from the gate: `approval.ts` loads Pi's tools, and the engine server, which only asks
 * whether a path is inside a root, would pay two seconds of startup for them.
 */
import { isAbsolute, relative, resolve } from "node:path";

/** T30.2's hard boundary: never asked about, always enforced. */
export function isWithinRoot(root: string, target: string): boolean {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (targetResolved === rootResolved) return true;
  const rel = relative(rootResolved, targetResolved);
  // D17: a parent step is a whole `..` SEGMENT. A string-prefix test refused
  // `<root>/..cache/x`, which is inside the root, with a reason that is false.
  return rel !== "" && rel !== ".." && !/^\.\.[\\/]/.test(rel) && !isAbsolute(rel);
}
