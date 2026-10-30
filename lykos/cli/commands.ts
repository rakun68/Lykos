import { firstPositional, positionals, RUN_VALUED_FLAGS } from "./args.js";
import { parseInteractionMode, type InteractionMode } from "../gate/modes.js";
import { claimProtocolStream, stdoutWrite } from "../tui/io-mode.js";
import type { ColorFlag } from "../tui/theme/resolve.js";

export interface CommandContext {
  cwd: string;
  setExitByDraining?: () => void;
}

export type CommandHandler = (args: string[], context: CommandContext) => Promise<number> | number;

export interface Command {
  name: string;
  aliases?: readonly string[];
  help: readonly string[];
  run: CommandHandler;
}

function parseColorFlag(value: string | undefined): ColorFlag | undefined {
  const allowed: ColorFlag[] = ["auto", "always", "never", "16", "256", "truecolor"];
  return allowed.includes(value as ColorFlag) ? (value as ColorFlag) : undefined;
}

const VALUE_FLAGS_SEARCH = [
  "task",
  "outcome",
  "outcome-source",
  "model",
  "shape",
  "capture",
  "since",
  "until",
  "min-cost",
  "limit",
];

function flagValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function resolveLedgerPath(cwd: string): Promise<string> {
  const { loadConfig } = await import("../config/load.js");
  const { writeResolvedConfigCache } = await import("../config/cache.js");
  const { defaultLedgerPath } = await import("../ledger/ledger.js");
  const { resolved } = loadConfig({ cwd });
  writeResolvedConfigCache(cwd, resolved);
  return resolved.telemetry.ledger === ".lykos/ledger.db"
    ? defaultLedgerPath(cwd)
    : resolved.telemetry.ledger;
}

async function readPackageJson(): Promise<{ version: string; dependencies?: Record<string, string> }> {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };
}

async function readPackageVersion(): Promise<string> {
  return (await readPackageJson()).version;
}

export const COMMANDS: readonly Command[] = [
  {
    name: "seal",
    help: [
      "  seal      sealed TDD [key init | create [<commit>] | status [--json] | verify [--branch <name>] [--commit <sha>] | hook install]",
    ],
    run: async (rest, { cwd }) => {
      const { runSeal } = await import("./seal.js");
      return runSeal(cwd, rest);
    },
  },
  {
    name: "init",
    help: [
      "  init      scaffold .lykos/ in the current project",
    ],
    run: async (_rest, { cwd }) => {
      const { runInit } = await import("./init.js");
      return runInit(cwd);
    },
  },
  {
    name: "doctor",
    help: [
      "  doctor    verify the environment [--bench-ui]",
    ],
    run: async (rest, { cwd }) => {
      const { runDoctor } = await import("./doctor.js");
      const { vtSupport } = await import("../tui/doctor-rendering.js");
      const vt = await vtSupport();
      const { loadConfig } = await import("../config/load.js");
      const { defaultImageTag } = await import("../containment/containment.js");
      const { probeConfiguredRuntimes } = await import("./doctor.js");
      const containment = await probeConfiguredRuntimes(loadConfig({ cwd }).resolved.containment, defaultImageTag());
      return runDoctor(cwd, { benchUi: rest.includes("--bench-ui"), vt, containment });
    },
  },
  {
    name: "cost",
    help: [
      "  cost      read the ledger [--since <Nd>] [--compare <flag>] [--by task]",
    ],
    run: async (rest, { cwd }) => {
      const { runCost } = await import("./cost.js");
      const ledgerPath = await resolveLedgerPath(cwd);
      const since = flagValue(rest, "since");
      const compare = flagValue(rest, "compare");
      const by = flagValue(rest, "by");
      return runCost(ledgerPath, {
        ...(since !== undefined ? { since } : {}),
        ...(compare !== undefined ? { compare } : {}),
        ...(by !== undefined ? { by } : {}),
      });
    },
  },
  {
    name: "tools",
    help: [
      "  tools     the tool registry, what its schemas cost, and what was dispatched [--since <Nd>]",
      "            reports only: it demotes nothing, and a window with no data says \"unmeasured\"",
    ],
    run: async (rest, { cwd }) => {
      const { runTools } = await import("./tools.js");
      const ledgerPath = await resolveLedgerPath(cwd);
      const since = flagValue(rest, "since");
      return runTools(ledgerPath, { ...(since !== undefined ? { since } : {}) });
    },
  },
  {
    name: "hud",
    help: [
      "  hud       the embedded HUD (S2 stderr by default; --statusline for S1)",
      "            [--session <id>] [--json] [--color=auto|always|never|16|256|truecolor]",
    ],
    run: async (rest, { cwd }) => {
      const { readResolvedConfigCache } = await import("../config/cache.js");
      let resolved = readResolvedConfigCache(cwd);
      if (!resolved) {
        const { loadConfig } = await import("../config/load.js");
        resolved = loadConfig({ cwd }).resolved;
      }
      if (!resolved.ui.hud || !resolved.ui.statusline || !resolved.ui.watch) {
        const { loadConfig } = await import("../config/load.js");
        const { writeResolvedConfigCache } = await import("../config/cache.js");
        resolved = loadConfig({ cwd }).resolved;
        writeResolvedConfigCache(cwd, resolved);
      }
      const { readStdinSync, runHud } = await import("./hud.js");
      const statusline = rest.includes("--statusline");
      const colorFlag = parseColorFlag(flagValue(rest, "color"));
      return runHud({
        cwd,
        resolved,
        statusline,
        json: rest.includes("--json"),
        sessionId: flagValue(rest, "session") ?? null,
        env: process.env,
        isTTY: Boolean(process.stdout.isTTY),
        ...(colorFlag !== undefined ? { colorFlag } : {}),
        ...(statusline ? { stdin: readStdinSync() } : {}),
      });
    },
  },
  {
    name: "watch",
    help: [
      "  watch     S3 depth-on-demand for one session [--session <id>] [--once] [--json]",
    ],
    run: async (rest, { cwd }) => {
      const { loadConfig } = await import("../config/load.js");
      const { writeResolvedConfigCache } = await import("../config/cache.js");
      const { resolved } = loadConfig({ cwd });
      writeResolvedConfigCache(cwd, resolved);
      const { runWatch } = await import("./watch.js");
      const colorFlag = parseColorFlag(flagValue(rest, "color"));
      return runWatch({
        cwd,
        resolved,
        sessionId: flagValue(rest, "session") ?? null,
        json: rest.includes("--json"),
        once: rest.includes("--once") || !process.stdout.isTTY,
        env: process.env,
        isTTY: Boolean(process.stdout.isTTY),
        ...(colorFlag !== undefined ? { colorFlag } : {}),
      });
    },
  },
  {
    name: "theme",
    help: [
      "  theme     list | preview <name> | eject [base] [name] — shipped and user palettes",
    ],
    run: async (rest, { cwd }) => {
      const { loadConfig } = await import("../config/load.js");
      const { resolved } = loadConfig({ cwd });
      const { runThemeList, runThemePreview, runThemeEject } = await import("./theme.js");
      const colorFlag = parseColorFlag(flagValue(rest, "color"));
      const themeOpts = {
        cwd,
        resolved,
        env: process.env,
        isTTY: Boolean(process.stdout.isTTY),
        ...(colorFlag !== undefined ? { colorFlag } : {}),
      };
      const [sub, name, outName] = rest.filter((a) => !a.startsWith("--"));
      if (sub === undefined || sub === "list") return runThemeList(themeOpts);
      if (sub === "preview") {
        if (!name) {
          process.stderr.write("lykos theme preview: expected a theme name, e.g. `lykos theme preview rose-pine-moon`\n");
          return 1;
        }
        return runThemePreview(themeOpts, name);
      }
      if (sub === "eject") {
        return runThemeEject(themeOpts, name, outName);
      }
      process.stderr.write(`lykos theme: unknown subcommand "${sub}". Use "list", "preview <name>", or "eject [base] [name]".\n`);
      return 1;
    },
  },
  {
    name: "export",
    help: [
      "  export    export agents for other harnesses: `lykos export claude [--global]`",
    ],
    run: async (rest, { cwd }) => {
      const { runExportClaude } = await import("./export-claude.js");
      const [sub] = positionals(rest, []);
      if (sub === "claude") {
        return runExportClaude(cwd, { global: rest.includes("--global") });
      }
      process.stderr.write(`lykos export: unknown subcommand "${sub}". Use "claude".\n`);
      return 1;
    },
  },
  {
    name: "agents",
    help: [
      "  agents    inspect specialist roles [list|show <name>]",
    ],
    run: async (rest, { cwd }) => {
      const { runAgentsList, runAgentsShow } = await import("./agents.js");
      const { join } = await import("node:path");
      const agentsDir = join(cwd, ".lykos", "agents");
      const [sub, name] = rest;
      if (sub === undefined || sub === "list") return runAgentsList(agentsDir);
      if (sub === "show") {
        if (!name) {
          process.stderr.write("lykos agents show: expected an agent name, e.g. `lykos agents show scout`\n");
          return 1;
        }
        return runAgentsShow(agentsDir, name);
      }
      process.stderr.write(`lykos agents: unknown subcommand "${sub}". Use "list" or "show <name>".\n`);
      return 1;
    },
  },
  {
    name: "specialist",
    help: [
      "  specialist inspect or export specialists [list|show <name>|export-pi]",
      "            [--context session-start|switch|subagent]",
    ],
    run: async (rest, { cwd }) => {
      const { defaultGlobalDir, runSpecialistExportPi, runSpecialistList, runSpecialistShow } = await import("./specialist.js");
      const { SPECIALIST_VALUED_FLAGS } = await import("./args.js");
      const globalDir = defaultGlobalDir();
      const [sub, name] = positionals(rest, SPECIALIST_VALUED_FLAGS);
      const contextRaw = flagValue(rest, "context");
      if (contextRaw !== undefined) {
        if (sub !== "show") {
          process.stderr.write(`lykos specialist ${sub ?? "list"}: --context applies only to "show <name>"\n`);
          return 1;
        }
        if (contextRaw !== "session-start" && contextRaw !== "switch" && contextRaw !== "subagent") {
          process.stderr.write(`lykos specialist: --context must be "session-start", "switch", or "subagent", got "${contextRaw}"\n`);
          return 1;
        }
      }
      if (sub === undefined || sub === "list") return runSpecialistList(cwd, globalDir);
      if (sub === "export-pi") return runSpecialistExportPi(cwd, globalDir);
      if (sub === "show") {
        if (!name) {
          process.stderr.write("lykos specialist show: expected a specialist name, e.g. `lykos specialist show plan`\n");
          return 1;
        }
        return runSpecialistShow(cwd, name, {
          globalDir,
          ...(contextRaw !== undefined ? { context: contextRaw } : {}),
        });
      }
      process.stderr.write(`lykos specialist: unknown subcommand "${sub}". Use "list", "show <name>", or "export-pi".\n`);
      return 1;
    },
  },
  {
    name: "prompt",
    help: [
      "  prompt    print the head a session actually receives: `lykos prompt --show`",
      "            [--json] [--tools a,b,c] [--subagents] [--specialist name]",
      "            [--context session-start|switch|subagent]",
    ],
    run: async (rest, { cwd }) => {
      if (!rest.includes("--show")) {
        process.stderr.write("lykos prompt: expected --show (the only mode today), e.g. `lykos prompt --show`\n");
        return 1;
      }
      const { runPrompt } = await import("./prompt.js");
      const toolsRaw = flagValue(rest, "tools");
      const specialist = flagValue(rest, "specialist");
      const outputStyle = flagValue(rest, "output-style");
      if (rest.some((a) => a === "--target" || a.startsWith("--target="))) {
        process.stderr.write("lykos prompt: --target was removed: a delegated run boots the same head as a standalone one (ADR-0036)\n");
        return 1;
      }
      const contextRaw = flagValue(rest, "context");
      if (contextRaw !== undefined && contextRaw !== "session-start" && contextRaw !== "switch" && contextRaw !== "subagent") {
        process.stderr.write(`lykos prompt: --context must be "session-start", "switch", or "subagent", got "${contextRaw}"\n`);
        return 1;
      }
      return runPrompt(cwd, {
        json: rest.includes("--json"),
        subagents: rest.includes("--subagents"),
        ledgerPath: await resolveLedgerPath(cwd),
        ...(toolsRaw !== undefined ? { tools: toolsRaw.split(",").map((t) => t.trim()) } : {}),
        ...(specialist !== undefined ? { specialist } : {}),
        ...(outputStyle !== undefined ? { outputStyle } : {}),
        ...(contextRaw !== undefined ? { context: contextRaw } : {}),
      });
    },
  },
  {
    name: "show",
    help: [
      "  show      replay a captured transcript: `lykos show <session>` [--json]",
    ],
    run: async (rest, { cwd }) => {
      const sessionId = rest.find((a) => !a.startsWith("--"));
      if (!sessionId) {
        process.stderr.write("lykos show: expected a session id, e.g. `lykos show 1a2b3c4d`\n");
        return 1;
      }
      const { runShow } = await import("./show.js");
      return runShow(await resolveLedgerPath(cwd), sessionId, { json: rest.includes("--json") });
    },
  },
  {
    name: "resume",
    help: [
      "  resume    continue an earlier conversation: `lykos resume <session>`",
      "            [--yes] [--force] [--dry-run] [--model m] [--(no-)prompt-diet] [--(no-)output-diet]",
      "            shows what the replay costs before spending it; the original is never rewritten",
      "            with no id it opens the session picker (`--all` for every project)",
    ],
    run: async (rest, { cwd }) => {
      const { runResume } = await import("./resume.js");
      const { createReadlineLineSource } = await import("../session/interactive.js");
      const model = flagValue(rest, "model");
      const lineSource = createReadlineLineSource();
      const ledgerPath = await resolveLedgerPath(cwd);
      let sessionId = rest.find((a) => !a.startsWith("--"));
      if (!sessionId) {
        const { allProjectSources, pickSession } = await import("./sessions.js");
        const sources = rest.includes("--all")
          ? allProjectSources()
          : [{ ledgerPath, workspace: cwd, projectName: null }];
        const picked = await pickSession({
          sources,
          read: () => lineSource.next(),
          ...(rest.includes("--no-fullscreen") ? { noFullscreen: true } : {}),
        });
        if (!picked) {
          lineSource.close();
          return 1;
        }
        sessionId = picked;
      }
      try {
        return await runResume(cwd, ledgerPath, sessionId, {
          lineSource,
          ...(rest.includes("--yes") ? { yes: true } : {}),
          ...(rest.includes("--force") ? { force: true } : {}),
          ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(rest.includes("--no-prompt-diet")
            ? { promptDiet: false }
            : rest.includes("--prompt-diet")
              ? { promptDiet: true }
              : {}),
          ...(rest.includes("--no-output-diet")
            ? { outputDiet: false }
            : rest.includes("--output-diet")
              ? { outputDiet: true }
              : {}),
        });
      } finally {
        lineSource.close();
      }
    },
  },
  {
    name: "session",
    help: [
      "  session   list what has been run [--all] [--json] [--filter <text>]",
    ],
    run: async (rest, { cwd }) => {
      const { allProjectSources, runSessions } = await import("./sessions.js");
      const ledgerPath = await resolveLedgerPath(cwd);
      const filter = flagValue(rest, "filter");
      return runSessions({
        sources: rest.includes("--all") ? allProjectSources() : [{ ledgerPath, workspace: cwd, projectName: null }],
        json: rest.includes("--json"),
        ...(filter !== undefined ? { filter } : {}),
      });
    },
  },
  {
    name: "task",
    help: [
      '  task      the thing cost-per-success is divided by [list|name <id> "<name>"|abandon <id>]',
      "            join an existing one from a new run with `lykos run --task <id>`",
    ],
    run: async (rest, { cwd }) => {
      const { runTaskAbandon, runTaskList, runTaskName } = await import("./task.js");
      const ledgerPath = await resolveLedgerPath(cwd);
      const [sub, id, ...nameParts] = rest.filter((a) => !a.startsWith("--"));
      if (sub === undefined || sub === "list") {
        return runTaskList(ledgerPath, { json: rest.includes("--json") });
      }
      if (sub === "name") {
        if (!id) {
          process.stderr.write('lykos task name: expected a task id, e.g. `lykos task name 1a2b3c4d "the parser rename"`\n');
          return 1;
        }
        return runTaskName(ledgerPath, id, nameParts.join(" "));
      }
      if (sub === "abandon") {
        if (!id) {
          process.stderr.write("lykos task abandon: expected a task id, e.g. `lykos task abandon 1a2b3c4d`\n");
          return 1;
        }
        return runTaskAbandon(ledgerPath, id);
      }
      process.stderr.write(
        `lykos task: unknown subcommand "${sub}". Use "list", "name <id> <name>", or "abandon <id>".\n`,
      );
      return 1;
    },
  },
  {
    name: "search",
    help: [
      '  search    plain substring across briefs and transcripts: `lykos search "parser"`',
      "            [--all] [--json] [--limit N] [--task id] [--outcome o] [--outcome-source s]",
      "            [--model m] [--shape s] [--capture stream|snapshot] [--since Nd] [--until Nd] [--min-cost N]",
    ],
    run: async (rest, { cwd }) => {
      const { runSearch } = await import("./search.js");
      const { allProjectSources } = await import("./sessions.js");
      const ledgerPath = await resolveLedgerPath(cwd);
      const query = positionals(rest, VALUE_FLAGS_SEARCH)[0] ?? "";
      const minCost = flagValue(rest, "min-cost");
      const limit = flagValue(rest, "limit");
      const filters = {
        ...(flagValue(rest, "task") !== undefined ? { task: flagValue(rest, "task")! } : {}),
        ...(flagValue(rest, "outcome") !== undefined ? { outcome: flagValue(rest, "outcome")! } : {}),
        ...(flagValue(rest, "outcome-source") !== undefined
          ? { outcomeSource: flagValue(rest, "outcome-source")! }
          : {}),
        ...(flagValue(rest, "model") !== undefined ? { model: flagValue(rest, "model")! } : {}),
        ...(flagValue(rest, "shape") !== undefined ? { shape: flagValue(rest, "shape")! } : {}),
        ...(flagValue(rest, "capture") !== undefined ? { captureMode: flagValue(rest, "capture")! } : {}),
        ...(flagValue(rest, "since") !== undefined ? { since: flagValue(rest, "since")! } : {}),
        ...(flagValue(rest, "until") !== undefined ? { until: flagValue(rest, "until")! } : {}),
        ...(minCost !== undefined && Number.isFinite(Number(minCost)) ? { minCostUsd: Number(minCost) } : {}),
      };
      return runSearch(query, {
        sources: rest.includes("--all") ? allProjectSources() : [{ ledgerPath, workspace: cwd, projectName: null }],
        filters,
        json: rest.includes("--json"),
        ...(limit !== undefined && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
      });
    },
  },
  {
    name: "archive",
    help: [
      "  archive   gzip finished transcripts past the retention hint [--days N] [--dry-run] [--json]",
      "            compression only — nothing is ever summarised, pruned or deleted",
    ],
    run: async (rest, { cwd }) => {
      const { runArchive } = await import("./archive.js");
      const days = flagValue(rest, "days");
      const parsed = days !== undefined ? Number(days) : undefined;
      if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) {
        process.stderr.write(`lykos archive: --days expects a non-negative number, got "${days}"\n`);
        return 1;
      }
      return runArchive(await resolveLedgerPath(cwd), {
        ...(parsed !== undefined ? { days: parsed } : {}),
        ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
        ...(rest.includes("--json") ? { json: true } : {}),
      });
    },
  },
  {
    name: "verify",
    help: [
      '  verify    record whether a task worked: `lykos verify <session> --cmd "npm test"` [--yes|--no]',
      "            an exit code or a person decides; an agent's own claim never does",
    ],
    run: async (rest, { cwd }) => {
      const sessionId = rest.find((a) => !a.startsWith("--"));
      if (!sessionId) {
        process.stderr.write(
          'lykos verify: expected a session id, e.g. `lykos verify 1a2b3c4d --cmd "npm test"`\n',
        );
        return 1;
      }
      const { runVerifyCli } = await import("./verify.js");
      const cmd = flagValue(rest, "cmd");
      return runVerifyCli(cwd, sessionId, {
        ...(cmd !== undefined ? { cmd } : {}),
        ...(rest.includes("--yes") ? { yes: true } : {}),
        ...(rest.includes("--no") ? { no: true } : {}),
      });
    },
  },
  {
    name: "extensions",
    help: [
      "  extensions declared extensions [list|install]: list shows each and whether it is installed;",
      "            install fetches every declared-but-missing one (defaults ship with Lykos, never installed)",
    ],
    run: async (rest, { cwd }) => {
      const { runExtensionsCli } = await import("./extensions.js");
      return runExtensionsCli(cwd, rest.find((a) => !a.startsWith("--")));
    },
  },
  {
    name: "rewind",
    help: [
      "  rewind    undo the working tree to a turn checkpoint [<hash>|<n>] [--now]",
      "            git commits on a scratch ref -- never your branch, never your index, never deletes",
    ],
    run: async (rest, { cwd }) => {
      const { runRewindCli } = await import("./rewind.js");
      const index = rest.find((a) => !a.startsWith("--"));
      return runRewindCli(cwd, {
        ...(index !== undefined ? { index } : {}),
        ...(rest.includes("--now") ? { now: true } : {}),
      });
    },
  },
  {
    name: "budget",
    help: [
      "  budget    caps [show|set <key> <value>]",
    ],
    run: async (rest, { cwd }) => {
      const { runBudgetShow, runBudgetSet } = await import("./budget.js");
      const [sub, key, value] = rest;
      if (sub === undefined || sub === "show") return runBudgetShow(cwd);
      if (sub === "set") return runBudgetSet(cwd, key ?? "", value);
      process.stderr.write(`lykos budget: unknown subcommand "${sub}". Use "show" or "set <key> <value>".\n`);
      return 1;
    },
  },
  {
    name: "memory",
    help: [
      "  memory    project/global memory [list [--all]|add <text>|forget <id> [--purge]|stale|status]",
      "            [--scope project|global] [--file gotchas|failed-approaches] [--src <session>] [--paths a.ts,b.ts]",
      '            forget supersedes the entry and keeps the line (--reason "..."); --purge deletes it',
      '  memory propose "<lesson>" | proposals | accept <id>   a model may propose; only a human accepts',
      '  memory rediscovered "<lesson>" [--source <session>] [--helped|--no-help] [--calls N] [--list]',
      "            you re-derived something a memory could have held — human-authored, a lower bound",
    ],
    run: async (rest, { cwd }) => {
      const { isMemoryFile, isMemoryScope, runMemoryAdd, runMemoryForget, runMemoryList, runMemoryRediscovered, runMemoryStale, runMemoryStatus } =
        await import("./memory.js");
      const [sub, ...args] = rest;
      const scopeRaw = flagValue(args, "scope");
      const fileRaw = flagValue(args, "file");
      if (scopeRaw !== undefined && !isMemoryScope(scopeRaw)) {
        process.stderr.write(`lykos memory: --scope must be "project" or "global", got "${scopeRaw}"\n`);
        return 1;
      }
      if (fileRaw !== undefined && !isMemoryFile(fileRaw)) {
        process.stderr.write(`lykos memory: --file must be "gotchas" or "failed-approaches", got "${fileRaw}"\n`);
        return 1;
      }
      const srcRaw = flagValue(args, "src");
      const pathsRaw = flagValue(args, "paths");
      const opts = {
        ...(scopeRaw !== undefined ? { scope: scopeRaw } : {}),
        ...(fileRaw !== undefined ? { file: fileRaw } : {}),
        ...(srcRaw !== undefined ? { src: srcRaw } : {}),
        ...(pathsRaw !== undefined
          ? { paths: pathsRaw.split(",").map((x) => x.trim()).filter((x) => x.length > 0) }
          : {}),
      };
      if (sub === undefined || sub === "list") {
        return runMemoryList(cwd, { ...opts, ...(args.includes("--all") ? { all: true } : {}) });
      }
      if (sub === "add") return runMemoryAdd(cwd, args[0] ?? "", opts);
      if (sub === "forget" || sub === "invalidate") {
        return runMemoryForget(cwd, args[0] ?? "", {
          ...opts,
          ...(args.includes("--purge") ? { purge: true } : {}),
          ...(flagValue(args, "reason") !== undefined ? { reason: flagValue(args, "reason")! } : {}),
          ...(flagValue(args, "by") !== undefined ? { by: flagValue(args, "by")! } : {}),
        });
      }
      if (sub === "status") return await runMemoryStatus(await resolveLedgerPath(cwd));
      if (sub === "stale") return await runMemoryStale(cwd, opts);
      if (sub === "propose" || sub === "proposals" || sub === "accept") {
        const { runMemoryAccept, runMemoryProposals, runMemoryPropose } = await import("./memory-propose.js");
        if (sub === "proposals") return runMemoryProposals(cwd);
        if (sub === "accept") return runMemoryAccept(cwd, args[0] ?? "");
        return runMemoryPropose(cwd, args[0] ?? "", {
          ...(fileRaw !== undefined ? { file: fileRaw } : {}),
          ...(srcRaw !== undefined ? { src: srcRaw } : {}),
          ...(pathsRaw !== undefined
            ? { paths: pathsRaw.split(",").map((x) => x.trim()).filter((x) => x.length > 0) }
            : {}),
        });
      }
      if (sub === "rediscovered") {
        const callsRaw = flagValue(args, "calls");
        return await runMemoryRediscovered(await resolveLedgerPath(cwd), args[0] ?? "", {
          ...(args.includes("--list") ? { list: true } : {}),
          ...(flagValue(args, "session") !== undefined ? { session: flagValue(args, "session")! } : {}),
          ...(flagValue(args, "source") !== undefined ? { source: flagValue(args, "source")! } : {}),
          ...(args.includes("--helped") ? { helped: true } : args.includes("--no-help") ? { helped: false } : {}),
          ...(callsRaw !== undefined && Number.isFinite(Number(callsRaw)) ? { calls: Number(callsRaw) } : {}),
        });
      }
      process.stderr.write(
        `lykos memory: unknown subcommand "${sub}". Use "list", "add <text>", "forget <id-or-match>", or "status".\n`,
      );
      return 1;
    },
  },
  {
    name: "run",
    help: [
      '  run       run one task through the delegate: `lykos run "<brief>"` [--model] [--tools a,b,c] [--budget <usd>]',
      "            [--yes] [--trust-workspace] [--subagents] [--interactive] [--task <id>]",
      "            [--containment off|auto|required] [--network open|none] where commands run (off unless asked)",
      "            [--mode manual|accept-edits|auto] [--in-place] a delegated session writes on a worktree and branch of its own (mode auto, the default);",
      "            --in-place writes in this tree instead, and is needed outside a git repository",
      "            [--specialist name] selects a specialist; switch mid-session with /specialist",
      "            [--ask-outcome] re-arms the end-of-session \"did that work?\" question (off by default)",
      "            the task can also come from files and stdin: `lykos run @task.md`, `... | lykos run -`",
      "            (stdin, then each @file, then the argument; `--` makes the next argument the task verbatim).",
      "            On Windows give a multi-line task as @task.md: a .cmd launcher (npm run, npx, lykos.cmd)",
      "            cuts an argument at its first newline, and PowerShell 5.1 reads a file without a BOM as ANSI",
      "            `lykos run --interactive` (or `lykos` with no args) starts the standalone terminal UI",
    ],
    run: async (rest, { cwd }) => {
      const { runRun } = await import("./run.js");
      let prompt: string | undefined;
      if (rest.includes("--interactive")) {
        prompt = firstPositional(rest, RUN_VALUED_FLAGS);
      } else {
        const { parseRunBriefArgs, readProcessStdin, resolveRunBrief } = await import("./brief.js");
        const resolved = await resolveRunBrief(parseRunBriefArgs(rest), {
          cwd,
          stdinIsTTY: process.stdin.isTTY === true,
          readStdin: readProcessStdin,
        });
        if ("error" in resolved) {
          process.stderr.write(`lykos run: ${resolved.error}\n`);
          return 1;
        }
        prompt = resolved.brief;
      }
      const model = flagValue(rest, "model");
      const toolsRaw = flagValue(rest, "tools");
      const budget = flagValue(rest, "budget");
      if (rest.some((a) => a === "--shape" || a.startsWith("--shape="))) {
        process.stderr.write(
          "lykos run: --shape is retired; there is one engine now. Use --containment off|auto|required to choose where commands run (--containment off is what --shape standalone did).\n",
        );
        return 1;
      }
      const specialist = flagValue(rest, "specialist");
      const outputStyle = flagValue(rest, "output-style");
      const taskRaw = flagValue(rest, "task");
      let joined: { taskId: string; projectId: string | null } | undefined;
      if (taskRaw !== undefined) {
        const { resolveTaskForRun } = await import("./task.js");
        const resolved = resolveTaskForRun(await resolveLedgerPath(cwd), taskRaw);
        if ("error" in resolved) {
          process.stderr.write(`lykos run --task: ${resolved.error}\n`);
          return 1;
        }
        joined = resolved;
      }
      const containmentRaw = flagValue(rest, "containment");
      if (containmentRaw !== undefined && containmentRaw !== "off" && containmentRaw !== "auto" && containmentRaw !== "required") {
        process.stderr.write(`lykos run: --containment must be "off", "auto" or "required", got "${containmentRaw}"\n`);
        return 1;
      }
      const networkRaw = flagValue(rest, "network");
      if (networkRaw !== undefined && networkRaw !== "open" && networkRaw !== "none") {
        process.stderr.write(`lykos run: --network must be "open" or "none", got "${networkRaw}"\n`);
        return 1;
      }
      const modeRaw = flagValue(rest, "mode");
      let mode: InteractionMode | undefined;
      if (modeRaw !== undefined) {
        const parsed = parseInteractionMode(modeRaw);
        if (!parsed.ok) {
          process.stderr.write(`lykos run: ${parsed.error}\n`);
          return 1;
        }
        mode = parsed.mode;
      }
      return runRun(cwd, prompt, {
        ...(mode !== undefined ? { mode } : {}),
        ...(rest.includes("--in-place") ? { inPlace: true } : {}),
        ...(containmentRaw !== undefined ? { containment: containmentRaw } : {}),
        ...(networkRaw !== undefined ? { network: networkRaw } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(toolsRaw !== undefined ? { tools: toolsRaw.split(",").map((t) => t.trim()) } : {}),
        ...(budget !== undefined ? { budgetPerRunUsd: budget } : {}),
        ...(rest.includes("--yes") ? { autoApprove: true } : {}),
        ...(rest.includes("--trust-workspace") ? { trustWorkspace: true } : {}),
        ...(rest.includes("--interactive") ? { interactive: true } : {}),
        ...(rest.includes("--subagents") ? { subagents: true } : {}),
        ...(rest.includes("--ask-outcome") ? { askOutcome: true } : {}),
        ...(joined !== undefined ? { taskId: joined.taskId } : {}),
        ...(joined?.projectId ? { projectId: joined.projectId } : {}),
        ...(specialist !== undefined ? { specialist } : {}),
        ...(outputStyle !== undefined ? { outputStyle } : {}),
      });
    },
  },
  {
    name: "login",
    help: [
      "  login     store a credential: `lykos login <provider>` (OAuth) or `lykos login <provider> --api-key` (stdin)",
    ],
    run: async (rest) => {
      const { runLogin } = await import("./login.js");
      return runLogin(rest);
    },
  },
  {
    name: "logout",
    help: [
      "  logout    disable credentials: `lykos logout <provider> [label]`",
    ],
    run: async (rest) => {
      const { runLogout } = await import("./login.js");
      return runLogout(rest);
    },
  },
  {
    name: "usage",
    help: [
      "  usage     show credential pools, cooldowns and usage windows; `--refresh` fetches Claude/Codex usage first",
    ],
    run: async (rest, { setExitByDraining }) => {
      const { runUsage } = await import("./usage.js");
      if (rest.includes("--refresh")) setExitByDraining?.();
      return runUsage({ env: process.env, args: rest });
    },
  },
  {
    name: "mcp",
    help: [
      "  mcp       serve the delegate surface over MCP (lykos_implement/refactor/debug/review);",
      "            each call runs a delegated session in a `lykos session-child` process of its own",
    ],
    run: async (_rest, { cwd }) => {
      const version = await readPackageVersion();
      const { runMcp } = await import("./mcp.js");
      return runMcp(cwd, version);
    },
  },
  {
    name: "--version",
    aliases: ["version"],
    help: [
      "  --version print the lykos and pinned pi version",
    ],
    run: async () => {
      try {
        const pkg = await readPackageJson();
        const pi = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
        stdoutWrite(`lykos ${pkg.version} (pi ${pi ?? "unknown"} pinned)\n`);
      } catch {
        stdoutWrite("lykos (version unreadable)\n");
      }
      return 0;
    },
  },
  {
    name: "help",
    aliases: ["-h", "--help"],
    help: [],
    run: async () => {
      stdoutWrite(usageText());
      return 0;
    },
  },
  {
    name: "session-child",
    aliases: [],
    help: [],
    run: async () => {
      const { runSessionChild } = await import("./session-child.js");
      const stdout = claimProtocolStream();
      const code = await runSessionChild({ write: stdout.write, onParentGone: () => process.exit(1) });
      await stdout.flush();
      return code;
    },
  },
];

export function usageText(): string {
  return [
    "lykos <command>",
    "",
    ...COMMANDS.flatMap((c) => c.help),
    "",
  ].join("\n");
}

export function findCommand(nameOrAlias: string): Command | undefined {
  return COMMANDS.find((c) => c.name === nameOrAlias || c.aliases?.includes(nameOrAlias));
}
