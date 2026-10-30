// T210 (issue #66, ADR-0042) — unified path rules: allow | ask | deny per path, deny wins.

import { realpathSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";

export type PathAccess = "read" | "write";
export type PathDecision = "allow" | "ask" | "deny";

export interface PathRule {
  pattern: string;
  access: PathAccess;
  decision: PathDecision;
  source: string;
  protected?: boolean;
  /** A `!` exception that may cancel only protected (ask) rules, never a deny: Lykos's own worktrees and memory. */
  protectedOnly?: boolean;
}

export interface PathContext {
  cwd: string;
  home: string;
  extraDirs: readonly string[];
  outside: { read: PathDecision; write: PathDecision };
}

export type RawPathRules = {
  read?: Record<string, PathDecision>;
  write?: Record<string, PathDecision>;
  remove?: string[];
  secret_paths?: string[];
};

export interface PathDecisionResult {
  decision: PathDecision;
  rule?: string;
  reason?: string;
  protected?: boolean;
}

export interface ContainmentPathPlan {
  secretPatterns: string[];
  protectedDirs: string[];
  secretExceptions: string[];
}

export function shippedPathRules(): PathRule[] {
  const secretPatterns = [
    "*.env",
    "*.env.*",
    ".npmrc",
    "*.pem",
    "*.key",
    "id_*",
    "~/.ssh/**",
    "~/.aws/**",
    "~/.gnupg/**",
    "~/.netrc",
    "~/.docker/config.json",
    "~/.config/gh/**",
    "~/.lykos/credentials.db*",
  ];
  const rules: PathRule[] = [];
  for (const pattern of secretPatterns) {
    rules.push({ pattern, access: "read", decision: "deny", source: "shipped" });
    rules.push({ pattern, access: "write", decision: "deny", source: "shipped" });
  }
  // .env.example stays readable and writable
  rules.push({ pattern: "!*.env.example", access: "read", decision: "allow", source: "shipped" });
  rules.push({ pattern: "!*.env.example", access: "write", decision: "allow", source: "shipped" });

  const protectedDirs = [
    ".git/**",
    ".config/git/**",
    ".vscode/**",
    ".idea/**",
    ".husky/**",
    ".cargo/**",
    ".devcontainer/**",
    ".yarn/**",
    ".mvn/**",
    ".lykos/**",
    ".pi/**",
    ".github/workflows/**",
    "~/.lykos/**",
  ];
  for (const pattern of protectedDirs) {
    rules.push({ pattern, access: "write", decision: "ask", source: "shipped", protected: true });
  }
  // Protected write exceptions: Lykos worktrees and memory files
  rules.push({ pattern: "!~/.lykos/worktrees/**", access: "write", decision: "allow", source: "shipped", protectedOnly: true });
  rules.push({ pattern: "!~/.lykos/memory/**", access: "write", decision: "allow", source: "shipped", protectedOnly: true });
  rules.push({ pattern: "!.lykos/memory/**", access: "write", decision: "allow", source: "shipped", protectedOnly: true });

  // Lykos memory writes are allowed without asking (even outside the working directory)
  rules.push({ pattern: "~/.lykos/memory/**", access: "write", decision: "allow", source: "shipped" });
  rules.push({ pattern: ".lykos/memory/**", access: "write", decision: "allow", source: "shipped" });

  return rules;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** A secret pattern as the container sees it: relative to the workspace, or undefined when it lies outside. */
function workspacePattern(pattern: string, ctx: PathContext | undefined): string | undefined {
  if (pattern.startsWith("~/")) return undefined; // the home directory is not in the workspace
  const isAbsolute = pattern.startsWith("/") || /^[A-Za-z]:[\/]/.test(pattern);
  if (!isAbsolute || ctx === undefined) return pattern;
  const isWindows = isWindowsShape(ctx, pattern);
  const rel = getRelativePath(normalizeSlash(pattern), ctx.cwd, isWindows);
  return rel === undefined || rel === "" ? undefined : rel;
}

/**
 * What the container shadows and protects, from the same rules the host decides by.
 * An exception is honoured only when it cancels a deny of its own source (ADR-0042) and no deny
 * from another source names the same files, so a user's deny is never unshadowed by a shipped `!`.
 */
export function containmentPathPlan(
  rules: readonly PathRule[],
  ctx?: PathContext,
): ContainmentPathPlan {
  const secretPatterns: string[] = [];
  const protectedDirs: string[] = [];
  const secretExceptions: string[] = [];
  const denies = rules.filter((r) => r.access === "read" && r.decision === "deny" && !r.pattern.startsWith("!"));

  for (const r of denies) {
    const p = workspacePattern(r.pattern, ctx);
    if (p !== undefined && !secretPatterns.includes(p)) secretPatterns.push(p);
  }
  for (const r of rules) {
    if (r.access === "write" && r.protected === true && !r.pattern.startsWith("~/")) {
      const dir = r.pattern.replace(/\/\*\*$|\/\*$|\/$/, "");
      if (dir.length > 0 && !protectedDirs.includes(dir)) protectedDirs.push(dir);
    }
  }

  const probe: PathContext = ctx ?? { cwd: "/", home: "/", extraDirs: [], outside: { read: "ask", write: "ask" } };
  for (const neg of rules) {
    if (neg.access !== "read" || !neg.pattern.startsWith("!")) continue;
    const p = neg.pattern.slice(1);
    if (secretExceptions.includes(p)) continue;
    const cancelsOwn = denies.some((d) => d.source === neg.source && negationAppliesToRule(neg, d));
    const namedByOther = denies.some(
      (d) =>
        d.source !== neg.source &&
        (d.pattern === p ||
          (!GLOB_CHARS.test(d.pattern) && matchesRule(p, d.pattern.startsWith("/") ? d.pattern : `/${d.pattern}`, probe, false))),
    );
    if (cancelsOwn && !namedByOther) secretExceptions.push(p);
  }

  return { secretPatterns, protectedDirs, secretExceptions };
}

export function collectPathRules(
  layers: { global?: RawPathRules; project?: RawPathRules },
  trusted: boolean,
): PathRule[] {
  let shipped = shippedPathRules();
  if (layers.global?.remove && layers.global.remove.length > 0) {
    const toRemove = new Set(layers.global.remove);
    shipped = shipped.filter(
      (r) =>
        !toRemove.has(r.pattern) &&
        !(toRemove.has("~/.lykos/credentials.db") && r.pattern.startsWith("~/.lykos/credentials.db")),
    );
  }
  if (layers.project?.remove && layers.project.remove.length > 0) {
    process.stderr.write(
      "lykos: path_rules.remove in project config is ignored; shipped rules can only be removed from global config\n",
    );
  }

  const rules: PathRule[] = [...shipped];

  if (layers.global) {
    if (layers.global.secret_paths) {
      for (const pattern of layers.global.secret_paths) {
        rules.push({ pattern, decision: "deny", access: "read", source: "global" });
        rules.push({ pattern, decision: "deny", access: "write", source: "global" });
      }
    }
    for (const [pattern, decision] of Object.entries(layers.global.read ?? {})) {
      rules.push({ pattern, decision, access: "read", source: "global" });
    }
    for (const [pattern, decision] of Object.entries(layers.global.write ?? {})) {
      rules.push({ pattern, decision, access: "write", source: "global" });
    }
  }

  if (layers.project) {
    if (layers.project.secret_paths) {
      for (const pattern of layers.project.secret_paths) {
        rules.push({ pattern, decision: "deny", access: "read", source: "project" });
        rules.push({ pattern, decision: "deny", access: "write", source: "project" });
      }
    }
    for (const [pattern, decision] of Object.entries(layers.project.read ?? {})) {
      if (!trusted && decision === "allow") continue;
      rules.push({ pattern, decision, access: "read", source: "project" });
    }
    for (const [pattern, decision] of Object.entries(layers.project.write ?? {})) {
      if (!trusted && decision === "allow") continue;
      rules.push({ pattern, decision, access: "write", source: "project" });
    }
  }

  return rules;
}

function isWindowsShape(ctx: PathContext, path: string): boolean {
  if (process.platform === "win32") return true;
  if (/^[A-Za-z]:/.test(ctx.cwd) || (ctx.home !== undefined && /^[A-Za-z]:/.test(ctx.home)) || /^[A-Za-z]:/.test(path)) return true;
  if (ctx.cwd.includes("\\") || ctx.home?.includes("\\") || path.includes("\\")) return true;
  return false;
}

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function patternToRegex(pattern: string, isWindows: boolean): RegExp {
  let p = pattern.replace(/\\/g, "/");
  if (p.endsWith("/")) {
    p = p + "**";
  }
  let regex = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === undefined) break;
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          if (i === 0) {
            regex += "(?:^|.*/)";
            i += 3;
            continue;
          } else {
            regex += "(?:/.+)?/";
            i += 3;
            continue;
          }
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
  return new RegExp(`^${regex}$`, isWindows ? "i" : undefined);
}

function isInside(path: string, root: string, isWindows: boolean): boolean {
  let p = normalizeSlash(path).replace(/\/+$/, "");
  let r = normalizeSlash(root).replace(/\/+$/, "");
  if (isWindows) {
    p = p.toLowerCase();
    r = r.toLowerCase();
  }
  return p === r || p.startsWith(r + "/");
}

function getRelativePath(path: string, cwd: string, isWindows: boolean): string | undefined {
  const p = normalizeSlash(path);
  const c = normalizeSlash(cwd).replace(/\/+$/, "");
  if (isWindows) {
    if (p.length >= 2 && p[1] === ":" && c.length >= 2 && c[1] === ":") {
      if (p[0]!.toLowerCase() !== c[0]!.toLowerCase()) return undefined;
    }
    const pLower = p.toLowerCase();
    const cLower = c.toLowerCase();
    if (pLower === cLower) return "";
    if (pLower.startsWith(cLower + "/")) {
      return p.slice(c.length + 1);
    }
    return undefined;
  }
  if (p === c) return "";
  if (p.startsWith(c + "/")) {
    return p.slice(c.length + 1);
  }
  return undefined;
}

export function matchesRule(rawPattern: string, absPath: string, ctx: PathContext, isWindows: boolean = false): boolean {
  let pat = rawPattern.startsWith("!") ? rawPattern.slice(1) : rawPattern;
  pat = normalizeSlash(pat);
  if (pat.startsWith("~/")) {
    pat = normalizeSlash(ctx.home).replace(/\/+$/, "") + "/" + pat.slice(2);
  }

  const hasSlash = pat.includes("/");
  if (!hasSlash) {
    const base = absPath.split("/").pop() ?? "";
    return patternToRegex(pat, isWindows).test(base);
  }

  const isAbsolute = pat.startsWith("/") || /^[A-Za-z]:\//.test(pat);
  if (isAbsolute) {
    return patternToRegex(pat, isWindows).test(absPath);
  }

  const rel = getRelativePath(absPath, ctx.cwd, isWindows);
  if (rel === undefined) return false;
  return patternToRegex(pat, isWindows).test(rel);
}

function getRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    let cur = dirname(p);
    while (cur && cur !== dirname(cur)) {
      try {
        const real = realpathSync(cur);
        const rel = relative(cur, p);
        return resolve(real, rel);
      } catch {
        cur = dirname(cur);
      }
    }
    return undefined;
  }
}

function negationAppliesToRule(neg: PathRule, posRule: PathRule): boolean {
  // A protected-only exception (Lykos worktrees, memory) never cancels a deny, whatever its pattern says.
  if (neg.protectedOnly === true && posRule.protected !== true) return false;
  const cleanNeg = neg.pattern.startsWith("!") ? neg.pattern.slice(1) : neg.pattern;
  const posPattern = posRule.pattern;
  if (cleanNeg === posPattern) {
    if (posRule.decision === "allow") return false;
    return true;
  }


  // If pos is a directory glob like "dir/**" or "dir/*"
  if (posPattern.includes("/") && (posPattern.endsWith("/**") || posPattern.endsWith("/*"))) {
    const posDir = posPattern.replace(/\/\*\*?$/, "");
    const cleanNegDir = cleanNeg.replace(/\/\*\*?$/, "");
    if (cleanNegDir === posDir || cleanNeg.startsWith(posDir + "/")) {
      return true;
    }
  }

  // If pos is a glob pattern like "*.env*" and cleanNeg matches it (e.g. "*.env.example" matches "*.env*" or "*.env")
  try {
    const regex = patternToRegex(posPattern, false);
    if (regex.test(cleanNeg) || regex.test(cleanNeg.replace(/^\*+/, "dummy"))) {
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function decideSinglePath(
  absPath: string,
  access: PathAccess,
  rules: readonly PathRule[],
  ctx: PathContext,
  isWindows: boolean,
): PathDecisionResult {
  const matchingAccessRules = rules.filter((r) => r.access === access);

  const matchedNegations = matchingAccessRules.filter(
    (r) => r.pattern.startsWith("!") && matchesRule(r.pattern, absPath, ctx, isWindows),
  );

  const matchedPositive: PathRule[] = [];
  for (const r of matchingAccessRules) {
    if (!r.pattern.startsWith("!") && matchesRule(r.pattern, absPath, ctx, isWindows)) {
      const isNegated = matchedNegations.some(
        (neg) => neg.source === r.source && negationAppliesToRule(neg, r),
      );
      if (!isNegated) {
        matchedPositive.push(r);
      }
    }
  }

  const denyRule = matchedPositive.find((r) => r.decision === "deny");
  if (denyRule) {
    return {
      decision: "deny",
      rule: denyRule.pattern,
      reason: `denied: secret path \`${denyRule.pattern}\``,
    };
  }

  const askRule = matchedPositive.find((r) => r.decision === "ask");
  if (askRule) {
    const isProtected = matchedPositive.some((r) => r.protected === true);
    return {
      decision: "ask",
      rule: askRule.pattern,
      ...(isProtected ? { protected: true } : {}),
    };
  }

  const allowRule = matchedPositive.find((r) => r.decision === "allow");
  if (allowRule) {
    return {
      decision: "allow",
      rule: allowRule.pattern,
    };
  }

  if (isInside(absPath, ctx.cwd, isWindows) || ctx.extraDirs.some((d) => isInside(absPath, d, isWindows))) {
    return { decision: "allow" };
  }

  return { decision: ctx.outside[access] };
}

function stricterDecision(a: PathDecisionResult, b: PathDecisionResult): PathDecisionResult {
  if (a.decision === "deny") return a;
  if (b.decision === "deny") return b;
  if (a.decision === "ask") {
    if (b.decision === "ask") {
      return a.protected || b.protected ? { ...a, protected: true } : a;
    }
    return a;
  }
  if (b.decision === "ask") return b;
  return a;
}

export function decidePath(
  path: string,
  access: PathAccess,
  rules: readonly PathRule[],
  ctx: PathContext,
): PathDecisionResult {
  const isWindows = isWindowsShape(ctx, path);
  let p = normalizeSlash(path);
  const isAbsolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  if (!isAbsolute) {
    const cwdNorm = normalizeSlash(ctx.cwd).replace(/\/+$/, "");
    p = `${cwdNorm}/${p}`;
  }
  // Collapse "." and ".." before any rule or inside-check sees the path, so
  // "<cwd>/../../etc/x" is judged where it points rather than by its prefix.
  p = posix.normalize(p);

  const result1 = decideSinglePath(p, access, rules, ctx, isWindows);

  const real = getRealpath(p);
  if (real !== undefined) {
    const realNorm = normalizeSlash(real);
    if (realNorm !== p) {
      const result2 = decideSinglePath(realNorm, access, rules, ctx, isWindows);
      return stricterDecision(result1, result2);
    }
  }

  return result1;
}
