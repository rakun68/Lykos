// Config precedence (docs/05-cli-and-config.md §2, with the specialist layer
// added):
//   shipped defaults -> ~/.lykos/config.yaml -> .lykos/config.yaml -> specialist -> env -> flags
//
// Each layer is a partial ConfigFile; later layers override only the keys
// they actually set, one level deep per section (a project config.yaml that
// sets budget.per_run_usd does not wipe out budget.on_exceed from the layer
// below it).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SHIPPED_DEFAULTS } from "./defaults.js";
import { readYamlObjectFile } from "./yaml-file.js";
import { resolveSpecialistLayer, shippedSpecialistsDir } from "./specialists.js";
import { gateRerunCommandProblem } from "../gate/rerun-failures.js";
import type {
  BudgetConfig,
  ContinuationConfig,
  FeedbackConfig,
  GateConfigFile,
  SkillsConfig,
  ReviewerConfig,
  CompactionConfig,
  ConfigFile,
  ContainmentConfig,
  ConfigLayer,
  EditConfig,
  EvalConfig,
  FlagsConfig,
  LspConfig,
  McpConfig,
  MemoryConfig,
  ModelsConfig,
  ProvidersConfig,
  ResolvedConfig,
  SealConfig,
  TelemetryConfig,
  UiConfig,
  ResolvedUiConfig,
  WebSearchConfig,
} from "./types.js";
import type { RawPathRules } from "../gate/path-rules.js";
import { CONTAINMENT_LEVELS } from "../containment/request.js";
import type { ContainmentLevel } from "../containment/containment.js";
import { defaultSearchEndpoint, defaultSearchKeyEnv } from "../tools/web-search.js";

export interface LoadConfigOptions {
  /** Project working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Global config root. Defaults to ~/.lykos. Override in tests. */
  globalDir?: string;
  /**
   * Specialists ticket 07: the repo-shipped specialist library directory, the
   * lowest-precedence discovery source. Defaults to the package's own
   * `specialists/` directory; a test passes an isolated (empty) directory to
   * observe only the project and global sources.
   */
  shippedSpecialistsDir?: string;
  /** process.env, or a substitute in tests. */
  env?: NodeJS.ProcessEnv;
  /** Highest-precedence layer: parsed CLI flags. */
  flags?: ConfigFile;
  /**
   * Specialists ticket 01: the selected specialist's name, e.g. from `--specialist`.
   * Resolved into the sixth layer, sitting between `project` and `env`.
   * Throws `SpecialistNotFoundError` (config/specialists.ts) when no specialist with
   * this name exists in either location, and `SpecialistValidationError` when
   * its content is invalid (e.g. volatile instructions) — both propagate out
   * of `loadConfig()` rather than being swallowed, matching how a
   * non-parsing config.yaml already throws below.
   */
  specialistName?: string;
}

export interface LoadedConfig {
  resolved: ResolvedConfig;
  layers: ConfigLayer[];
}

// T27.2 (docs/10-phase2-tasks.md, docs/14-performance.md row 5): `yaml`
// costs ~266ms to import and is only ever needed once a config layer file
// actually exists on disk (`loadFileLayer()` below only calls this when
// `existsSync(path)`). `readYamlObjectFile` (config/yaml-file.ts) defers
// that cost with a lazy `require()`, shared with `config/specialists.ts` so the
// sixth layer does not re-pay it or duplicate the parser wiring.
function readYamlFile(path: string): ConfigFile {
  return readYamlObjectFile(path) as ConfigFile;
}

function loadFileLayer(name: "global" | "project", path: string): ConfigLayer {
  if (!existsSync(path)) return { name, path, present: false, value: {} };
  return { name, path, present: true, value: readYamlFile(path) };
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * The fixed, documented set of env overrides. Anything not listed here is
 * not a supported override — silently reading arbitrary LYKOS_* env vars
 * would make the precedence stack impossible to reason about.
 */
function envLayer(env: NodeJS.ProcessEnv): ConfigLayer {
  const value: ConfigFile = {};

  const modelDefault = env.LYKOS_MODEL_DEFAULT;
  if (modelDefault) value.models = { default: modelDefault };

  const budget: BudgetConfig = {};
  const perRun = num(env.LYKOS_BUDGET_PER_RUN_USD);
  if (perRun !== undefined) budget.per_run_usd = perRun;
  const perDay = num(env.LYKOS_BUDGET_PER_DAY_USD);
  if (perDay !== undefined) budget.per_day_usd = perDay;
  if (Object.keys(budget).length > 0) value.budget = budget;

  const telemetry: TelemetryConfig = {};
  if (env.LYKOS_LEDGER_PATH) telemetry.ledger = env.LYKOS_LEDGER_PATH;
  const hud = bool(env.LYKOS_HUD);
  if (hud !== undefined) telemetry.hud = hud;
  if (Object.keys(telemetry).length > 0) value.telemetry = telemetry;

  const ui: UiConfig = {};
  if (env.LYKOS_UI_THEME) ui.theme = env.LYKOS_UI_THEME;
  if (env.NO_COLOR !== undefined) ui.color = "never";
  if (Object.keys(ui).length > 0) value.ui = ui;

  const compaction: CompactionConfig = {};
  const threshold = num(env.LYKOS_COMPACTION_THRESHOLD);
  if (threshold !== undefined) compaction.threshold = threshold;
  if (Object.keys(compaction).length > 0) value.compaction = compaction;

  const present = Object.keys(value).length > 0;
  return { name: "env", present, value };
}

function mergeSection<T extends object>(base: T, override: T | undefined): T {
  if (!override) return base;
  return { ...base, ...override };
}

function mergeModels(base: Required<ModelsConfig>, override: ModelsConfig | undefined): Required<ModelsConfig> {
  if (!override) return base;
  return {
    default: override.default ?? base.default,
    roles: override.roles ? { ...base.roles, ...override.roles } : base.roles,
    // T89: replaced wholesale, not merged. A chain is an ordered decision,
    // and key-merging two chains would produce an order nobody chose.
    fallback: override.fallback ?? base.fallback,
    delegate: override.delegate ?? base.delegate,
  };
}

/**
 * T35.1: merge by key, like `models.roles`. A project that adds
 * `anthropic:` keeps shipped `deepseek:`. A project that re-declares
 * `deepseek:` replaces that entry, not the whole map.
 */
function mergeProviders(base: ProvidersConfig, override: ProvidersConfig | undefined): ProvidersConfig {
  if (!override) return base;
  return { ...base, ...override };
}

/**
 * P10.4 (ticket 15, D4): merge by key, like `providers` above and for the
 * same reason.
 *
 * A project that adds `python:` keeps the shipped `typescript:` entry; a
 * project that re-declares `typescript:` replaces that one entry rather than
 * the table. Replace-on-set would make "configure a second language" a way to
 * silently lose the first — and the symptom would be `lsp` answering "no
 * server configured for .ts", which reads as a missing install rather than as
 * a config merge.
 */
function mergeLsp(base: Required<LspConfig>, override: LspConfig | undefined): Required<LspConfig> {
  if (!override?.servers) return base;
  return { servers: { ...base.servers, ...override.servers } };
}

function mergeMemory(base: Required<MemoryConfig>, override: MemoryConfig | undefined): Required<MemoryConfig> {
  if (!override) return base;
  return {
    enabled: override.enabled ?? base.enabled,
    scope: override.scope ?? base.scope,
    max_inject_tokens: override.max_inject_tokens ?? base.max_inject_tokens,
  };
}

function mergeUi(base: ResolvedUiConfig, override: UiConfig | undefined): ResolvedUiConfig {
  if (!override) return base;
  return {
    theme: override.theme ?? base.theme,
    color: override.color ?? base.color,
    glyphs: override.glyphs ?? base.glyphs,
    show_avoided: override.show_avoided ?? base.show_avoided,
    statusline_refresh_hint: override.statusline_refresh_hint ?? base.statusline_refresh_hint,
    hud: {
      enabled: override.hud?.enabled ?? base.hud.enabled,
      format: override.hud?.format ?? base.hud.format,
      delegate_line: override.hud?.delegate_line ?? base.hud.delegate_line,
      max_lines: override.hud?.max_lines ?? base.hud.max_lines,
      show_avoided: override.hud?.show_avoided ?? base.hud.show_avoided,
    },
    statusline: {
      enabled: override.statusline?.enabled ?? base.statusline.enabled,
      format: override.statusline?.format ?? base.statusline.format,
      delegate_line: override.statusline?.delegate_line ?? base.statusline.delegate_line,
      refresh_hint: override.statusline?.refresh_hint ?? base.statusline.refresh_hint,
    },
    watch: {
      panels: override.watch?.panels ?? base.watch.panels,
      refresh_hz: override.watch?.refresh_hz ?? base.watch.refresh_hz,
    },
    footer: override.footer ?? base.footer,
    completion_position: override.completion_position ?? base.completion_position,
    tool_result_preview: override.tool_result_preview ?? base.tool_result_preview,
    tool_wait_limit_seconds: override.tool_wait_limit_seconds ?? base.tool_wait_limit_seconds,
  };
}

function mergeSeal(
  current: Required<Omit<SealConfig, "resolver">> & Pick<SealConfig, "resolver">,
  override: SealConfig | undefined,
): Required<Omit<SealConfig, "resolver">> & Pick<SealConfig, "resolver"> {
  if (!override) return current;
  const resolver = override.resolver ?? current.resolver;
  return {
    base: override.base ?? current.base,
    test_command: override.test_command ?? current.test_command,
    test_globs: override.test_globs ? [...override.test_globs] : current.test_globs,
    run_globs: override.run_globs ? [...override.run_globs] : current.run_globs,
    always_sealed: override.always_sealed ? [...override.always_sealed] : current.always_sealed,
    writers: override.writers ? [...override.writers] : current.writers,
    enforce_for: override.enforce_for ? [...override.enforce_for] : current.enforce_for,
    weakening_patterns: override.weakening_patterns ? [...override.weakening_patterns] : current.weakening_patterns,
    ...(resolver !== undefined ? { resolver } : {}),
    escalate_after: override.escalate_after ?? current.escalate_after,
  };
}

function mergeWebSearch(
  current: Required<WebSearchConfig>,
  update?: WebSearchConfig,
): Required<WebSearchConfig> {
  if (!update) return current;
  const provider = update.provider ?? current.provider;
  const providerChanged = update.provider !== undefined && update.provider !== current.provider;
  const endpoint = update.endpoint ?? (providerChanged ? defaultSearchEndpoint(provider) : current.endpoint);
  const key_env = update.key_env ?? (providerChanged ? defaultSearchKeyEnv(provider) : current.key_env);
  return { provider, endpoint, key_env };
}

function applyLayer(current: ResolvedConfig, layer: ConfigFile): ResolvedConfig {
  return {
    version: layer.version ?? current.version,
    // T29: replace, never merge. The list is ordered and the order is load
    // order; `extensions: []` in a project config is a deliberate "load none".
    extensions: layer.extensions ?? current.extensions,
    // T147 (D25): the Lykos extension list, on the same replace rule.
    lykos_extensions: layer.lykos_extensions ?? current.lykos_extensions,
    providers: mergeProviders(current.providers, layer.providers),
    models: mergeModels(current.models, layer.models),
    budget: mergeSection(current.budget, layer.budget as Required<BudgetConfig> | undefined),
    telemetry: mergeSection(current.telemetry, layer.telemetry as Required<TelemetryConfig> | undefined),
    flags: mergeSection(current.flags, layer.flags as Required<FlagsConfig> | undefined),
    compaction: mergeSection(current.compaction, layer.compaction as Required<CompactionConfig> | undefined),
    memory: mergeMemory(current.memory, layer.memory),
    // T99: a plain field merge — every key is a scalar, and a layer that sets
    // only `command` keeps the shipped timeout rather than dropping it.
    feedback: mergeSection(current.feedback, layer.feedback as Required<FeedbackConfig> | undefined),
    // T100: same plain field merge as feedback above.
    gate: mergeSection(current.gate, layer.gate as Required<GateConfigFile> | undefined),
    skills: mergeSection(current.skills, layer.skills as Required<SkillsConfig> | undefined),
    // T168 part B: one boolean, a plain field merge. A layer that says nothing
    // about `edit:` inherits the value below it.
    edit: mergeSection(current.edit, layer.edit as Required<EditConfig> | undefined),
    // T195: sealed TDD configuration.
    seal: mergeSeal(current.seal, layer.seal),
    // P10.4 (ticket 15): by key, not by section — see `mergeLsp`.
    lsp: mergeLsp(current.lsp, layer.lsp),
    // P10.6 (ticket 19): one scalar, a plain field merge.
    // A layer that says nothing about `eval:` inherits the interpreter below
    // it rather than resetting it to unconfigured.
    eval: mergeSection(current.eval, layer.eval as Required<EvalConfig> | undefined),
    // P10.7 (ticket 12, P14 ticket 17 D3): nested one level.
    // When the provider changes and web.search.endpoint is not set explicitly,
    // the endpoint default follows the provider.
    web: {
      search: mergeWebSearch(current.web.search, layer.web?.search),
    },
    // T150: one scalar; a layer that does not set it inherits the one below.
    context_strategy: layer.context_strategy ?? current.context_strategy,
    // T151: `tiers` replaces (the table is ordered and validated whole);
    // `models` and `specialists` merge by key, like `lsp.servers`. Any other
    // key is carried through so validation at boot can refuse it by name
    // rather than a typo vanishing here.
    self_compact: {
      ...current.self_compact,
      ...(typeof layer.self_compact === "object" && layer.self_compact !== null ? layer.self_compact : {}),
      tiers: layer.self_compact?.tiers ?? current.self_compact.tiers,
      models: { ...current.self_compact.models, ...(layer.self_compact?.models ?? {}) },
      specialists: { ...current.self_compact.specialists, ...(layer.self_compact?.specialists ?? {}) },
    },
    continuation: mergeSection(current.continuation, layer.continuation as Required<ContinuationConfig> | undefined),
    reviewer: mergeSection(current.reviewer, layer.reviewer as Required<ReviewerConfig> | undefined),
    // T173: scalars; a layer that sets only `level` keeps the shipped caps.
    containment: mergeSection(current.containment, layer.containment as Required<ContainmentConfig> | undefined),
    // T223: MCP worker settings.
    mcp: mergeSection(current.mcp, layer.mcp as Required<McpConfig> | undefined),
    path_rules: current.path_rules,
    // T105: replace, never merge — same rule as `extensions:` above, because
    // the order is the authority.
    hooks: layer.hooks ?? current.hooks,
    // T69: nested one level, so a config that sets only `max_tokens` keeps
    // the shipped `max_files_per_dir` instead of dropping it to undefined.
    retrieval: {
      repo_map: { ...current.retrieval.repo_map, ...(layer.retrieval?.repo_map ?? {}) },
    },
    ui: mergeUi(current.ui, layer.ui),
    // T217: output style. Plain scalar field.
    output_style: layer.output_style ?? current.output_style,
    // Specialists ticket 01: a plain scalar field, like every field in
    // `mergeSection`'s sections — a layer that does not set it inherits the
    // layer below rather than resetting to "".
    instructions: layer.instructions ?? current.instructions,
    // Specialists ticket 02: replace-if-present, same rule as `extensions:` and
    // `hooks:` above — a layer that sets `tools` (or either delta list)
    // means it, and inheriting is "the layer did not mention it at all".
    provider: layer.provider ?? current.provider,
    model: layer.model ?? current.model,
    thinkingLevel: layer.thinkingLevel ?? current.thinkingLevel,
    tools: layer.tools ?? current.tools,
    tools_add: layer.tools_add ?? current.tools_add,
    tools_remove: layer.tools_remove ?? current.tools_remove,
    mode: layer.mode ?? current.mode,
    readOnly: layer.readOnly ?? current.readOnly,
    description: layer.description ?? current.description,
  };
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".lykos", "config.yaml");
}

export function globalConfigPath(globalDir: string): string {
  return join(globalDir, "config.yaml");
}

/**
 * T177 (ADR-0037): `containment.global_image` is filled by the loader from the
 * global config's `containment.image`, so that image ranks below a project's
 * devcontainer. A file that wrote the key itself would replace it, so any layer
 * that sets it is refused.
 */
function reservedKeyProblem(layer: ConfigLayer): string | undefined {
  const containment = (layer.value as Record<string, unknown>).containment;
  if (containment === null || typeof containment !== "object" || !Object.hasOwn(containment, "global_image")) return undefined;
  const where = layer.path !== undefined ? ` in ${layer.path}` : ` in the ${layer.name} layer`;
  return `containment.global_image is not a config key (the loader fills it from the global config's containment.image); delete it${where}. To set the image, use containment.image.`;
}

/**
 * T168 (ADR-0031): `edit.mode` chose between Lykos's anchored editor and Pi's
 * text-replacement one. There is one editor now, so a layer that still sets it
 * is refused rather than ignored: a silently ignored `mode: anchored` would
 * leave a project believing it still had line-anchored editing.
 */
function removedKeyProblem(layer: ConfigLayer): string | undefined {
  const edit = (layer.value as Record<string, unknown>).edit;
  if (edit === null || typeof edit !== "object" || !Object.hasOwn(edit, "mode")) return undefined;
  const where = layer.path !== undefined ? ` in ${layer.path}` : ` in the ${layer.name} layer`;
  return (
    `edit.mode was removed (ADR-0031); there is one editor now, exact text replacement, so delete the key${where}.`
  );
}

/**
 * T209 (ADR-0041): permission mode defaults are not stored in config.yaml;
 * they are remembered per project in .lykos/permissions.json.
 */
function permissionModeInConfigProblem(layer: ConfigLayer): string | undefined {
  if (layer.name !== "global" && layer.name !== "project") return undefined;
  const val = layer.value as Record<string, unknown>;
  const permissions = val.permissions;
  const hasPermissionsMode =
    permissions !== null && typeof permissions === "object" && Object.hasOwn(permissions, "mode");
  const hasMode = Object.hasOwn(val, "mode");
  if (hasPermissionsMode || hasMode) {
    const key = hasPermissionsMode ? "permissions.mode" : "mode";
    const where = layer.path !== undefined ? ` in ${layer.path}` : ` in the ${layer.name} layer`;
    return (
      `${key} is not supported in config.yaml (modes are remembered per project, ADR-0041); use /permissions or --mode to set the permission mode${where}.`
    );
  }
  return undefined;
}

const VALID_SEAL_KEYS = new Set([
  "base",
  "test_command",
  "test_globs",
  "run_globs",
  "always_sealed",
  "writers",
  "enforce_for",
  "weakening_patterns",
  "resolver",
  "escalate_after",
]);

function validateSealConfig(layer: ConfigLayer): void {
  const val = layer.value as Record<string, unknown>;
  if (!Object.hasOwn(val, "seal")) return;
  const seal = val.seal;
  if (seal === undefined || seal === null) return;
  const where = layer.path !== undefined ? ` in ${layer.path}` : ` in the ${layer.name} layer`;
  if (typeof seal !== "object" || Array.isArray(seal)) {
    throw new Error(`lykos config: seal must be an object${where}`);
  }
  for (const k of Object.keys(seal as Record<string, unknown>)) {
    if (!VALID_SEAL_KEYS.has(k)) {
      throw new Error(
        `lykos config: unknown key "${k}" in seal (allowed: ${Array.from(VALID_SEAL_KEYS).join(", ")})${where}`,
      );
    }
  }
  const s = seal as SealConfig;
  if (s.base !== undefined && typeof s.base !== "string") {
    throw new Error(`lykos config: seal.base must be a string${where}`);
  }
  if (s.test_command !== undefined) {
    if (typeof s.test_command !== "string") {
      throw new Error(`lykos config: seal.test_command must be a string${where}`);
    }
    if (!s.test_command.includes("{files}")) {
      throw new Error(`lykos config: seal.test_command must contain {files}${where}`);
    }
  }
  if (s.test_globs !== undefined) {
    if (!Array.isArray(s.test_globs) || !s.test_globs.every((g) => typeof g === "string")) {
      throw new Error(`lykos config: seal.test_globs must be a list of strings${where}`);
    }
  }
  if (s.run_globs !== undefined) {
    if (!Array.isArray(s.run_globs) || !s.run_globs.every((g) => typeof g === "string")) {
      throw new Error(`lykos config: seal.run_globs must be a list of strings${where}`);
    }
  }
  if (s.always_sealed !== undefined) {
    if (!Array.isArray(s.always_sealed) || !s.always_sealed.every((g) => typeof g === "string")) {
      throw new Error(`lykos config: seal.always_sealed must be a list of strings${where}`);
    }
  }
  if (s.writers !== undefined) {
    if (!Array.isArray(s.writers) || !s.writers.every((g) => typeof g === "string")) {
      throw new Error(`lykos config: seal.writers must be a list of strings${where}`);
    }
  }
  if (s.enforce_for !== undefined) {
    if (!Array.isArray(s.enforce_for) || !s.enforce_for.every((g) => typeof g === "string")) {
      throw new Error(`lykos config: seal.enforce_for must be a list of strings${where}`);
    }
  }
  if (s.weakening_patterns !== undefined) {
    if (!Array.isArray(s.weakening_patterns) || !s.weakening_patterns.every((g) => typeof g === "string")) {
      throw new Error(`lykos config: seal.weakening_patterns must be a list of strings${where}`);
    }
  }
  if (s.resolver !== undefined) {
    if (s.resolver !== "orchestrator" && s.resolver !== "test-writer") {
      throw new Error(`lykos config: seal.resolver must be 'orchestrator' or 'test-writer'${where}`);
    }
  }
  if (s.escalate_after !== undefined) {
    if (typeof s.escalate_after !== "number" || !Number.isInteger(s.escalate_after) || s.escalate_after < 1) {
      throw new Error(`lykos config: seal.escalate_after must be a positive integer${where}`);
    }
  }
}

const VALID_MCP_KEYS = new Set(["max_sessions", "ask_timeout", "warm_pool"]);

function validateMcpConfig(layer: ConfigLayer): void {
  const val = layer.value as Record<string, unknown>;
  if (!Object.hasOwn(val, "mcp")) return;
  const mcp = val.mcp;
  if (mcp === undefined || mcp === null) return;
  const where = layer.path !== undefined ? ` in ${layer.path}` : ` in the ${layer.name} layer`;
  if (typeof mcp !== "object" || Array.isArray(mcp)) {
    throw new Error(`lykos config: mcp must be an object${where}`);
  }
  for (const k of Object.keys(mcp as Record<string, unknown>)) {
    if (!VALID_MCP_KEYS.has(k)) {
      throw new Error(
        `lykos config: unknown key "${k}" in mcp (allowed: ${Array.from(VALID_MCP_KEYS).join(", ")})${where}`,
      );
    }
  }
  const m = mcp as McpConfig;
  if (m.max_sessions !== undefined) {
    if (typeof m.max_sessions !== "number" || !Number.isInteger(m.max_sessions) || m.max_sessions < 1) {
      throw new Error(`lykos config: mcp.max_sessions must be a positive integer${where}`);
    }
  }
  if (m.ask_timeout !== undefined) {
    if (typeof m.ask_timeout !== "number" || !Number.isInteger(m.ask_timeout) || m.ask_timeout < 1) {
      throw new Error(`lykos config: mcp.ask_timeout must be a positive integer${where}`);
    }
  }
  if (m.warm_pool !== undefined) {
    if (typeof m.warm_pool !== "number" || !Number.isInteger(m.warm_pool) || m.warm_pool < 0) {
      throw new Error(`lykos config: mcp.warm_pool must be a whole number >= 0${where}`);
    }
  }
}

export function detectDefaultBase(cwd: string): string {
  try {
    const originHead = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (originHead) {
      return originHead.replace(/^origin\//, "");
    }
  } catch {}

  try {
    const initBranch = execFileSync("git", ["config", "init.defaultBranch"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (initBranch) return initBranch;
  } catch {}

  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/master"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "master";
  } catch {}

  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/main"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "main";
  } catch {}

  return "master";
}

/**
 * T177: the image order is specialist, project, the project's devcontainer,
 * global, default. The global layer's `containment.image` therefore must not
 * merge into `image` (where it would beat the devcontainer); it is kept as
 * `global_image`, which the image resolution ranks after the devcontainer.
 */
export function globalImageApart(value: ConfigFile): ConfigFile {
  const c = value.containment;
  if (c?.image === undefined) return value;
  const { image, ...rest } = c;
  return { ...value, containment: { ...rest, global_image: image } };
}


/**
 * T180: `containment.minimum` is a floor, so it is not "last layer wins": only
 * the user and project files may set it, and the higher of the two applies. A
 * specialist, the environment or a flag that set it would be a caller lowering
 * (or raising, which is harmless but unreadable) its own floor, so those layers
 * are not consulted. A value outside the three levels is an error, not a floor
 * of "off".
 */
function applyContainmentFloor(resolved: ResolvedConfig, layers: ConfigLayer[]): ResolvedConfig {
  let minimum: ContainmentLevel = "off";
  for (const layer of layers) {
    if (layer.name !== "global" && layer.name !== "project") continue;
    const set = layer.value.containment?.minimum;
    if (set === undefined) continue;
    if (!CONTAINMENT_LEVELS.includes(set)) {
      throw new Error(
        `lykos config: containment.minimum must be one of ${CONTAINMENT_LEVELS.join(", ")}; got ${JSON.stringify(set)}${layer.path !== undefined ? ` in ${layer.path}` : ""}`,
      );
    }
    if (CONTAINMENT_LEVELS.indexOf(set) > CONTAINMENT_LEVELS.indexOf(minimum)) minimum = set;
  }
  return { ...resolved, containment: { ...resolved.containment, minimum } };
}

function validatePathRules(layer: ConfigLayer): void {
  const pr = layer.value.path_rules;
  if (!pr) return;
  if (typeof pr !== "object" || Array.isArray(pr)) {
    throw new Error(
      `lykos config: path_rules must be a mapping of access (read, write) to pattern rules${layer.path ? ` in ${layer.path}` : ""}`,
    );
  }
  for (const [access, rules] of Object.entries(pr)) {
    if (access === "remove") {
      if (!Array.isArray(rules) || !rules.every((r) => typeof r === "string")) {
        throw new Error(
          `lykos config: path_rules.remove must be a list of pattern strings${layer.path ? ` in ${layer.path}` : ""}`,
        );
      }
      continue;
    }
    if (access !== "read" && access !== "write") {
      throw new Error(
        `lykos config: unknown access ${JSON.stringify(access)} in path_rules (must be "read" or "write")${layer.path ? ` in ${layer.path}` : ""}`,
      );
    }
    if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
      throw new Error(
        `lykos config: path_rules.${access} must be a mapping of pattern to decision${layer.path ? ` in ${layer.path}` : ""}`,
      );
    }
    for (const [pattern, decision] of Object.entries(rules)) {
      if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
        throw new Error(
          `lykos config: invalid decision ${JSON.stringify(decision)} for path_rules.${access}.${pattern} (must be "allow", "ask", or "deny")${layer.path ? ` in ${layer.path}` : ""}`,
        );
      }
    }
  }
}

/** Resolves config across all six layers. Never throws on a missing file — a missing config.yaml is normal before `lykos init`. Throws when `specialistName` names a specialist that does not resolve (see `LoadConfigOptions.specialistName`). */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const globalDir = opts.globalDir ?? join(homedir(), ".lykos");
  const env = opts.env ?? process.env;

  const layers: ConfigLayer[] = [
    { name: "defaults", present: true, value: SHIPPED_DEFAULTS as ConfigFile },
    loadFileLayer("global", globalConfigPath(globalDir)),
    loadFileLayer("project", projectConfigPath(cwd)),
    // Specialists ticket 01: sixth layer, between project and env — "a specialist
    // beats project configuration because the user selected it explicitly
    // for this session." Absent whenever no specialist was selected, same as
    // "flags" below when the caller passed none.
    opts.specialistName !== undefined
      ? resolveSpecialistLayer(opts.specialistName, cwd, globalDir, opts.shippedSpecialistsDir ?? shippedSpecialistsDir())
      : { name: "specialist", present: false, value: {} },
    envLayer(env),
    { name: "flags", present: Boolean(opts.flags && Object.keys(opts.flags).length > 0), value: opts.flags ?? {} },
  ];

  let resolved = SHIPPED_DEFAULTS;
  for (const layer of layers.slice(1)) {
    validatePathRules(layer);
    const removed = removedKeyProblem(layer);
    if (removed !== undefined) throw new Error(`lykos config: ${removed}`);
    const reserved = reservedKeyProblem(layer);
    if (reserved !== undefined) throw new Error(`lykos config: ${reserved}`);
    const modeProb = permissionModeInConfigProblem(layer);
    if (modeProb !== undefined) throw new Error(`lykos config: ${modeProb}`);
    validateSealConfig(layer);
    validateMcpConfig(layer);
    resolved = applyLayer(resolved, layer.name === "global" ? globalImageApart(layer.value) : layer.value);
  }
  const globalLayer = layers.find((l) => l.name === "global");
  const projectLayer = layers.find((l) => l.name === "project");
  const globalSecretPaths = globalLayer?.value.containment?.secret_paths;
  const projectSecretPaths = projectLayer?.value.containment?.secret_paths;
  resolved = {
    ...resolved,
    path_rules: {
      global: {
        ...(globalLayer?.value.path_rules ?? {}),
        ...(globalSecretPaths && globalSecretPaths.length > 0 ? { secret_paths: globalSecretPaths } : {}),
      },
      project: {
        ...(projectLayer?.value.path_rules ?? {}),
        ...(projectSecretPaths && projectSecretPaths.length > 0 ? { secret_paths: projectSecretPaths } : {}),
      },
    },
  };
  resolved = applyContainmentFloor(resolved, layers);
  // T167: a rerun command with no `{files}` would rerun something other than
  // the failed files; refused here rather than quietly never rerunning.
  const rerunProblem = gateRerunCommandProblem(resolved.gate.rerun_command);
  if (rerunProblem !== undefined) throw new Error(`lykos config: ${rerunProblem}`);
  if (typeof resolved.gate.rerun_failures !== "boolean") {
    throw new Error("lykos config: gate.rerun_failures must be true or false");
  }
  if (typeof resolved.edit.require_read !== "boolean") {
    throw new Error("lykos config: edit.require_read must be true or false");
  }

  return { resolved, layers };
}
