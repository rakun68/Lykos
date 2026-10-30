// `lykos doctor` — automates the docs/04-phase0-tasks.md §T1 verifications so
// they are re-runnable rather than one-time (T3.5.4). Deliberately makes no
// API calls of its own: everything here is static (config, ledger schema,
// declared extensions) or a local container-runtime probe. The one thing that
// truly needs a live call — cache-read/cache-write actually arriving on the
// wire — is checked by a real run: its `calls` rows carry the split
// (`lykos show`).

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionsDir } from "../ledger/live.js";
import { writeResolvedConfigCache } from "../config/cache.js";
import { loadConfig } from "../config/load.js";
import {
  LYKOS_EXTENSIONS_KEY,
  resolveExtensions,
  resolveHostExtensions,
  type ResolvedExtension,
} from "../config/extensions.js";
import {
  HOST_INSTALL_FLAGS,
  hostAgentDir,
  hostInstallCommand,
  hostInstallPrefix,
  renderInstallCommand,
} from "../extensions/host-install.js";
import { gitStateReason, gitVersion } from "../git/host-git.js";
import { legacyPiAgentPackages, piHostDir } from "../config/pi-host.js";
import { defaultCredentialDbPath } from "../credentials/db.js";
import { poolSummary, summaryPoolSizes } from "../credentials/presence.js";
import type { ProvidersConfig } from "../config/types.js";
import { candidateDrivers, type ContainmentLevel } from "../containment/containment.js";
import type { ContainmentConfig } from "../config/types.js";
import type { ContainerRuntimeDriver, LimitedStart, RuntimeName } from "../containment/runtime.js";
import { currentPriceTable } from "../ledger/prices.js";

import { defaultLedgerPath, openLedgerSync, type Ledger } from "../ledger/use.js";

import { auditRegistry, defaultRegistryPath, resolveProject } from "../session/identity.js";
import { GITIGNORE_LINES } from "../config/scaffold.js";
import { resolveTranscriptFile, verifyTranscriptHash } from "../session/transcript.js";
import {
  catalogMeta,
  piDefaultBaseline,
  piDefaultPlusSubagentsBaseline,
  SCHEMA_TOKENS_BASIS,
} from "../ledger/tool-schema.js";
import { workerPlusHostMeasurement } from "../tools.js";
import { discoverPostEditCommand } from "../loop/post-edit.js";
import { discoverGateCommand } from "../gate/verify-gate.js";
import { listSkillFiles } from "../session/skills.js";
import { collect } from "../tui/collect.js";
import { derive } from "../tui/derive.js";
import { stdoutWrite } from "../tui/io-mode.js";
import { renderStderrLine } from "../tui/renderers/stderr.js";
import { renderS0 } from "../tui/renderers/conversation.js";
import { renderWatchFrame } from "../tui/renderers/watch.js";
import { resolveTheme } from "../tui/theme/resolve.js";
import { runCost } from "./cost.js";
import {
  providerMatrix,
  validateProviders,
  type ProviderMatrixRow,
} from "../config/providers.js";
import { redactSecrets } from "../ledger/redact.js";
import { pruneNotice, pruneRulesOn } from "../loop/tool-result-prune.js";
import { describeRetryPolicy, readRetryPolicy } from "../loop/retry-observer.js";
import { renderApp, type AppState, FrameWriter, type VtProbeResult } from "../tui/doctor-rendering.js";

export type Status = "ok" | "fail" | "warn";

export interface Check {
  status: Status;
  label: string;
}

const SYMBOL: Record<Status, string> = { ok: "✓", fail: "✗", warn: "⚠" };

export function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", ".."), join(here, "..", "..", "..")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`lykos doctor: could not locate repo root (looked in ${candidates.join(", ")})`);
}

/**
 * T97.4 — the declared `extensions:` block against THIS machine.
 *
 * A session runs on the host, out of the host's own agent dir, so an extension
 * can be declared and correctly pinned and still be absent: nothing installs
 * anything there until `lykos extensions install` runs.
 *
 * Reported as a WARN rather than a fail: the session still starts, so this is a
 * gap in what loads, not a broken configuration. Pure — `exists` is injected so
 * the check is testable.
 */
export function reconcileHostExtensions(
  resolution: { extensions: readonly ResolvedExtension[] },
  agentDir: string,
  exists: (path: string) => boolean,
): Check[] {
  const host = resolveHostExtensions(resolution.extensions, agentDir, exists);
  const checks: Check[] = [];
  for (const e of host.loaded) {
    checks.push({ status: "ok", label: `extension ${e.name}@${e.version} installed on this host (${e.path})` });
  }
  if (host.missing.length > 0) {
    checks.push({
      status: "warn",
      label:
        `declared but NOT installed on this host: ${host.missing.map((e) => `${e.name}@${e.version}`).join(", ")} — ` +
        `sessions run from ${agentDir} (Lykos's Pi host, ADR-0027) and will start without them ` +
        "(they say so on stderr). Install them with " +
        `\`lykos extensions install\`, or one by hand with ${missingInstallHint(host.missing[0]!, agentDir)}`,
    });
  }
  return checks;
}

/** The exact command that installs `ext` under `agentDir`, the one host install path renders. */
function missingInstallHint(ext: { name: string; version: string }, agentDir: string): string {
  return `\`${renderInstallCommand(hostInstallCommand(agentDir, { ...ext, path: "" }))}\``;
}

/**
 * T147 (D25): the `lykos_extensions:` block against this host. Same resolution
 * and the same install hint as the Pi list. A rejected declaration fails, as
 * the Pi list's does.
 */
export function reconcileHostLykosExtensions(
  resolution: { extensions: readonly ResolvedExtension[]; errors: readonly string[] },
  agentDir: string,
  exists: (path: string) => boolean,
): Check[] {
  const checks: Check[] = resolution.errors.map((err) => ({
    status: "fail" as const,
    label: `lykos extension declaration rejected: ${err}`,
  }));
  const host = resolveHostExtensions(resolution.extensions, agentDir, exists, "lykos");
  for (const e of host.loaded) {
    checks.push({ status: "ok", label: `lykos extension ${e.name}@${e.version} installed on this host (${e.path})` });
  }
  if (host.missing.length > 0) {
    checks.push({
      status: "warn",
      label:
        `lykos extension(s) declared but NOT installed on this host: ${host.missing
          .map((e) => `${e.name}@${e.version}`)
          .join(", ")} — sessions run from ${agentDir} and will start without them (they say so on stderr). ` +
        `Install them with \`lykos extensions install\`, or one by hand with ${missingInstallHint(host.missing[0]!, agentDir)}`,
    });
  }
  return checks;
}

/**
 * ADR-0027 (P14 ticket 08, D4): which directory Pi runs from, stated, and the
 * one consequence of the move a person cannot see for themselves — packages
 * they installed under the old `~/.pi/agent` are no longer loaded. Presence
 * only: the legacy directory's entry names are listed, nothing in it is read.
 * `home` is injected so the warning is testable against a seeded tmp home.
 */
export function checkPiHost(env: NodeJS.ProcessEnv, home: string = homedir()): Check[] {
  const dir = piHostDir(env);
  const checks: Check[] = [
    {
      status: "ok",
      label: `pi host: ${dir} — Pi's agent directory for every Lykos session (settings, extensions, skills), generated by Lykos (ADR-0027)`,
    },
  ];
  const legacy = legacyPiAgentPackages(home);
  if (legacy !== undefined && legacy.names.length > 0) {
    checks.push({
      status: "warn",
      label:
        `${legacy.names.length} package(s) installed under ${legacy.dir} are NO LONGER LOADED ` +
        `(${legacy.names.join(", ")}) — Lykos's Pi host is now ${dir}. To keep one, declare it in config.yaml \`extensions:\` ` +
        `with an exact version and install it there: npm install --prefix ${hostInstallPrefix(dir)} ${HOST_INSTALL_FLAGS.join(" ")} <name>@<version>`,
    });
  }
  return checks;
}

/** T188: whether the rules that are on have `lykos-prune` to run them. */
export function checkPruneExtension(
  compaction: { supersede_reads: boolean; drop_useless: boolean },
  extensions: ReadonlyArray<{ name: string }>,
): Check {
  const knobs = { supersedeReads: compaction.supersede_reads, dropUseless: compaction.drop_useless };
  const note = pruneNotice(knobs, extensions.map((e) => e.name));
  if (note !== undefined) return { status: "warn", label: note.replace(/^lykos: /, "") };
  if (!pruneRulesOn(knobs)) return { status: "ok", label: "tool-result pruning (T188): both rules are off in config" };
  return { status: "ok", label: "tool-result pruning (T188): lykos-prune is listed in extensions:" };
}

/**
 * T99/T100: what would actually run after an edit, and after the session.
 *
 * Reported because the whole point of both mechanisms is that they run
 * without being asked, and a mechanism that runs unasked and is invisible is
 * the abstraction this project has decided not to have (T28's finding). A
 * project with no discoverable command is an `ok` with a plain statement, not
 * a warning: it is a legitimate state, and it is what every session had
 * before Phase 12.
 *
 * Pure apart from the two discovery reads, which are the fact being reported.
 */
export function checkFeedbackLoop(
  cwd: string,
  feedback: { enabled: boolean; command: string },
  gate: { enabled: boolean; command: string },
  discover: { postEdit: (cwd: string) => string | undefined; gate: (cwd: string) => string | undefined },
): Check[] {
  const checks: Check[] = [];
  const postEditCmd = feedback.command.trim() || discover.postEdit(cwd);
  if (!feedback.enabled) {
    checks.push({ status: "warn", label: "post-edit check (T99) is disabled in config — edits are not checked" });
  } else if (postEditCmd === undefined) {
    checks.push({
      status: "ok",
      label:
        "post-edit check (T99): no command discovered for this project (no `typecheck` script, no tsconfig) — " +
        "set feedback.command in config.yaml to turn the loop on here",
    });
  } else {
    checks.push({ status: "ok", label: `post-edit check (T99): \`${postEditCmd}\` after every successful edit` });
  }

  const gateCmd = gate.command.trim() || discover.gate(cwd);
  if (!gate.enabled) {
    checks.push({
      status: "warn",
      label: "verification gate (T100) is disabled in config — no session will write outcome=success mechanically",
    });
  } else if (gateCmd === undefined) {
    checks.push({
      status: "ok",
      label:
        "verification gate (T100): no command discovered (no `test` script) — sessions fall back to the " +
        "session-end question, which records outcome_source=human",
    });
  } else {
    checks.push({
      status: "ok",
      label: `verification gate (T100): \`${gateCmd}\` once per editing session, recorded as verification_command`,
    });
  }
  return checks;
}

/**
 * T102: the skills roster in `.lykos/skills/`, zero-schema until read.
 *
 * T101's half of this check — whether the `ast-grep` binary was on this host,
 * for the `structural-search` skill that reached it through bash — was
 * deleted with that skill in T141. The `ast_grep` and `ast_edit` tools do its
 * job through `@ast-grep/napi`, which installs with Lykos, so there is no
 * host binary left for doctor to look for.
 */
export function checkSkills(skills: readonly string[]): Check {
  return {
    status: "ok",
    label:
      skills.length === 0
        ? "no skills in .lykos/skills/ — `lykos init` writes the shipped ones"
        : `${skills.length} skill(s) in .lykos/skills/: ${skills.join(", ")} (name + description ride the head; bodies load on read)`,
  };
}

export function checkCredentialPools(
  env: NodeJS.ProcessEnv = process.env,
  dbPath?: string,
  nowMs?: number,
): Check[] {
  const path = dbPath ?? defaultCredentialDbPath(env);
  const summary = poolSummary(path, nowMs ?? Date.now());
  if (summary.size === 0) {
    return [
      {
        status: "warn",
        label: redactSecrets(`no credentials in the Lykos store (${path})`),
      },
    ];
  }
  const providers = Array.from(summary.keys()).sort();
  const checks: Check[] = [];
  for (const provider of providers) {
    const counts = summary.get(provider)!;
    const status: Status = counts.enabled - counts.cooling === 0 ? "warn" : "ok";
    const label = redactSecrets(
      `credential pool ${provider}: ${counts.enabled} usable, ${counts.cooling} cooling, ${counts.disabled} disabled`,
    );
    checks.push({ status, label });
  }
  return checks;
}

/**
 * T36.4 (docs/13-model-access.md §6): reachable and priced are separate
 * columns. Presence of a credential, never its content — every label is
 * run through redactSecrets so a planted token cannot leak even if a
 * future edit interpolates one.
 */
export function formatProviderMatrixRow(row: ProviderMatrixRow): Check {
  const reachLabel =
    row.reach === "reachable" ? "reachable" : row.reach === "unreachable" ? "UNREACHABLE" : "reach unknown";
  const pricedLabel = row.priced ? "priced" : "UNPRICED";
  const overflow =
    row.overflowBilling === false
      ? " — overflow billing NOT enabled → requests stop when the pool empties"
      : row.overflowBilling === "unset"
        ? " — overflow billing unset → requests may stop when a credit pool empties"
        : row.overflowBilling === true
          ? " — overflow billing enabled"
          : "";
  const status: Status = row.reach === "unreachable" ? "warn" : "ok";
  const label = redactSecrets(
    `provider ${row.name}: ${reachLabel} (${row.auth}, ${row.reachReason}), ${pricedLabel} — ${row.priceNote}${overflow}`,
  );
  return { status, label };
}

/**
 * T170: is there a git binary at all? Checkpoints, project identity and the
 * repo map all need one, and without it they each fall back quietly. The
 * version string comes from `gitVersion()`; undefined means git is not on PATH.
 */
export function checkGit(version: string | undefined): Check {
  return version === undefined
    ? { status: "fail", label: `${gitStateReason("git-missing")} — checkpoints, project identity and the repo map are off` }
    : { status: "ok", label: `${version} found on PATH` };
}

/**
 * T83: report the transient-failure retry policy actually in force.
 *
 * Pi retries 429s, 5xx and dropped sockets by default — enabled, 3 attempts,
 * 2000ms base backoff — and Lykos neither configures nor owns that. The check
 * exists because the policy is invisible: nothing in `.lykos/` mentions it,
 * so a user who disabled retry in their global Pi settings would silently get
 * a much weaker agent with no indication why sessions started dying on rate
 * limits.
 *
 * Read-only on purpose. `SettingsManager.setRetryEnabled()` calls `save()`
 * and writes Pi's global settings. Since ADR-0027 that file is the generated
 * `<pi-host>/settings.json`, which carries no `retry` block, so Pi's own
 * defaults are what a session runs with and what this reports; a hand edit to
 * that file is still reported, and still never repaired here.
 */
export function checkRetryPolicy(env: NodeJS.ProcessEnv): Check {
  // P10.9 (ticket 21, D7): one resolver, shared with the host install path.
  // Two answers to "which directory does a declaration resolve against" is two
  // directories a person could be told about.
  const agentDir = hostAgentDir(env);
  const settingsPath = join(agentDir, "settings.json");
  let configured: { enabled?: unknown; maxRetries?: unknown; baseDelayMs?: unknown } | undefined;
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { retry?: Record<string, unknown> };
      configured = parsed?.retry;
    } catch {
      return {
        status: "warn",
        label: `pi settings at ${settingsPath} could not be parsed — transient-failure retry policy unknown`,
      };
    }
  }
  // No `retry` block is the overwhelmingly common case and is NOT a warning:
  // Pi's own defaults are good, and reporting them is the point.
  const view = readRetryPolicy(
    configured === undefined ? undefined : { getRetrySettings: () => configured as Record<string, unknown> },
  );
  return {
    status: view.enabled ? "ok" : "warn",
    label: view.enabled
      ? describeRetryPolicy(view)
      : `${describeRetryPolicy(view)} — a session will now die on a rate limit instead of waiting it out; re-enable it in ${settingsPath}`,
  };
}

export function checkProviderMatrix(
  providers: ProvidersConfig,
  env: NodeJS.ProcessEnv,
  poolSizesIn?: Map<string, number>,
): Check[] {
  const validation = validateProviders(providers);
  const checks: Check[] = [];
  for (const err of validation.errors) {
    checks.push({ status: "fail", label: redactSecrets(`provider declaration rejected: ${err}`) });
  }
  for (const warn of validation.warnings) {
    checks.push({ status: "warn", label: redactSecrets(warn) });
  }
  const poolSizes = poolSizesIn ?? summaryPoolSizes(poolSummary(defaultCredentialDbPath(env)));
  const rows = providerMatrix(providers, { env, poolSizes });
  if (rows.length === 0) {
    checks.push({
      status: "warn",
      label: "no providers declared in config.yaml — sessions will record auth_mode=unknown / unpriced",
    });
    return checks;
  }
  for (const row of rows) checks.push(formatProviderMatrixRow(row));
  return checks;
}

// T178 (spec #22 story 62): the container runtime containment would use. The
// probing is async and every check here is synchronous, so the caller probes
// (`probeContainerRuntimes`) and hands the reports in, as it does for VT.

export interface RuntimeReport {
  name: RuntimeName;
  probe: { available: true; version: string } | { available: false; reason: string };
  /** Present only for the runtime containment would pick, and only when it answered. */
  limited?: LimitedStart;
  podmanHost?: { rootless: boolean; cgroupManager: string };
}

/** Asks each candidate whether it answers; the first that does is also asked to start a limited container. */
export async function probeContainerRuntimes(drivers: readonly ContainerRuntimeDriver[], image: string): Promise<RuntimeReport[]> {
  const reports: RuntimeReport[] = [];
  let tested = false;
  for (const driver of drivers) {
    const report: RuntimeReport = { name: driver.name, probe: await driver.probe() };
    if (report.probe.available && !tested && driver.limitedStart !== undefined) {
      tested = true;
      report.limited = await driver.limitedStart(image);
      if (driver.name === "podman") {
        const host = await driver.hostInfo?.();
        if (host !== undefined) report.podmanHost = host;
      }
    }
    reports.push(report);
  }
  return reports;
}

/** What a runtime says when it cannot apply cgroup limits; only this kind of failure is blamed on the machine's cgroup setup. */
const CGROUP_ERROR = /cgroup|controller|pids|memory.max|cpu.max/i;

function wslHostIsKnownBad(host: { rootless: boolean; cgroupManager: string } | undefined): boolean {
  return host !== undefined && (host.rootless || host.cgroupManager !== "cgroupfs");
}

/** The machine setup WSL 3.0.1 needs for Podman to apply cgroup limits (containers/podman#29749, microsoft/WSL#41492). */
function wslPodmanFix(host: { rootless: boolean; cgroupManager: string } | undefined): string[] {
  const causes: string[] = [];
  if (host?.rootless) causes.push("the machine is rootless");
  if (host !== undefined && host.cgroupManager !== "cgroupfs") causes.push(`it uses the ${host.cgroupManager} cgroup manager, not cgroupfs`);
  const steps = ["podman machine stop"];
  if (host === undefined || host.rootless) steps.push("podman machine set --rootful");
  // Each step is one line that pastes into PowerShell 5.1 and Git Bash alike: no `&&`, no double quote inside the
  // outer double quotes (printf writes the quotes from their octal code), and no backslash either shell treats as an escape.
  steps.push(
    "podman machine start",
    'podman machine ssh "sudo mkdir -p /etc/containers/containers.conf.d"',
    String.raw`podman machine ssh "printf '[engine]\ncgroup_manager = \042cgroupfs\042\n' | sudo tee /etc/containers/containers.conf.d/50-cgroupfs.conf"`,
    "podman machine stop",
    "podman machine start",
  );
  return [
    `    likely cause on Windows (WSL 3.0.1): ${causes.length > 0 ? causes.join(" and ") : "cgroup limits are not available to the machine"}`,
    '    fix (containers/podman#29749, microsoft/WSL#41492): a rootful machine, and a drop-in that sets cgroup_manager = "cgroupfs":',
    ...steps.map((s) => `      ${s}`),
  ];
}

/** A containment config that names no runtime we can drive is reported, not thrown, so the rest of doctor still runs. */
export async function probeConfiguredRuntimes(
  config: ContainmentConfig,
  image: string,
): Promise<RuntimeReport[] | { error: string }> {
  try {
    return await probeContainerRuntimes(candidateDrivers(config, undefined), image);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function checkContainerRuntime(
  reports: readonly RuntimeReport[] | { error: string },
  opts: { platform: NodeJS.Platform; level: ContainmentLevel },
): Check[] {
  if (!Array.isArray(reports)) return [{ status: "fail", label: `containment config is invalid: ${(reports as { error: string }).error}` }];
  reports = reports as readonly RuntimeReport[];
  if (!reports.some((r) => r.probe.available)) {
    const why = reports.flatMap((r) => (r.probe.available ? [] : [`${r.name}: ${r.probe.reason}`]));
    return [
      {
        status: opts.level === "required" ? "fail" : "warn",
        label:
          `no container runtime answers${why.length > 0 ? ` (${why.join("; ")})` : ""}: ` +
          "containment `auto` falls back to running commands on this machine, and `required` refuses to start",
      },
    ];
  }
  const checks: Check[] = [];
  for (const r of reports) {
    checks.push(
      r.probe.available
        ? { status: "ok", label: `container runtime ${r.name} ${r.probe.version}` }
        : { status: "warn", label: `container runtime ${r.name} not available: ${r.probe.reason}` },
    );
    const limited = r.limited;
    if (limited === undefined) continue;
    const wsl = r.name === "podman" && opts.platform === "win32";
    // The known-bad setup is flagged from what Podman reports about the machine, whether or not a container could be started to prove it.
    const hostBad = wsl && limited.status !== "ok" && wslHostIsKnownBad(r.podmanHost);
    if (limited.status === "ok") {
      checks.push({ status: "ok", label: `${r.name} started a container with memory and cpu limits` });
    } else if (limited.status === "untested") {
      checks.push({
        status: hostBad ? "fail" : "warn",
        label: [`${r.name} limited container not tested: ${limited.reason}`, ...(hostBad ? wslPodmanFix(r.podmanHost) : [])].join("\n"),
      });
    } else {
      const fix = wsl && (hostBad || (r.podmanHost === undefined && CGROUP_ERROR.test(limited.reason))) ? wslPodmanFix(r.podmanHost) : [];
      checks.push({
        status: "fail",
        label: [`${r.name} could not start a container with memory and cpu limits: ${limited.reason}`, ...fix].join("\n"),
      });
    }
  }
  return checks;
}

function checkPrices(): Check {
  try {
    const { version, sourceChecked } = currentPriceTable();
    return { status: "ok", label: `prices.yaml ${version} loaded (checked against source ${sourceChecked})` };
  } catch (err) {
    return { status: "fail", label: `prices.yaml failed to load: ${(err as Error).message}` };
  }
}

function checkLedgerSchema(ledgerPath: string): Check {
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const tables = ledger.db
        .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((t) => t.name));
      const required = [
        "sessions",
        "calls",
        "projects",
        "tasks",
        "price_versions",
        "v_cache_health",
        "v_cost_inversions",
        "v_schema_tax",
        "v_prefix_breaks",
        "v_cost_per_successful_task",
      ];
      const missing = required.filter((name) => !names.has(name));
      return missing.length === 0
        ? { status: "ok", label: `ledger schema current (${ledgerPath})` }
        : { status: "fail", label: `ledger at ${ledgerPath} is missing: ${missing.join(", ")}` };
    } finally {
      ledger.close();
    }
  } catch (err) {
    return { status: "fail", label: `could not open/apply ledger schema at ${ledgerPath}: ${(err as Error).message}` };
  }
}

function checkBudget(perRun: number, perDay: number, onExceed: string): Check {
  return { status: "ok", label: `budget caps active (run $${perRun.toFixed(2)} / day $${perDay.toFixed(2)}, on_exceed=${onExceed})` };
}

function checkToolSchemaCatalog(): Check {
  try {
    const meta = catalogMeta();
    const without = piDefaultBaseline();
    const withExt = piDefaultPlusSubagentsBaseline();
    const delta = withExt.tokens - without.tokens;
    return {
      status: "ok",
      label:
        `tool-schema catalog Pi ${meta.piVersion} / pi-subagents ${meta.piSubagentsVersion}: ` +
        `${without.tokens} without / ${withExt.tokens} with (+${delta}); T20 hop-0 worker ${without.tokens} / +host ${workerPlusHostMeasurement().tokens} (no SubagentWorkflow); basis ${SCHEMA_TOKENS_BASIS}`,
    };
  } catch (err) {
    return { status: "fail", label: `tool-schema catalog incomplete: ${(err as Error).message}` };
  }
}

/**
 * T8.2 acceptance: "lykos doctor repairs the registry." resolveProject()
 * already repairs root_path in place whenever the stored path and the
 * current cwd both match the same git remote / first commit — this check
 * just runs that and reports what happened, rather than duplicating the
 * matching logic here.
 */
function checkProjectRegistry(cwd: string): Check {
  try {
    const result = resolveProject(cwd);
    if (result.repaired) {
      return {
        status: "ok",
        label: `project ${result.id} repaired in ${defaultRegistryPath()} (root_path was stale)`,
      };
    }
    return {
      status: "ok",
      label: `project ${result.id} registered in ${defaultRegistryPath()}${result.created ? " (just now)" : ""}`,
    };
  } catch (err) {
    return { status: "warn", label: `project registry check failed: ${(err as Error).message}` };
  }
}

/**
 * T113: the rest of the registry — every project, not just this one.
 *
 * Everything here is `warn` at worst and never `fail`. A root that is not on
 * disk is usually an unmounted drive or an external disk, not a dead project,
 * and `auditRegistry()` deliberately reports rather than deletes: dropping a
 * row silently removes a project from the cross-project browser with no trace
 * of why it went.
 */
function checkRegistryAudit(): Check[] {
  let audit;
  try {
    audit = auditRegistry();
  } catch (err) {
    return [{ status: "warn", label: `registry audit failed: ${(err as Error).message}` }];
  }
  const checks: Check[] = [
    { status: "ok", label: `registry holds ${audit.total} project(s) in ${defaultRegistryPath()}` },
  ];
  if (audit.missingRoot.length > 0) {
    checks.push({
      status: "warn",
      label: `${audit.missingRoot.length} registered project(s) have no directory on disk (moved, deleted, or an unmounted drive) — kept, not removed: ${audit.missingRoot
        .map((p) => p.root_path)
        .slice(0, 3)
        .join(", ")}${audit.missingRoot.length > 3 ? ", ..." : ""}`,
    });
  }
  if (audit.missingLedger.length > 0) {
    checks.push({
      status: "warn",
      label: `${audit.missingLedger.length} registered project(s) have no .lykos/ledger.db — registered but never run`,
    });
  }
  for (const group of audit.duplicateIdentities) {
    checks.push({
      status: "warn",
      label: `${group.length} registry rows share one identity (${group[0]?.git_remote ?? group[0]?.first_commit}) — their sessions will list separately: ${group
        .map((p) => p.id.slice(0, 8))
        .join(", ")}`,
    });
  }
  return checks;
}

function checkLedgerProjectsTable(ledgerPath: string): Check {
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const row = ledger.db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number };
      return row.n > 0
        ? { status: "ok", label: `ledger has ${row.n} project row(s) mirrored from the registry` }
        : { status: "warn", label: "ledger has no project rows yet — run a session or `lykos init`" };
    } finally {
      ledger.close();
    }
  } catch (err) {
    return { status: "fail", label: `could not read ledger projects table: ${(err as Error).message}` };
  }
}

/**
 * T167 (ADR-0030): flaky tests the session gate has recorded — tests that
 * failed in its run and passed when their file was rerun. A warning, never a
 * failure: a flake is a defect to fix, not a broken install. Zero is "ok",
 * which includes a ledger from before T167 (nothing is backfilled).
 */
export function checkFlakyTests(ledgerPath: string): Check {
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const { tests, sessions } = ledger.flakyTestCount();
      return tests === 0
        ? { status: "ok", label: "no flaky tests recorded by the session gate" }
        : {
            status: "warn",
            label:
              `${tests} flaky test${tests === 1 ? "" : "s"} recorded across ${sessions} session${sessions === 1 ? "" : "s"} ` +
              "— each failed in the gate and passed on rerun; `lykos show <session>` names them",
          };
    } finally {
      ledger.close();
    }
  } catch (err) {
    return { status: "fail", label: `could not read the ledger's flaky tests: ${(err as Error).message}` };
  }
}

/** T9.2: ".lykos/session/ must stay gitignored — it carries T9 transcripts (redacted, but still real conversation content)." */
function checkSessionsGitignored(cwd: string): Check {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) {
    return { status: "fail", label: `no .gitignore at ${path} — .lykos/session/ (transcripts) could be committed by accident` };
  }
  const lines = new Set(readFileSync(path, "utf8").split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !lines.has(l));
  return missing.length === 0
    ? { status: "ok", label: `${path} covers .lykos/ledger.db, sessions/, and cache/` }
    : { status: "fail", label: `${path} is missing: ${missing.join(", ")} — run \`lykos init\` to repair` };
}

/**
 * T9.3: "so doctor can report a damaged transcript rather than silently
 * believing it." Recomputes the sha256 of every session's transcript file
 * on disk and compares against what the ledger recorded at endSession.
 */
function checkTranscriptIntegrity(ledgerPath: string): Check {
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const rows = ledger.db
        .prepare(`SELECT id, transcript_path, transcript_sha256 FROM sessions WHERE transcript_sha256 IS NOT NULL`)
        .all() as Array<{ id: string; transcript_path: string; transcript_sha256: string }>;
      if (rows.length === 0) {
        return { status: "ok", label: "no transcripts recorded yet — nothing to verify" };
      }
      const damaged: string[] = [];
      for (const row of rows) {
        // T55: `transcript_path` names the raw file; `lykos archive` may have
        // replaced it with the `.gz` beside it. Resolving first is what makes
        // "doctor reports the same verdict before and after archiving" true
        // rather than aspirational.
        const resolved = resolveTranscriptFile(row.transcript_path);
        if (!resolved) {
          damaged.push(`${row.id} (missing: ${row.transcript_path})`);
          continue;
        }
        if (!verifyTranscriptHash(resolved.path, row.transcript_sha256)) {
          damaged.push(`${row.id} (hash mismatch: ${resolved.path})`);
        }
      }
      // T53 (docs/19-phase4-tasks.md): UNHASHED is not DAMAGED, and doctor
      // must not conflate them. With live capture the transcript is written
      // as the session runs and hashed only at session end, so a session
      // killed mid-turn legitimately leaves a complete-as-far-as-it-got file
      // with no recorded hash — often with no ledger row at all, because the
      // row is written at ingest too. That is the honest NULL the phase
      // asked for, and the file is exactly what makes such a run
      // recoverable; reporting it as a fault would train the user to ignore
      // this check. A hash that IS recorded and no longer matches is the
      // only fault here.
      const unhashed = countUnhashedTranscripts(ledger, ledgerPath);
      if (damaged.length > 0) {
        return {
          status: "fail",
          label: `${damaged.length}/${rows.length} transcript(s) damaged: ${damaged.join("; ")}`,
        };
      }
      const verified = `${rows.length} transcript(s) hash-verified`;
      return unhashed === 0
        ? { status: "ok", label: verified }
        : {
            status: "warn",
            label: `${verified}; ${unhashed} unhashed (session ended without finalizing — a crash, not damage)`,
          };
    } finally {
      ledger.close();
    }
  } catch (err) {
    return { status: "fail", label: `could not verify transcripts: ${(err as Error).message}` };
  }
}

/**
 * T53: session directories holding a transcript that no recorded hash covers
 * — either the ledger row exists with a NULL `transcript_sha256`, or (the
 * common case for a killed run) there is no row at all because ingest never
 * ran. Counted, not listed: the point is to distinguish this state from
 * damage, not to enumerate every crash the ledger has ever survived.
 */
function countUnhashedTranscripts(ledger: Ledger, ledgerPath: string): number {
  const dir = sessionsDir(ledgerPath);
  if (!existsSync(dir)) return 0;
  const hashed = new Set(
    (
      ledger.db
        .prepare(`SELECT id FROM sessions WHERE transcript_sha256 IS NOT NULL`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || hashed.has(entry.name)) continue;
    if (resolveTranscriptFile(join(dir, entry.name, "transcript.jsonl"))) count += 1;
  }
  return count;
}

/**
 * T41.2: report the VT probe's answer rather than a guess about it. The probe
 * itself runs in `cli.ts` (it is async, and doctor's checks are all
 * synchronous by design) and the result is passed in — so a doctor run on a
 * pipe honestly reports `no-tty` instead of the terminal capability of some
 * other terminal. `warn`, never `fail`: no VT support is a supported
 * configuration with a working surface behind it (T50.1's append-only
 * fallback), not a broken environment.
 */
function checkVtSupport(vt: VtProbeResult | undefined): Check {
  if (!vt) {
    return { status: "warn", label: "VT support not probed this run (T41.2) — run `lykos doctor` in the terminal you intend to use" };
  }
  const reply = vt.reply ? `, reply ${vt.reply}` : "";
  const elapsed = vt.elapsedMs !== undefined ? `, ${vt.elapsedMs}ms` : "";
  return vt.supported
    ? { status: "ok", label: `VT support: yes (${vt.method}${reply}${elapsed}) — the full-screen surface is available here` }
    : {
        status: "warn",
        label: `VT support: no (${vt.method}${elapsed}) — ${vt.detail}; the append-only renderer is the surface here (T50.1)`,
      };
}

function checkStatuslineWiring(cwd: string): Check {
  const path = join(cwd, ".claude", "settings.json");
  if (!existsSync(path)) {
    return { status: "warn", label: `no ${path} — statusLine not wired (run \`lykos init\` to write the snippet)` };
  }
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { statusLine?: { command?: string } };
    const command = settings.statusLine?.command;
    if (command && command.includes("lykos hud")) {
      return { status: "ok", label: `statusLine wired in ${path} (${command})` };
    }
    return { status: "warn", label: `${path} has no statusLine pointing at \`lykos hud --statusline\`` };
  } catch (err) {
    return { status: "warn", label: `${path} did not parse as JSON: ${(err as Error).message}` };
  }
}

/**
 * §8's performance budget, measured against a synthetic ledger rather than
 * assumed. Only runs under --bench-ui: it spawns real `node` processes for
 * S1, which is not something a routine `doctor` run should pay for.
 */
function benchUiChecks(repoRoot: string): Check[] {
  const distCli = join(repoRoot, "dist", "cli.js");
  const checks: Check[] = [];
  const dir = mkdtempSync(join(tmpdir(), "lykos-bench-ui-"));
  const ledgerPath = join(dir, "ledger.db");
  try {
    const ledger = openLedgerSync(ledgerPath);
    for (let i = 0; i < 30; i++) {
      const sessionId = ledger.startSession({ brief: `synthetic session ${i}`, harnessCommit: "bench" });
      ledger.recordCall({
        sessionId,
        agent: "worker",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        tokens: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 },
        ts: new Date(),
      });
      ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    }
    ledger.close();

    // S2: in-process render cost only (§2 ms), not process start — S2 runs
    // inline inside an already-running process, unlike S1.
    const snapshot = collect({ ledgerPath, sessionId: null, config: loadConfig({ cwd: dir }).resolved });
    const vm = derive(snapshot);
    const theme = resolveTheme("mono", "none", "unicode");
    const s2Iterations = 500;
    const s2Start = performance.now();
    for (let i = 0; i < s2Iterations; i++) renderStderrLine(vm, { theme });
    const s2PerCall = (performance.now() - s2Start) / s2Iterations;
    checks.push(
      s2PerCall < 2
        ? { status: "ok", label: `S2 stderr HUD render: ${s2PerCall.toFixed(3)}ms/call (budget < 2ms)` }
        : { status: "fail", label: `S2 stderr HUD render: ${s2PerCall.toFixed(3)}ms/call exceeds the 2ms budget` },
    );

    const s3Start = performance.now();
    for (let i = 0; i < s2Iterations; i++) {
      renderWatchFrame(vm, {
        width: 80,
        height: 40,
        theme,
        panels: ["now", "cost", "tokens", "health", "session"],
        source: "ledger",
      });
    }
    const s3PerCall = (performance.now() - s3Start) / s2Iterations;
    checks.push(
      s3PerCall < 20
        ? { status: "ok", label: `S3 watch frame: ${s3PerCall.toFixed(3)}ms/call (budget < 20ms)` }
        : { status: "fail", label: `S3 watch frame: ${s3PerCall.toFixed(3)}ms/call exceeds the 20ms budget` },
    );

    const s0View = {
      blocks: [
        { kind: "header" as const, header: { model: "deepseek-v4-flash", sessionId: "bench", cwd: dir } },
        { kind: "user" as const, text: "hello" },
        { kind: "assistant" as const, text: "ok" },
        { kind: "hud" as const },
      ],
      hud: vm,
      toolsCollapsed: true,
      thinkingCollapsed: true,
    };
    const s0Start = performance.now();
    for (let i = 0; i < s2Iterations; i++) renderS0(s0View, { width: 80, theme });
    const s0PerCall = (performance.now() - s0Start) / s2Iterations;
    checks.push(
      s0PerCall < 2
        ? { status: "ok", label: `S0 conversation render: ${s0PerCall.toFixed(3)}ms/call (budget < 2ms)` }
        : { status: "fail", label: `S0 conversation render: ${s0PerCall.toFixed(3)}ms/call exceeds the 2ms budget` },
    );

    // T50.3: the full-screen surface's own frame-render budget (§8's new
    // row) — renderApp() at 200x60 with 5000 lines of scrollback, p95 < 8ms.
    // Extends this same harness rather than inventing a second one.
    const bigViewport = Array.from({ length: 5000 }, (_, i) => `line ${i} of synthetic scrollback content for the frame budget`);
    const appState: AppState = {
      header: { product: "LYKOS", version: "0.0.1", model: "deepseek-v4-flash", cwd: dir, branch: null, sessionId: "bench", executionShape: "standalone" },
      vm,
      footerVisible: true,
      viewportLines: bigViewport.slice(-56),
      composerLines: ["> "],
    };
    const frameIterations = 200;
    const frameTimes: number[] = [];
    for (let i = 0; i < frameIterations; i++) {
      const t0 = performance.now();
      renderApp(appState, { width: 200, height: 60, theme });
      frameTimes.push(performance.now() - t0);
    }
    frameTimes.sort((a, b) => a - b);
    const framesP95 = frameTimes[Math.floor(frameIterations * 0.95)] ?? frameTimes[frameTimes.length - 1]!;
    checks.push(
      framesP95 < 8
        ? {
            status: "ok",
            label: `full-screen frame render: p95 ${framesP95.toFixed(3)}ms/frame over ${frameIterations} renders at 200x60, 5000 lines of scrollback (budget < 8ms, T50.3)`,
          }
        : { status: "fail", label: `full-screen frame render: p95 ${framesP95.toFixed(3)}ms/frame exceeds the 8ms budget (T50.3)` },
    );

    // T50.3: frame writes are diffs — a one-line change must cost far less
    // than a full redraw regardless of how much scrollback is behind it,
    // which is what keeps the 30Hz scheduler (T41.4) reachable in practice.
    const writer = new FrameWriter({ write: () => {} });
    writer.write(renderApp(appState, { width: 200, height: 60, theme }));
    const changedState: AppState = { ...appState, composerLines: ["> x"] };
    const changedFrame = renderApp(changedState, { width: 200, height: 60, theme });
    const diffResult = writer.write(changedFrame);
    const fullRedrawBytes = FrameWriter.fullRedrawBytes(changedFrame);
    checks.push(
      !diffResult.full && diffResult.bytes < fullRedrawBytes
        ? {
            status: "ok",
            label: `full-screen frame diff: ${diffResult.bytes}B for a one-line change vs ${fullRedrawBytes}B for a full redraw`,
          }
        : {
            status: "fail",
            label: `full-screen frame diff did not stay cheap: ${diffResult.bytes}B written (full redraw would be ${fullRedrawBytes}B, full=${diffResult.full})`,
          },
    );

    // S4: `lykos cost`, budget < 200ms (the --since 30d rollup is T5; this
    // times the reader's basic ledger scan, which is the floor that budget
    // sits on top of).
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let s4Ms: number;
    try {
      const s4Start = performance.now();
      runCost(ledgerPath);
      s4Ms = performance.now() - s4Start;
    } finally {
      process.stdout.write = originalWrite;
    }
    checks.push(
      s4Ms < 200
        ? { status: "ok", label: `S4 \`lykos cost\`: ${s4Ms.toFixed(1)}ms (budget < 200ms)` }
        : { status: "fail", label: `S4 \`lykos cost\`: ${s4Ms.toFixed(1)}ms exceeds the 200ms budget` },
    );

    // S1: real `node dist/cli.js hud --statusline` process, including start —
    // the budget explicitly includes it (§8), and that is most of the cost.
    // Warms the resolved-config cache first (config/cache.ts) to measure the
    // steady state — a project that has run `init` or `doctor` at least once
    // — rather than the one-time cold-cache cost of the very first `hud`
    // call, which pays loadConfig()'s `yaml` import once and never again.
    if (!existsSync(distCli)) {
      checks.push({ status: "warn", label: "S1 statusline bench skipped: dist/cli.js not built (run `npm run build`)" });
    } else {
      writeResolvedConfigCache(dir, loadConfig({ cwd: dir }).resolved);
      const stdinJson = JSON.stringify({
        context_window: { used_percentage: 0.58, current_usage: { input_tokens: 100000, cache_read_input_tokens: 16000 }, context_window_size: 200000 },
        cost: { total_cost_usd: 0.41 },
      });
      const n = 10;
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        spawnSync("node", [distCli, "hud", "--statusline"], {
          input: stdinJson,
          encoding: "utf8",
          env: { ...process.env, LYKOS_LEDGER_PATH: ledgerPath },
          cwd: dir,
        });
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(n * 0.95)] ?? times[times.length - 1]!;
      checks.push(
        p95 < 50
          ? { status: "ok", label: `S1 statusline: p95 ${p95.toFixed(1)}ms over ${n} runs (budget < 50ms)` }
          : {
              status: "warn",
              label: `S1 statusline: p95 ${p95.toFixed(1)}ms over ${n} runs exceeds the 50ms budget — remaining gap is node's own ESM process-start cost, not Lykos's rendering`,
            },
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return checks;
}

export interface RunDoctorOptions {
  benchUi?: boolean;
  /**
   * T41.2's probe result, measured by the caller (`cli.ts`) because probing
   * is async and every check here is synchronous. Absent when nothing
   * probed, which is reported as "not probed" rather than as "unsupported".
   */
  vt?: VtProbeResult;
  /** T178's probe, measured by the caller for the same reason. Absent means not probed. */
  containment?: RuntimeReport[] | { error: string };
}

export function runDoctor(cwd: string, opts: RunDoctorOptions = {}): number {
  const repoRoot = findRepoRoot();
  const { resolved } = loadConfig({ cwd });
  writeResolvedConfigCache(cwd, resolved);
  const ledgerPath = resolved.telemetry.ledger === ".lykos/ledger.db"
    ? defaultLedgerPath(cwd)
    : resolved.telemetry.ledger;

  const checks: Check[] = [
    // T97.4: the declaration against THIS machine, because a session loads from here.
    // ADR-0027 (P14 ticket 08, D4): the pi-host line first, then the
    // declaration reconciled against that same directory.
    ...checkPiHost(process.env),
    checkGit(gitVersion()),
    ...reconcileHostExtensions(resolveExtensions(resolved.extensions), piHostDir(process.env), existsSync),
    // T147 (D25): and the Lykos extension list, against the same directory.
    ...reconcileHostLykosExtensions(
      resolveExtensions(resolved.lykos_extensions, LYKOS_EXTENSIONS_KEY),
      piHostDir(process.env),
      existsSync,
    ),
    // T188: the prune rules are on but is anything running them?
    checkPruneExtension(resolved.compaction, resolved.extensions),
    // T99/T100: the two mechanisms that run without being asked, made visible.
    ...checkFeedbackLoop(cwd, resolved.feedback, resolved.gate, {
      postEdit: discoverPostEditCommand,
      gate: discoverGateCommand,
    }),
    // T102: the skills roster, zero-schema until read.
    checkSkills(listSkillFiles(cwd)),
    ...checkCredentialPools(process.env),
    checkRetryPolicy(process.env),
    ...checkProviderMatrix(resolved.providers, process.env),
    checkPrices(),
    checkToolSchemaCatalog(),
    checkLedgerSchema(ledgerPath),
    checkProjectRegistry(cwd),
    ...checkRegistryAudit(),
    checkLedgerProjectsTable(ledgerPath),
    checkFlakyTests(ledgerPath),
    checkSessionsGitignored(cwd),
    checkTranscriptIntegrity(ledgerPath),
    checkBudget(resolved.budget.per_run_usd, resolved.budget.per_day_usd, resolved.budget.on_exceed),
    checkStatuslineWiring(cwd),
    checkVtSupport(opts.vt),
    ...(opts.containment === undefined
      ? []
      : checkContainerRuntime(opts.containment, { platform: process.platform, level: resolved.containment.level })),
    {
      status: "warn",
      label:
        "cache-read/cache-write exposure not reverified live this run; reverify with a real run and read the cache columns in `lykos show` (the old `telemetry:live` script was deleted with the delegate path, T185)",
    },
  ];

  if (opts.benchUi) {
    checks.push(...benchUiChecks(repoRoot));
  }

  stdoutWrite("lykos doctor\n");
  for (const check of checks) {
    stdoutWrite(`  ${SYMBOL[check.status]} ${check.label}\n`);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  stdoutWrite(`\n${checks.length - failed - warned} ok, ${warned} warn, ${failed} fail\n`);
  if (!opts.benchUi) {
    stdoutWrite("(run `lykos doctor --bench-ui` to check the §8 performance budgets)\n");
  }
  return failed > 0 ? 1 : 0;
}
