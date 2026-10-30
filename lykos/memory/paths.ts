import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryFile, MemoryScope } from "./entries.js";

export function memoryFilePath(cwd: string, scope: MemoryScope, file: MemoryFile): string {
  const root = scope === "project" ? join(cwd, ".lykos") : join(homedir(), ".lykos");
  return join(root, "memory", `${file}.md`);
}
