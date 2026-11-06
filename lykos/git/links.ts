// G7 (T254): removing a worktree never follows a link. A worktree Lykos made may hold a link to the main checkout
// (the `node_modules` junction the red check makes) or one a test made; a recursive removal that follows it deletes
// what it points at. Every link under the tree is unlinked first, without following any, and a link that will not
// go keeps the tree in place.

import { lstatSync, readdirSync, rmdirSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** Unlinks every symbolic link and junction under `dir`, never descending through one. Returns those that stayed. */
export function unlinkLinksUnder(dir: string): string[] {
  const stayed: string[] = [];
  const walk = (folder: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      let isLink: boolean;
      let isDir: boolean;
      try {
        const st = lstatSync(path);
        isLink = st.isSymbolicLink();
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      if (isLink) {
        try {
          unlinkSync(path);
        } catch {
          // A directory symlink on Windows is removed as a directory, which removes the link and not its target.
          try {
            rmdirSync(path);
          } catch {
            stayed.push(path);
          }
        }
      } else if (isDir) {
        walk(path);
      }
    }
  };
  walk(dir);
  return stayed;
}
