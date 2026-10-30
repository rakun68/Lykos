// Shipped defaults — the bottom of the precedence stack in
// docs/05-cli-and-config.md §2: shipped defaults -> ~/.lykos/config.yaml ->
// .lykos/config.yaml -> env -> flags. Every field here is required so
// resolveConfig() never has to guess a missing value.

import type { ResolvedConfig } from "./types.js";
import {
  CONTINUATION_EXTENSION,
  defaultExtensionVersion,
  REPO_MAP_EXTENSION,
  REVIEWER_EXTENSION,
  PRUNE_EXTENSION,
  SEAL_EXTENSION,
  SELF_COMPACT_EXTENSION,
} from "../extensions/defaults/index.js";
import { containmentPathPlan, shippedPathRules } from "../gate/path-rules.js";
import { DEFAULT_METHOD_ORDER } from "../loop/compaction-chain.js";
import { DEFAULT_CONTEXT_STRATEGY } from "../loop/context-strategy.js";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_SELF_COMPACT_TIERS } from "../loop/self-compact.js";

/** What a contained command cannot read before any `containment.secret_paths` additions (derived from shippedPathRules). */
export const DEFAULT_SECRET_PATHS: readonly string[] = containmentPathPlan(shippedPathRules()).secretPatterns;

/** T223: default maximum live concurrent sessions for the MCP worker. */
export const DEFAULT_MCP_MAX_SESSIONS = 4;
/** T224: default timeout in seconds for unanswered questions in a delegated session. */
export const DEFAULT_MCP_ASK_TIMEOUT = 600;
/** T226: default size of the warm pool of session-child processes. */
export const DEFAULT_MCP_WARM_POOL = 2;

/** T195: default glob patterns matching test files to seal. */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "test/**",
  "tests/**",
  "**/__tests__/**",
];

/** Default glob patterns matching test files to execute in runner (red check and green run). */
export const DEFAULT_RUN_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.*",
];

/** T195: default glob patterns matching runner config, setup files, fixtures, and snapshots to seal. */
export const DEFAULT_ALWAYS_SEALED: readonly string[] = [
  "vitest.config.*",
  "vitest.setup.*",
  "jest.config.*",
  ".mocharc*",
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/__snapshots__/**",
];

/** T195: default test command template containing {files}. */
export const DEFAULT_TEST_COMMAND = "node --import tsx --test {files}";

/** T199: default specialist names allowed to write sealed tests. */
export const DEFAULT_SEAL_WRITERS: readonly string[] = ["test-writer"];

/** T199: default specialist names enforced against editing sealed tests. */
export const DEFAULT_SEAL_ENFORCE_FOR: readonly string[] = ["implementer"];

/** T202: default weakening patterns detected outside sealed files. */
export const DEFAULT_SEAL_WEAKENING_PATTERNS: readonly string[] = [
  ".skip(",
  ".only(",
  "xit(",
  "process.env.VITEST",
  "process.env.NODE_TEST_CONTEXT",
  'NODE_ENV === "test"',
  "NODE_ENV === 'test'",
  'NODE_ENV == "test"',
  "NODE_ENV == 'test'",
];

export const SHIPPED_DEFAULTS: ResolvedConfig = {
  version: 1,
  // T29: `pi-cache-optimizer` is a DECLARATION now, not a hardcoded path in
  // the session boot. It is here rather than special-cased because the point
  // of the surface is that the extension Lykos already ships goes through it
  // like any other. `lykos extensions install` installs, config.yaml
  // activates, and `lykos doctor` reconciles the two.
  // T168 (ADR-0031): `pi-hashline-edit` is no longer shipped. It registers
  // its own `read` and `edit` under Pi's tool names, which would replace the
  // numbered `read` and the text-replacement `edit` Lykos carries, and there
  // is one editor now. `config/extensions.ts` drops it if a config still
  // declares it.
  extensions: [
    { name: "pi-cache-optimizer", version: "2.8.6", scope: ["hop0"] },
    // T158 (ADR-0028): `lykos-repo-map`, the first default extension, ships
    // OFF — it is not in this list. Its entry in a project's `extensions:` is
    // its only switch: listed, it loads and adds the map; unlisted, it does not.
    // T150: the `continue` context strategy. Loaded everywhere and inert unless
    // `context_strategy` below is `continue`; removing it from this list makes
    // `continue` fall back to Pi's compaction, and the session says so.
    { name: CONTINUATION_EXTENSION, version: defaultExtensionVersion(), scope: ["hop0"] },
    // T151: the `self-compact` context strategy — the gauge now, the handoff in
    // ticket 12. Inert unless `self-compact` is the ACTIVE strategy; its
    // guidance rides the message stream of one call, never the prompt.
    { name: SELF_COMPACT_EXTENSION, version: defaultExtensionVersion(), scope: ["hop0"] },
    // T188 (ADR-0039): overwrite superseded reads and useless results. Its entry
    // here is its switch; `compaction.supersede_reads` / `drop_useless` choose
    // which rules it runs.
    { name: PRUNE_EXTENSION, version: defaultExtensionVersion(), scope: ["hop0"] },
  ],
  // T147 (D25): Lykos extensions, declared in the same shape as `extensions:`.
  // P4 T149: `lykos-reviewer`, the first default LYKOS extension — declared
  // here like any package and removed the same way (a `lykos_extensions:`
  // list without it). Its setting is `reviewer:` below, still off, so
  // declaring it changes nothing for a project that has not turned it on.
  lykos_extensions: [
    { name: REVIEWER_EXTENSION, version: defaultExtensionVersion(), scope: ["hop0"] },
    { name: SEAL_EXTENSION, version: defaultExtensionVersion(), scope: ["hop0"] },
  ],
  // T35.1: DeepSeek is the only priced cheap-tier route today
  // (DECISIONS.md 2026-08-29). Other providers are reachable once
  // declared; they are priced only once prices.yaml verifies rates
  // AND cache semantics (T36).
  providers: {
    deepseek: { auth: "api_key", priced: true },
  },
  models: {
    default: "deepseek-v4-flash",
    roles: {
      worker: "deepseek-v4-flash",
      scout: "deepseek-v4-flash",
      watcher: "deepseek-v4-flash",
    },
    // T89: empty means off. A session must never quietly finish on a
    // different model than the one requested.
    fallback: { chain: [], max_switches: 1 },
    delegate: "specialist",
  },
  budget: {
    per_run_usd: 0.5,
    per_day_usd: 2.0,
    on_exceed: "stop",
    max_concurrent_delegates: 3,
  },
  telemetry: {
    hud: true,
    ledger: ".lykos/ledger.db",
    prices: "builtin",
  },
  flags: {
    delegation: true,
    // T158: no longer the repo map's switch (its `extensions:` entry is) and
    // read by nothing; kept so existing configs still load. The ledger's
    // `flag_retrieval` records whether a map actually rode the head.
    retrieval: false,
    proactive_compaction: true,
    routing: false,
    draft_verify: false,
    cache_stable_head: true,
    output_diet: true,
  },
  compaction: {
    threshold: 0.8,
    supersede_reads: true,
    drop_useless: true,
    // T190: the chain, in the order spec #15 names. Pi's summary is the end of it.
    method_order: [...DEFAULT_METHOD_ORDER],
  },
  // T69: parameters only. T158 (ADR-0028): the map is the `lykos-repo-map`
  // default extension, switched only by being listed in `extensions:`; these
  // are its parameters. `flags.retrieval` no longer controls it.
  retrieval: {
    repo_map: {
      max_tokens: 1500,
      max_files_per_dir: 6,
    },
  },
  // T99: on by default, with the command discovered from the project rather
  // than demanded from configuration. A project with no `typecheck` script
  // and no tsconfig discovers nothing and gets no loop, which is exactly the
  // behaviour every session had before T99 — so the default cannot break a
  // project it does not understand.
  feedback: {
    enabled: true,
    command: "",
    timeout_seconds: 120,
    max_output_bytes: 4000,
    slow_disable_seconds: 45,
  },
  // T100: the free mechanical gate CLAUDE.md has named twice as the cheapest
  // available writer of outcome='success'. On by default; it costs zero
  // tokens, runs once per session, and cannot record a success no command
  // produced. A project with no `test` script discovers nothing and is not
  // gated.
  gate: {
    enabled: true,
    command: "",
    timeout_seconds: 900,
    gate_read_only_sessions: false,
    rerun_failures: true,
    rerun_command: "",
  },
  // T102 shipped a cap of twelve here. ADR-0029 removed it: no `max:` key
  // means every discovered skill loads, as in Pi, and
  // `skills.max` stays as a ceiling a project can opt into.
  skills: {
    enabled: true,
    // No `max:` or `roster:` key — absent means "no cap" and "every
    // discovered skill is a candidate", and `exactOptionalPropertyTypes`
    // forbids writing an optional key with an explicit `undefined` value.
  },
  // T168 part B (ADR-0031, decision 11): off. A session that reads before it
  // edits loses nothing by it being off, and a rule that rejects calls is one
  // a project opts into.
  edit: {
    require_read: false,
  },
  // T195: sealed TDD configuration defaults.
  seal: {
    base: "",
    test_command: DEFAULT_TEST_COMMAND,
    test_globs: [...DEFAULT_TEST_GLOBS],
    run_globs: [...DEFAULT_RUN_GLOBS],
    always_sealed: [...DEFAULT_ALWAYS_SEALED],
    writers: [...DEFAULT_SEAL_WRITERS],
    enforce_for: [...DEFAULT_SEAL_ENFORCE_FOR],
    weakening_patterns: [],
    escalate_after: 1,
  },
  // P10.4 (ticket 15, D4): one shipped entry, for the languages this
  // repository is written in.
  //
  // `typescript-language-server` is a DEV dependency: the tests drive a real
  // server and a runtime install does not carry one. That is deliberate
  // rather than an oversight — shipping a language server inside a coding
  // agent would be shipping a toolchain — and it is why "the executable is
  // not on this machine" is a first-class answer the tool gives rather than
  // an error it throws. On a machine that has one, this entry finds it in the
  // project's own `node_modules` first and on PATH second.
  lsp: {
    servers: {
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      },
    },
  },
  // P10.6 (ticket 19, D6): JavaScript ships and needs no configuration — it
  // runs under this process's own Node. Python is declared and unconfigured,
  // and the empty string is what "unconfigured" looks like: `eval` with
  // `language: "py"` names this key instead of running anything. Shipping an
  // interpreter guess here would be worse than none, because a `python3` that
  // is not on the machine fails later and further away than a setting that
  // says plainly it was never set.
  eval: {
    python: "",
  },
  // P10.7 (ticket 12, D2): Brave is DECLARED and UNCONFIGURED. The endpoint and
  // the key variable are here so that "how would I turn this on" has an answer
  // a model can read out to a human; the key is not, and never is — it lives
  // in the environment variable named below.
  //
  // The endpoint and the variable's role come from Brave's own API
  // documentation (api-dashboard.search.brave.com, read 2026-09-21), which is
  // AGENTS.md rule 5's standard applied to a provider fact. No price, quota or
  // term of any provider is recorded in this repository, deliberately: those
  // change without notice, and a stale copy of one here would be a confident
  // lie rather than a missing fact.
  //
  // Ticket 24 D1: the shipped provider is now `auto` — a configured Brave key,
  // then a configured Perplexity key, then Exa's keyless hosted endpoint, then
  // DuckDuckGo's HTML page — so a fresh install searches with no key at all.
  // `auto` has no endpoint or key variable of its own (each backend uses its
  // own), so both are empty; naming `provider: brave` in a layer brings back
  // Brave's endpoint and variable exactly as before (`mergeWebSearch`).
  web: {
    search: {
      provider: "auto",
      endpoint: "",
      key_env: "",
    },
  },
  // T150 (spec stories 36-40): the one setting that picks what a session does
  // as its window fills — `self-compact`, `continue` or `pi`. Exactly one runs
  // and Pi's own compaction stays underneath all three. `self-compact` falls
  // back to `pi` and says so until ticket 12 builds it.
  context_strategy: DEFAULT_CONTEXT_STRATEGY,
  // T151 (spec stories 47-53): the `lykos-self-compact` tier table and the
  // per-model and per-specialist overrides on top of it. Validated at boot
  // (`loop/self-compact.ts`). Every value is a starting setting, unmeasured.
  self_compact: {
    tiers: DEFAULT_SELF_COMPACT_TIERS.map((t) => ({ ...t })),
    models: {},
    specialists: {},
    // T157: the recent context every compaction keeps; Pi's own default.
    keep_recent_tokens: DEFAULT_KEEP_RECENT_TOKENS,
  },
  // T109: the cap for the `continue` strategy. A continuation starts a new
  // paid session; one successor per task by default, so a boundary can never
  // become an unbounded loop. T150: the old `enabled` switch is gone —
  // `context_strategy: continue` is how continuation is chosen now.
  continuation: {
    max: 1,
  },
  // T110/T149: OFF. The setting of the `lykos-reviewer` default extension —
  // one read-only child session, once, after the gate, against the diff, on a
  // session that edited files. Off by default because it is a second paid
  // invocation with no arithmetic counterfactual (spec story 30). `model`
  // empty means the reviewed session's own model.
  reviewer: {
    enabled: false,
    model: "",
  },
  // T173 (spec #22): OFF. A session opts in by naming a level; the memory and
  // CPU caps are the ones the delegate sandbox has always had.
  containment: {
    level: "off",
    minimum: "off",
    runtime: "auto",
    network: "open",
    memory: "4g",
    cpus: "2",
    env_allowlist: [],
    secret_paths: [],
    image: "",
    global_image: "",
  },
  mcp: {
    max_sessions: DEFAULT_MCP_MAX_SESSIONS,
    ask_timeout: DEFAULT_MCP_ASK_TIMEOUT,
    warm_pool: DEFAULT_MCP_WARM_POOL,
  },
  // T210 (ADR-0042): path rules default to empty sets of read and write rules per layer.
  path_rules: {
    global: {},
    project: {},
  },
  // T105: empty. The built-in policies (never write to the ledger, flag a
  // credential-shaped write) are code rather than config, because a policy a
  // project can delete by editing a list is not a guarantee.
  hooks: [],
  memory: {
    enabled: true,
    scope: ["project", "global"],
    max_inject_tokens: 500,
  },
  ui: {
    theme: "sky",
    color: "auto",
    glyphs: "unicode",
    show_avoided: false,
    statusline_refresh_hint: 2,
    hud: {
      enabled: true,
      format: "{status} {tokens} | {context} | {cost}",
      delegate_line: true,
      max_lines: 2,
      show_avoided: false,
    },
    statusline: {
      enabled: true,
      format: "{model} {context} | {cost} | {rate_limits}",
      delegate_line: true,
      refresh_hint: 2,
    },
    watch: {
      panels: ["now", "cost", "tokens", "context", "health", "session"],
      refresh_hz: 4,
    },
    footer: true,
    completion_position: "above",
    // Round twelve, item 1: off. Whatever the tool did is already drawn by
    // the block above it — a diff, a read bar, a bash block.
    tool_result_preview: false,
    // Round twelve, item 2: five minutes. Lykos has no way to move a long command
    // to the background and carry on, so a number that short here would only cry wolf. This is the "longer
    // than this work usually takes" threshold for the human reading the
    // screen, not a deadline anything enforces.
    tool_wait_limit_seconds: 300,
  },
  // T217: output style. Default is "default".
  output_style: "default",
  // Specialists ticket 01. No specialist selected by default; a session boots with
  // no `## lykos-specialist` block at all rather than an empty one.
  instructions: "",
  // Specialists ticket 02. `undefined` on every one of these means "no layer
  // set it" — never a value to apply. See the comment on `ResolvedConfig`.
  provider: undefined,
  model: undefined,
  thinkingLevel: undefined,
  tools: undefined,
  tools_add: undefined,
  tools_remove: undefined,
  mode: undefined,
  readOnly: undefined,
  description: undefined,
};
