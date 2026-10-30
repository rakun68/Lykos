/** Converts a glob pattern to a RegExp. Handles **, *, ?, and common file patterns. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, "/");
  let regex = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (!c) break;
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          regex += "(?:^|.*/)";
          i += 3;
          continue;
        } else if (i + 2 === p.length) {
          regex += ".*";
          i += 2;
          continue;
        } else {
          regex += ".*";
          i += 2;
          continue;
        }
      } else {
        regex += "[^/]*";
        i += 1;
        continue;
      }
    } else if (c === "/") {
      if (p.slice(i, i + 3) === "/**") {
        regex += "(?:/.*)?";
        i += 3;
        continue;
      }
      regex += "/";
      i += 1;
      continue;
    } else if (c === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    } else if ("()+{}^$|.[].\\".includes(c)) {
      regex += "\\" + c;
      i += 1;
      continue;
    } else {
      regex += c;
      i += 1;
      continue;
    }
  }
  return new RegExp(`^${regex}$`);
}

/** Matches a relative path against a glob pattern. */
export function matchGlob(relPath: string, pattern: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const regex = globToRegExp(pattern);
  if (regex.test(norm)) return true;
  // If pattern has no directory slashes, test against basename
  if (!pattern.includes("/")) {
    const base = norm.split("/").pop() ?? norm;
    if (regex.test(base)) return true;
  }
  return false;
}

/** Matches a relative path against any of the given glob patterns. */
export function matchAnyGlob(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchGlob(relPath, p));
}
