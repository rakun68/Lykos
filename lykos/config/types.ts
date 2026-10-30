// Config shape mirrors docs/05-cli-and-config.md §3. Every field optional at
// the file layer, because a layer only overrides what it actually sets;
// `resolveConfig()` (load.ts) is what guarantees the final object is complete.

export type OnExceed = "stop" | "downgrade" | "prompt";

export type { ExtensionDecl } from "./extensions.js";
import type { ExtensionDecl } from "./extensions.js";
import type { InteractionMode } from "../gate/modes.js";
import type { RawPathRules } from "../gate/path-rules.js";

/**
 * Specialists ticket 02 (ADR-0015): the thinking-level vocabulary Pi's own
 * preset extension uses (`examples/extensions/preset.ts`). Not re-exported
 * from the SDK because no public export carries this exact literal union —
 * copied rather than widened, so an invalid level is a type error here too.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * T35.1 (docs/13-model-access.md D3.0a, docs/05-cli-and-config.md §3):
 * `auth` names the route recorded per call as `calls.auth_mode`. A
 * credential *source* is `$ENV_VAR` or `!command` — never a literal key.
 */
export type ProviderAuth = "api_key" | "oauth_subscription" | "vendor_cli" | "cloud_provider" | "gateway";

export interface ProviderModelDecl {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderDecl {
  auth: ProviderAuth;
  /**
   * Claim that rates AND cache semantics are verified in prices.yaml.
   * Default false: reachable is not priced (T36 / D3.0c). The ledger
   * still consults prices.yaml and will record `unpriced` if the claim
   * is a lie.
   */
  priced?: boolean;
  /** `$ENV_VAR` or `!command`. Never a literal credential. */
  source?: string;
  /**
   * T36.4: for `plan_credit` providers, whether the user has enabled the
   * vendor's overflow billing. Presence of the flag, never a live probe —
   * doctor makes no API calls.
   */
  overflow_billing?: boolean;
  /** Custom-provider fields, translated into Pi's models.json (T35.2). */
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: ProviderModelDecl[];
  /**
   * P14.3 ticket 05 (ADR-0026): when every OAuth credential in this provider's
   * pool is cooling, rotate on to its API-key credentials. Default false: a
   * subscription never falls back to a metered key without this opt-in.
   */
  fallbackToApiKey?: boolean;
}

export type ProvidersConfig = Record<string, ProviderDecl>;

export interface ModelsConfig {
  default?: string;
  roles?: Record<string, string>;
  /**
   * T89: ordered `provider/model` alternates to continue on when the chosen
   * model is unreachable AFTER Pi's own retries are exhausted. Empty by
   * default and deliberately so — an implicit fallback chain makes every
   * per-model number in the archive wrong without anyone knowing to look.
   */
  fallback?: { chain?: string[]; max_switches?: number };
  /**
   * Model a delegate gets when the call does not say ("specialist" | "parent" | model id).
   */
  delegate?: DelegateModelSetting;
}

export type DelegateModelSetting = "specialist" | "parent" | (string & {});

export interface BudgetConfig {
  per_run_usd?: number;
  per_day_usd?: number;
  on_exceed?: OnExceed;
  max_concurrent_delegates?: number;
}

export interface TelemetryConfig {
  hud?: boolean;
  ledger?: string;
  prices?: string;
}

export interface FlagsConfig {
  delegation?: boolean;
  retrieval?: boolean;
  proactive_compaction?: boolean;
  routing?: boolean;
  draft_verify?: boolean;
  cache_stable_head?: boolean;
  /** T23: YAGNI/one-liner output rule. On for budget/cheap-worker presets;
   * a stronger or `deliberate` preset sets this false in its own overlay. */
  output_diet?: boolean;
}

/**
 * T19 (`docs/10-phase2-tasks.md`): compaction is threshold-triggered, not
 * emergency-triggered. `threshold` is a share of the model context window
 * (default 0.80, clamped 0.65–0.85). The snip knobs (`snip_after_turns`,
 * `snip_max_bytes`) were read only by the retired delegate container and are
 * gone (T185); a config that still carries them is inert.
 */
export interface CompactionConfig {
  threshold?: number;
  /**
   * T188 (spec #15): overwrite an earlier `read` result that a newer read of the
   * same file has superseded. Default true. See `loop/tool-result-prune.ts`.
   */
  supersede_reads?: boolean;
  /** T188: overwrite a result whose tool flagged it useless. Default true. */
  drop_useless?: boolean;
  /**
   * T190 (spec #15): the compaction methods, tried in this order until one
   * works: `note`, `handoff`, `shake`, `summary`. Unknown names are ignored.
   * Pi's summary always ends the chain. See `loop/compaction-chain.ts`.
   */
  method_order?: string[];
}

/**
 * T69 (Phase 9). Parameters only. T158 (ADR-0028): the on/off switch is
 * whether `lykos-repo-map` is listed in `extensions:`; `flags.retrieval` no
 * longer controls it. The ledger's `flag_retrieval` records whether a map
 * actually rode the head.
 */
export interface RetrievalConfig {
  repo_map?: {
    /** Tokens. Above ~2000 the map IS the pollution it exists to remove (problems/06). */
    max_tokens?: number;
    max_files_per_dir?: number;
  };
}

/**
 * T99 (`docs/24-strength-and-tooling-audit.md` §2.1). The post-edit feedback
 * loop. Every field is optional and the shipped default is "on, with a
 * command discovered from the project" — a project that has no discoverable
 * check simply has no loop, which is what every Lykos session had before T99.
 *
 * `command` is deliberately a single command rather than a list: the loop
 * runs after EVERY successful edit, and a list is how a two-second check
 * becomes a thirty-second one. The per-task question — the test suite —
 * belongs to T100's gate, not here.
 */
export interface FeedbackConfig {
  enabled?: boolean;
  command?: string;
  timeout_seconds?: number;
  max_output_bytes?: number;
  /** A single run slower than this switches the loop off for the session. */
  slow_disable_seconds?: number;
}

/**
 * T100 (`docs/24-strength-and-tooling-audit.md` §2.3): the mechanical
 * verification gate. The per-TASK granularity of the same mechanism T99 runs
 * per write and T98's `verify` field runs per step.
 *
 * `command` empty means "discover one from the project", which is the same
 * answer T52's session-end question offers a human — deliberately, so the
 * gate and the question never disagree about what "does it work" means here.
 */
export interface GateConfigFile {
  enabled?: boolean;
  command?: string;
  timeout_seconds?: number;
  /** Grade a session that edited nothing. Off by default; it says more about the repo than the session. */
  gate_read_only_sessions?: boolean;
  /**
   * T167 (ADR-0030): when the gate's command fails, rerun only the failed test
   * files, once. Passing on rerun records `success` and names the flaky tests,
   * unless the session edited their file. On by default.
   */
  rerun_failures?: boolean;
  /**
   * T167: the rerun command, `{files}` standing for the failed files. Empty
   * derives one from a `node --test` / `tsx --test` test script; with neither,
   * nothing is rerun.
   */
  rerun_command?: string;
}

/**
 * T102: the skills roster. Pi already discovers and formats skills; this is
 * the Lykos-owned location plus a deliberate cap, because §2.5's load-bearing
 * caveat is that skill *selection* degrades with roster size.
 */
export interface SkillsConfig {
  enabled?: boolean;
  max?: number;
  /**
   * Specialists ticket 02: an explicit named roster — "which skills load for
   * this session" (ADR-0015). When set, only these names load (subject to
   * ticket 05's missing-skill check and the cap above); when absent, every
   * discovered skill is a candidate, same as before this field existed.
   */
  roster?: string[];
}

/**
 * T168 part B (ADR-0031, decision 11): the one `edit:` key left after
 * `edit.mode` was removed (a config that still sets `mode` fails to load).
 *
 * `require_read` makes `edit` and `write` refuse an existing file the session
 * has not read, or that changed since it was read or since Lykos's own last
 * `edit`/`write` of it. A partial read counts. A new file is exempt. Off by
 * default: it costs a model that already reads first nothing, and costs one
 * that edits blind a rejected call it can recover from, which is the point.
 */
export interface EditConfig {
  require_read?: boolean;
}

/**
 * T195: sealed TDD configuration.
 *
 * `base` defaults to the repo's default branch: origin/HEAD, else init.defaultBranch, else master/main.
 * `test_command` is a template containing `{files}`, defaulting to "node --import tsx --test {files}".
 * `test_globs` matches test files to seal.
 * `always_sealed` matches runner config/setup files, fixtures, and snapshots to seal.
 */
export interface SealConfig {
  base?: string;
  test_command?: string;
  test_globs?: string[];
  run_globs?: string[];
  always_sealed?: string[];
  writers?: string[];
  enforce_for?: string[];
  weakening_patterns?: string[];
  resolver?: "orchestrator" | "test-writer";
  escalate_after?: number;
}

/**
 * P10.4 (ticket 15, D4): one language server, as configuration declares it.
 *
 * `command` is resolved against the project's own `node_modules` first and
 * then PATH (`tools/lsp-client.ts`), so a project that pins a server version
 * gets that version rather than whatever a global install happens to be.
 * `extensions` is the routing table and there is no content sniffing: a file
 * whose extension no entry claims has no server, and the tool says so.
 */
export interface LspServerDecl {
  command: string;
  args?: string[];
  extensions: string[];
}

/**
 * P10.4 (ticket 15, D4): the server table.
 *
 * Merged BY KEY across layers, the rule `providers:` follows — a project that
 * adds `python:` keeps the shipped `typescript:` entry, and a project that
 * re-declares `typescript:` replaces that one entry rather than the table.
 * The alternative, replace-on-set, would make adding a second language an
 * invitation to silently drop the first.
 */
export interface LspConfig {
  servers?: Record<string, LspServerDecl>;
}

/**
 * P10.6 (ticket 19, D6): the evaluation cell's backends.
 *
 * `python` is the declared-and-unconfigured half. The shipped default is the
 * empty string, which means "no interpreter", and `eval` with `language: "py"`
 * answers by naming this key rather than by pretending Python does not exist.
 * The knob is here on the day the tool ships rather than on the day the
 * backend does, because "how would I turn this on" is the question a model
 * hands to a human, and a setting that does not exist yet cannot be named in
 * an answer.
 */
export interface EvalConfig {
  /** The Python interpreter to use, e.g. `python3`. Empty means none is configured. */
  python?: string;
}

/**
 * P10.7 (ticket 12, D2): the search provider, as a declaration rather than as
 * a dependency.
 *
 * `provider` names which request shape `tools/web-search.ts` builds,
 * `endpoint` is the URL it builds against, and `key_env` names the environment
 * variable that holds the key. **The key itself is never here**, for the
 * reason `providers:` never holds one either: a credential in a config file is
 * a credential in a backup, a screenshot and a paste.
 *
 * Ticket 24 D1: the shipped provider is `auto` — a configured Brave key, then a
 * configured Perplexity key, then Exa's keyless hosted endpoint, then
 * DuckDuckGo's HTML page — whose `endpoint` and `key_env` are empty because
 * each backend uses its own. `endpoint` and `key_env` apply to an explicit
 * provider (`brave`, `perplexity`, `exa`, `duckduckgo`); an explicit keyed
 * provider with no key still answers by naming these keys (D3).
 */
export interface WebSearchConfig {
  provider?: string;
  endpoint?: string;
  key_env?: string;
}

export interface WebConfig {
  search?: WebSearchConfig;
}

/**
 * T109: cross one context boundary by starting a fresh session. T150: chosen by
 * `context_strategy: continue`; the old `enabled` key is gone and ignored.
 */
/**
 * T151: `self_compact:` — the tier table and its overrides, as configuration
 * wrote them. Token counts may be integers or strings such as "64k" / "1M"
 * (decimal). Kept loose here: `validateSelfCompactConfig` in
 * `loop/self-compact.ts` is the one place that checks it, at boot, and refuses
 * a wrong value by name.
 */
export interface SelfCompactConfig {
  /** Replaces the whole table when set; rows smallest window first. */
  tiers?: Array<{ window: number | string; notice: number | string; warning: number | string; cutoff: number | string }>;
  /** Per-model thresholds, keyed `provider/model` or bare model id. Merged by key across layers. */
  models?: Record<string, { notice: number | string; warning: number | string; cutoff: number | string }>;
  /** Per-specialist thresholds, keyed by specialist name. Merged by key across layers. */
  specialists?: Record<string, { notice: number | string; warning: number | string; cutoff: number | string }>;
  /**
   * T157: how much recent context every compaction keeps behind the summary
   * and the agent's note, in tokens. Default 20000, Pi's own.
   * Passed to Pi's compaction settings for the session (an override, never a
   * `.pi/` file).
   */
  keep_recent_tokens?: number | string;
}

export interface ContinuationConfig {
  /** Maximum successor sessions for one task. Default 1. */
  max?: number;
}

/**
 * T110/T149: the setting of the `lykos-reviewer` default extension — one
 * read-only child session, once, after the gate, against the session's diff.
 */
export interface ReviewerConfig {
  enabled?: boolean;
  /** Optional model override (e.g. "provider/modelId"). Empty string or undefined means inherit parent model. */
  model?: string;
}

/** T223, T224, T226: MCP worker settings. */
export interface McpConfig {
  /** Maximum live concurrent sessions (lykos_start and blocking tools). Default 4. */
  max_sessions?: number;
  /** T224: Timeout in seconds for an unanswered question in a delegated session before deciding alone. Default 600. */
  ask_timeout?: number;
  /** T226: Size of the warm pool of pre-spawned session-child processes. Default 2. */
  warm_pool?: number;
}

/**
 * T105: a deterministic policy as a command rather than as prompt text.
 * `event` is one of session_start / turn_start / pre_tool / post_tool /
 * session_end; a non-zero exit denies (on pre_tool) or annotates.
 */
export interface HookDeclFile {
  event?: string;
  tools?: string[];
  command?: string;
  timeout_seconds?: number;
  blocking?: boolean;
}

export interface MemoryConfig {
  enabled?: boolean;
  scope?: Array<"project" | "global">;
  max_inject_tokens?: number;
}

/**
 * The UI surface of docs/07-ui-and-hud.md §6. T38 lands the segment registry,
 * watch panels, and user themes; earlier fields (theme/color/glyphs) were T4.5.
 */
export interface UiHudConfig {
  enabled?: boolean;
  format?: string;
  delegate_line?: boolean;
  max_lines?: number;
  show_avoided?: boolean;
}

export interface UiStatuslineConfig {
  enabled?: boolean;
  format?: string;
  delegate_line?: boolean;
  refresh_hint?: number;
}

export interface UiWatchConfig {
  panels?: string[];
  refresh_hz?: number;
}

export interface UiConfig {
  theme?: string; // shipped palette name | user theme | path | "auto"
  color?: "auto" | "always" | "never" | "16" | "256" | "truecolor";
  glyphs?: "unicode" | "ascii" | "nerdfont";
  /** Live avoided invites gaming your own metric (§10) — off by default on S1/S2. */
  show_avoided?: boolean;
  /** @deprecated prefer statusline.refresh_hint; kept for existing configs. */
  statusline_refresh_hint?: number;
  hud?: UiHudConfig;
  statusline?: UiStatuslineConfig;
  watch?: UiWatchConfig;
  /** T42.4: the full-screen surface's always-on ledger footer. Default on (07-ui-and-hud.md §9 acceptance item 6); off shrinks the viewport rather than leaving a blank row. */
  footer?: boolean;
  /**
   * Where the tab-completion popup sits relative to the composer.
   *
   * `above` (the default) puts it between the transcript and the input box,
   * which is where a shell and an editor put it — the eye
   * is already on the line being typed. `below` puts it under the composer,
   * above the ledger footer. Either way it is a layout region whose rows
   * come out of the viewport, never something composited over the
   * transcript (2026-09-02 round two, item 4).
   */
  completion_position?: "above" | "below";
  /**
   * Whether a tool result's raw JSON preview is printed under the tool's
   * own rendered block. **Default false since 2026-09-02 (round twelve,
   * item 1):** "I dont think users gonna need that line."
   *
   * It was unconditional, and for an `edit` it duplicated — as one
   * unwrapped wall of escaped JSON carrying both a `diff` and a `patch`
   * field — exactly the change the diff block directly above it had
   * already drawn properly. The information stays reachable two ways:
   * `/verbose` turns it on for the rest of the session, and this key turns
   * it on permanently.
   */
  tool_result_preview?: boolean;
  /**
   * How long a single tool call is expected to take, in seconds, before
   * the waiting line under it starts saying it has gone on too long
   * (2026-09-02 round twelve, item 2). Default 300 (five minutes).
   *
   * A REPORTING limit, not a kill switch — see `fullscreen-ui.ts`'s
   * `startWaiting()` for why Lykos cannot terminate a tool it does not own
   * and what it does at the limit instead. 0 shows elapsed time with no
   * limit named at all.
   */
  tool_wait_limit_seconds?: number;
}

export interface ResolvedUiConfig {
  theme: string;
  color: "auto" | "always" | "never" | "16" | "256" | "truecolor";
  glyphs: "unicode" | "ascii" | "nerdfont";
  show_avoided: boolean;
  statusline_refresh_hint: number;
  hud: Required<UiHudConfig>;
  statusline: Required<UiStatuslineConfig>;
  watch: { panels: string[]; refresh_hz: number };
  footer: boolean;
  completion_position: "above" | "below";
  tool_result_preview: boolean;
  tool_wait_limit_seconds: number;
}

/** Shape of a config.yaml file on disk — every layer is a partial of this. */
/**
 * T173 (spec #22): containment, the boundary a session's commands run inside.
 * The session itself stays on the host; only the commands it starts go into the
 * container. `off` (the default) runs them on this machine, `required` refuses
 * to start without a container runtime, and `auto` uses one when it answers and
 * says so when it falls back.
 */
export interface ContainmentConfig {
  level?: "off" | "auto" | "required";
  /**
   * T180: a floor on `level` (`off` < `auto` < `required`). Read from the user
   * and project config only, and the higher of the two wins, so a project
   * cannot lower a floor the user set. A request below it is refused before
   * boot; an `auto` that would fall back to the host counts as `off`. `off`
   * (the default) is no floor.
   */
  minimum?: "off" | "auto" | "required";
  /** Which runtime to drive. `auto` prefers Podman when both answer. */
  runtime?: "auto" | "docker" | "podman";
  /** `none` is the runtime's no-network mode. */
  network?: "open" | "none";
  /** The container's memory cap, in the runtime's own notation (`4g`). */
  memory?: string;
  cpus?: string;
  /**
   * T175: environment variable names a contained command may receive from this
   * machine, on top of the fixed base. Nothing else is forwarded. Setting this
   * in a layer replaces the list below it.
   */
  env_allowlist?: string[];
  /**
   * T175: patterns for workspace files a contained command sees as empty, in
   * addition to the shipped ones (`.env*`, `.npmrc`, `*.pem`, `*.key`,
   * `id_*`), which always apply. A pattern with no `/` matches a file or
   * directory name anywhere in the workspace; one with a `/` matches the path
   * from the workspace root. `*` and `?` are the only wildcards.
   */
  secret_paths?: string[];
  /**
   * T177: the image the commands run in. Empty or unset, the project's
   * `.devcontainer/devcontainer.json` names it, then the global config's image,
   * and without any Lykos's own toolchain image does. A specialist's
   * `containment.image` lands here too, in the specialist layer, so it beats
   * project config and the devcontainer.
   */
  image?: string;
  /**
   * Not a key to write: the loader moves the global config's `containment.image`
   * here, so that it ranks below a project's devcontainer while the project's
   * own `containment.image` ranks above it.
   */
  global_image?: string;
}

export interface ConfigFile {
  version?: number;
  /**
   * T29: published third-party Pi extensions, declared rather than hardcoded.
   * A layer that sets this REPLACES the list below it rather than merging into
   * it — the list is ordered and the order is load order, so a merge would
   * silently change which extension mutates the prompt first. It is also what
   * makes "removing the declaration removes the extension" literally true.
   */
  extensions?: ExtensionDecl[];
  /**
   * T147 (backlog D25): Lykos extensions — packages written against Lykos's
   * own extension API (`extensions/api.ts`) rather than Pi's. Same entry shape
   * as `extensions:` and the same replace-not-merge rule, for the same reason:
   * the list is ordered and the order is load order.
   */
  lykos_extensions?: ExtensionDecl[];
  /**
   * T35.1: providers and credential *sources*. Merged by key across
   * layers (a project that adds `anthropic:` does not wipe shipped
   * `deepseek:`). A layer that sets a key replaces that provider.
   */
  providers?: ProvidersConfig;
  models?: ModelsConfig;
  budget?: BudgetConfig;
  telemetry?: TelemetryConfig;
  flags?: FlagsConfig;
  compaction?: CompactionConfig;
  memory?: MemoryConfig;
  retrieval?: RetrievalConfig;
  /** T99: the post-edit feedback loop. */
  feedback?: FeedbackConfig;
  /** T100: the mechanical verification gate. */
  gate?: GateConfigFile;
  /** T102: the skills roster and its cap. */
  skills?: SkillsConfig;
  /** T168 part B: `edit.require_read`. (`edit.mode` is gone; a layer that sets it fails to load.) */
  edit?: EditConfig;
  /** T195: sealed TDD configuration. */
  seal?: SealConfig;
  /** P10.4 (ticket 15): which language server serves which extensions. Merged by key across layers. */
  lsp?: LspConfig;
  /** P10.6 (ticket 19): the evaluation cell's backends. Empty `python` is the shipped default and means "unconfigured". */
  eval?: EvalConfig;
  /** P10.7 (ticket 12): the search provider declaration. Merged one level deep, like `retrieval.repo_map`. */
  web?: WebConfig;
  /**
   * T150: the context strategy — `self-compact` (default), `continue` or `pi`.
   * Kept as a string here so an unknown value reaches `resolveContextStrategy`,
   * which falls back to `pi` and says so rather than failing the load.
   */
  context_strategy?: string;
  /** T151: the self-compact tier table and its per-model / per-specialist overrides. */
  self_compact?: SelfCompactConfig;
  /** T109: the cap for `context_strategy: continue`; one boundary by default. */
  continuation?: ContinuationConfig;
  /** T110: off by default; runs on parent model unless overridden. */
  reviewer?: ReviewerConfig;
  /** T173: where the session's commands run. Off by default. */
  containment?: ContainmentConfig;
  /** T223: MCP worker settings. */
  mcp?: McpConfig;
  /** T210: path access rules determining allow | ask | deny per path (ADR-0042). */
  path_rules?: RawPathRules;
  /**
   * T105: project hooks. A layer that sets this REPLACES the list below it,
   * the same rule `extensions:` follows and for the same reason — the list is
   * ordered, the order is authority, and a merge would silently change which
   * policy runs first.
   */
  hooks?: HookDeclFile[];
  ui?: UiConfig;
  /**
   * The first specialist field wired end to end. Text injected into the system prompt as its
   * own head block (`session/specialist-head.ts`). Normally arrives through the
   * specialist layer (`config/specialists.ts`), never written by hand in
   * `config.yaml` — but the field lives on `ConfigFile` like every other
   * section because the specialist layer's value IS a `ConfigFile` partial, and
   * a flag or project config can still set it directly, consistent with "a
   * flag beats a specialist, a specialist beats project configuration."
   *
   * The other fourteen specialist fields (ADR-0015) are ticket 02's scope. Each
   * one lands here the same way: an optional field on `ConfigFile`, merged by
   * `applyLayer` in `load.ts`, made `Required` on `ResolvedConfig`.
   */
  /** T217 (issue #72, ADR-0045): output style name ("default", "minimal", etc.). */
  output_style?: string;
  instructions?: string;

  // --- Specialists ticket 02 (ADR-0015): the remaining Pi-compatible and
  // Lykos-owned live fields. Each stays a plain optional scalar or a
  // replace-on-set list, like `instructions` above — "absent" always means
  // "inherit from the layer below", never "reset to default" (spec, "The
  // shape of a specialist"). `feedback`, `gate` and `skills` already existed as
  // sections (T99/T100/T102); a specialist sets them through those same
  // sections rather than new top-level fields, so nothing here duplicates
  // them.

  /** Pi-compatible. Applied together with `model` — see `resolveBootModel`. */
  provider?: string;
  /** Pi-compatible. Applied together with `provider`. */
  model?: string;
  /** Pi-compatible. */
  thinkingLevel?: ThinkingLevel;
  /** Pi-compatible. Replaces the resident tool set entirely, matching Pi's own semantics. */
  tools?: string[];
  /** Lykos. Adds a tool to the resident set on top of whatever `tools` resolved to. */
  tools_add?: string[];
  /**
   * Lykos. Removes a tool from the resident set. Until P10's mounted-tool
   * transport lands, this genuinely removes capability for the session
   * rather than moving it to a reachable "available" pool — see
   * `resolveSpecialistTools()` in `session/boot.ts`.
   */
  tools_remove?: string[];
  /** Lykos. One of the three interaction modes (`gate/modes.ts`). */
  mode?: InteractionMode;
  /** The read-only ceiling (ADR-0043, T214): a specialist's `read_only`, applied live at the approval gate whatever the permission mode. */
  readOnly?: boolean;
  /** Lykos. Shown when specialists are listed; not injected into the prompt. */
  description?: string;
  /** Specialists band 2 ticket 01: prompt mode ("append" | "override"). Default "append". */
  prompt_mode?: SpecialistMode;
  /** Specialists band 2 ticket 01: tool restriction mode ("append" | "override"). Inert until ticket 02. */
  tools_mode?: SpecialistMode;
}

export type SpecialistMode = "append" | "override";

/** Fully resolved config — every field required, after merging all layers. */
export interface ResolvedConfig {
  version: number;
  extensions: ExtensionDecl[];
  lykos_extensions: ExtensionDecl[];
  providers: ProvidersConfig;
  models: Required<ModelsConfig>;
  budget: Required<BudgetConfig>;
  telemetry: Required<TelemetryConfig>;
  flags: Required<FlagsConfig>;
  compaction: Required<CompactionConfig>;
  memory: Required<MemoryConfig>;
  retrieval: Required<RetrievalConfig>;
  /** T99. `command: ""` means "discover one from the project", not "run an empty shell". */
  feedback: Required<FeedbackConfig>;
  /** T100. Same convention: an empty command means "discover one". */
  gate: Required<GateConfigFile>;
  /**
   * T102, widened by specialists ticket 02. `roster` stays genuinely optional
   * even here (unlike `enabled`/`max`) — `undefined` means "every discovered
   * skill is a candidate" and `[]` means "load none", and collapsing that
   * distinction with `Required<...>` would make an empty specialist-declared
   * roster indistinguishable from no roster at all.
   */
  skills: Required<Omit<SkillsConfig, "roster" | "max">> & Pick<SkillsConfig, "roster" | "max">;
  /** T168 part B. Always resolved; `require_read: false` is the shipped default. */
  edit: Required<EditConfig>;
  /** T195. Sealed TDD configuration. `resolver` stays optional so unconfigured can be distinguished from explicit test-writer. */
  seal: Required<Omit<SealConfig, "resolver">> & Pick<SealConfig, "resolver">;
  /** P10.4 (ticket 15). Always resolved; `servers: {}` is a session with no language server at all, which is a choice a project can make. */
  lsp: Required<LspConfig>;
  /** P10.6 (ticket 19). Always resolved; `python: ""` is the shipped default and is what makes `eval` report the key rather than an unknown language. */
  eval: Required<EvalConfig>;
  /** P10.7 (ticket 12). Always resolved; the shipped declaration names a provider and an endpoint and no key, which is what makes `web_search` report the setting rather than fail. */
  web: { search: Required<WebSearchConfig> };
  /** T150. Always resolved; `loop/context-strategy.ts` turns it into the one active strategy. */
  context_strategy: string;
  /** T151. Always resolved; validated at boot, not at load. */
  self_compact: Required<SelfCompactConfig>;
  /** T109. The cap is deliberately hard: one successor by default. */
  continuation: Required<ContinuationConfig>;
  /** T110. Off by default; one read-only scout at session end. */
  reviewer: Required<ReviewerConfig>;
  /** T173. Always resolved; the shipped level is `off`. */
  containment: Required<ContainmentConfig>;
  /** T223. MCP worker settings. Always resolved. */
  mcp: Required<McpConfig>;
  /** T210 (ADR-0042). Path rules kept per layer ({ global, project }) so source and trust survive. */
  path_rules: { global: RawPathRules; project: RawPathRules };
  /** T105. Empty by default: the built-in policies are code, not config. */
  hooks: HookDeclFile[];
  ui: ResolvedUiConfig;
  /** Specialists ticket 01. Empty string means no specialist instructions selected. */
  /** T217 (issue #72, ADR-0045): output style name ("default", "minimal", etc.). */
  output_style: string;
  instructions: string;

  // --- Specialists ticket 02. Unlike every field above, these stay OPTIONAL on
  // the resolved shape rather than `Required<...>` with a shipped default —
  // there is no safe default to fill in. `tools: []` would mean "no tools at
  // all", not "nothing overrode the runtime's own default set", and the same
  // is true of `provider`/`model`/`mode`/`thinkingLevel`: undefined is the
  // only value that means "let the layer below — ultimately the runtime's
  // own default — decide". Every consumer already treats "unset" as
  // "inherit" for exactly this reason (`resolveBootModel`'s `specialistModel`,
  // `resolveStandaloneTools`'s `tools` override).
  // `exactOptionalPropertyTypes`: these are `X | undefined` rather than
  // `x?: X`, because `applyLayer` always writes the key (possibly with an
  // `undefined` value) rather than conditionally spreading it in — see the
  // note on `provider` above for why `undefined` here is not "missing", it
  // is the resolved value "no layer set it".
  provider: string | undefined;
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  tools: string[] | undefined;
  tools_add: string[] | undefined;
  tools_remove: string[] | undefined;
  mode: InteractionMode | undefined;
  readOnly: boolean | undefined;
  description: string | undefined;
  prompt_mode?: SpecialistMode;
  tools_mode?: SpecialistMode;
}

/**
 * `"specialist"` is the sixth layer, inserted between `"project"`
 * and `"env"`:
 *
 *   defaults -> global -> project -> specialist -> env -> flags
 *
 * A specialist beats project configuration because the user selected it
 * explicitly for this session; a flag still beats a specialist.
 */
export type ConfigLayerName = "defaults" | "global" | "project" | "specialist" | "env" | "flags";

export interface ConfigLayer {
  name: ConfigLayerName;
  path?: string;
  present: boolean;
  value: ConfigFile;
  /**
   * Specialists ticket 02: informational notices produced while resolving this
   * layer, not errors. Today only the specialist layer populates it, for the
   * three inert fields (`rules`, `delegate`, `memory`) — "a specialist setting
   * an inert field says so at selection time" (ticket 02 checkbox) rather
   * than failing or silently doing nothing. Ticket 04 is what surfaces these
   * in the interface; this is the data seam.
   */
  notices?: string[];
}
