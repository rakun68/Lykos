// Dependency-rule scan against the target module map. Each rule is encoded
// with a pending state naming the work that turns it green.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type RuleId =
  | "no-domain-imports-cli"
  | "tui-through-agent-ui-seam"
  | "only-ledger-opens-database"
  | "only-boundary-names-pi-paths"
  | "no-core-directory"
  | "only-pi-host-names-home-pi-agent";

export type RuleStatus = "green" | "pending";

export interface RuleSpec {
  id: RuleId;
  name: string;
  status: RuleStatus;
  /** Ticket that turns a pending rule green (absent when already green). */
  greenTicket?: string;
}

export const DEPENDENCY_RULES: readonly RuleSpec[] = [
  {
    id: "no-domain-imports-cli",
    name: "No domain module imports cli/",
    status: "green",
  },
  {
    id: "tui-through-agent-ui-seam",
    name: "tui/ is entered only through the AgentUi seam",
    status: "green",
  },
  {
    id: "only-ledger-opens-database",
    name: "Only ledger/ opens the ledger database",
    status: "green",
  },
  {
    id: "only-boundary-names-pi-paths",
    name: "Only boundary modules name .pi/ paths",
    status: "green",
  },
  {
    id: "no-core-directory",
    name: "Nothing named core/ exists",
    status: "green",
  },
  {
    id: "only-pi-host-names-home-pi-agent",
    name: "Only config/pi-host.ts builds ~/.pi/agent",
    status: "green",
  },
] as const;

export interface ParsedImport {
  specifier: string;
  line: number;
}

export interface Violation {
  file: string;
  import?: string;
  line: number;
  rule: RuleId;
  detail: string;
}

/** Top-level segment under `lykos/`. */
export function targetTopLevel(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/")[0] ?? "";
}

/** Domain-shaped modules in the target map (everything under lykos/ except cli/). */
export function isDomainModule(relativePath: string): boolean {
  const top = targetTopLevel(relativePath);
  if (top === "cli" || top === "rearchitecture") return false;
  if (relativePath === "cli.ts") return false;
  return true;
}

/** Boundary modules that may name Lykos-managed `.pi/` workspace paths. */
export const BOUNDARY_MODULES = new Set([
  "config/extensions.ts",
  "config/providers.ts",
  "config/scaffold.ts",
  "cli/doctor.ts",
]);

/** Agent-facing tool schema prose — not Lykos constructing runtime paths. */
export const PI_PATH_PROSE_EXEMPT = new Set(["ledger/tool-catalog.ts"]);

const IMPORT_FROM =
  /(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const LEDGER_OPEN_APIS = /\b(openLedgerWithRetry|Ledger\.open)\s*\(/;
const BETTER_SQLITE_IMPORT = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]better-sqlite3['"]/;

const PI_WORKSPACE_PATH = /\.pi\/(?:agents|workflows)\b/;

/**
 * P14 ticket 08 (ADR-0027): Pi's agent directory is the Lykos pi-host, resolved
 * in one place. What this catches is a module BUILDING the old default —
 * `join(homedir(), ".pi", "agent")` or a path starting with a `".pi/agent"`
 * segment — not prose that mentions `~/.pi/agent`, and not the container's
 * absolute `/home/node/.pi/agent`, which is the container image's own path and stays.
 * Comments, line or block, are allowed.
 */
const HOME_PI_AGENT_DIR = /["'`]\.pi["'`]\s*,\s*["'`]agent\b|["'`]\.pi[\\/]agent\b/;

/** The resolver, which names the legacy directory only so `lykos doctor` can report it. */
export const PI_HOST_RESOLVER_MODULES = new Set(["config/pi-host.ts"]);

export function parseImportEdges(source: string): ParsedImport[] {
  const edges: ParsedImport[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    for (const pattern of [IMPORT_FROM, DYNAMIC_IMPORT]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        edges.push({ specifier: match[pattern === IMPORT_FROM ? 1 : 1]!, line: index + 1 });
      }
    }
  });
  return edges;
}

/** Resolve a relative import specifier to a lykos-relative `.ts` path. */
export function resolveImportPath(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const withoutJs = specifier.replace(/\.js$/, "");
  const parts = dirname(fromFile.replace(/\\/g, "/")).split("/").filter(Boolean);
  for (const segment of withoutJs.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  let resolved = parts.join("/");
  if (!resolved.endsWith(".ts")) resolved = `${resolved}.ts`;
  return resolved;
}

function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

function isTuiScreenInternal(importPath: string): boolean {
  return importPath.replace(/\\/g, "/").startsWith("tui/screen/");
}

function isCliImport(importPath: string): boolean {
  const normalized = importPath.replace(/\\/g, "/");
  return normalized === "cli.ts" || normalized.startsWith("cli/");
}

function importerInsideTui(file: string): boolean {
  return file.replace(/\\/g, "/").startsWith("tui/");
}

function isLedgerModule(file: string): boolean {
  return file.replace(/\\/g, "/").startsWith("ledger/");
}

/**
 * P14 ticket 02 (ADR-0025): the credential store is its own user-level SQLite
 * file, so credentials/ may import better-sqlite3. It still may not open the
 * ledger: LEDGER_OPEN_APIS applies to it like any other module.
 */
function mayImportSqlite(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  return f.startsWith("ledger/") || f.startsWith("credentials/");
}

export function scanFile(relativePath: string, source: string): Violation[] {
  const file = relativePath.replace(/\\/g, "/");
  const violations: Violation[] = [];

  for (const edge of parseImportEdges(source)) {
    const importPath = resolveImportPath(file, edge.specifier);
    if (!importPath) continue;

    if (isDomainModule(file) && isCliImport(importPath)) {
      violations.push({
        file,
        import: edge.specifier,
        line: edge.line,
        rule: "no-domain-imports-cli",
        detail: `${file} imports ${edge.specifier}`,
      });
    }

    if (isTuiScreenInternal(importPath) && !importerInsideTui(file)) {
      violations.push({
        file,
        import: edge.specifier,
        line: edge.line,
        rule: "tui-through-agent-ui-seam",
        detail: `${file} imports tui/screen internal ${edge.specifier}`,
      });
    }
  }

  if (file.startsWith("core/")) {
    violations.push({
      file,
      line: 1,
      rule: "no-core-directory",
      detail: `${file} lives under core/`,
    });
  }

  if (!isLedgerModule(file)) {
    source.split("\n").forEach((rawLine, index) => {
      const line = stripLineComment(rawLine);
      if (LEDGER_OPEN_APIS.test(line)) {
        violations.push({
          file,
          line: index + 1,
          rule: "only-ledger-opens-database",
          detail: `${file} opens the ledger database`,
        });
      }
      if (BETTER_SQLITE_IMPORT.test(line) && !mayImportSqlite(file)) {
        violations.push({
          file,
          line: index + 1,
          rule: "only-ledger-opens-database",
          detail: `${file} imports better-sqlite3`,
        });
      }
    });
  }

  if (!BOUNDARY_MODULES.has(file) && !PI_PATH_PROSE_EXEMPT.has(file)) {
    source.split("\n").forEach((rawLine, index) => {
      const line = stripLineComment(rawLine);
      if (PI_WORKSPACE_PATH.test(line)) {
        violations.push({
          file,
          line: index + 1,
          rule: "only-boundary-names-pi-paths",
          detail: `${file} names a .pi/ workspace path`,
        });
      }
    });
  }

  if (!PI_HOST_RESOLVER_MODULES.has(file) && !PI_PATH_PROSE_EXEMPT.has(file)) {
    source.split("\n").forEach((rawLine, index) => {
      if (/^\s*(?:\/\*|\*)/.test(rawLine)) return;
      const line = stripLineComment(rawLine);
      if (HOME_PI_AGENT_DIR.test(line)) {
        violations.push({
          file,
          line: index + 1,
          rule: "only-pi-host-names-home-pi-agent",
          detail: `${file} builds ~/.pi/agent instead of asking config/pi-host.ts`,
        });
      }
    });
  }

  return violations;
}

export function walkProductionTs(rootDir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(rootDir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    if (entry === "fixtures") continue;
    const full = join(rootDir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(...walkProductionTs(full, rel));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (entry.endsWith("-acceptance.ts")) continue;
    out.push(rel);
  }
  return out;
}

export function scanProductionRoot(lykosRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const rel of walkProductionTs(lykosRoot)) {
    const source = readFileSync(join(lykosRoot, rel), "utf8");
    violations.push(...scanFile(rel, source));
  }
  return violations;
}

export function scanSources(files: Map<string, string>): Violation[] {
  const violations: Violation[] = [];
  for (const [path, source] of files) {
    violations.push(...scanFile(path, source));
  }
  return violations;
}

export function violationsForRule(violations: Violation[], ruleId: RuleId): Violation[] {
  return violations.filter((v) => v.rule === ruleId);
}

export function assertGreenRules(violations: Violation[]): void {
  for (const rule of DEPENDENCY_RULES) {
    if (rule.status !== "green") continue;
    const hits = violationsForRule(violations, rule.id);
    if (hits.length > 0) {
      const lines = hits.map((v) => formatViolation(v));
      throw new Error(`${rule.name} must stay green:\n${lines.join("\n")}`);
    }
  }
}

export function formatViolation(v: Violation): string {
  const importPart = v.import ? ` import ${v.import}` : "";
  return `${v.file}:${v.line}${importPart} — ${v.rule} — ${v.detail}`;
}

export function ruleSpec(ruleId: RuleId): RuleSpec {
  const spec = DEPENDENCY_RULES.find((r) => r.id === ruleId);
  if (!spec) throw new Error(`unknown rule ${ruleId}`);
  return spec;
}
