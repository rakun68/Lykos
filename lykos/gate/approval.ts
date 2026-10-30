// The approval gate, per T30.2's answer: "the gate, and the project root."
// Before a write, an edit, or a bash command runs on the host filesystem, the
// user sees what is about to happen and approves it — T30's finding names the
// mechanism. `createWriteTool`/`createEditTool`/`createBashTool` each accept a
// pluggable `Operations` object, documented purely as a remoting seam
// ("delegate ... to remote systems, for example SSH"); using it as a safety
// boundary is Lykos's own design decision, not a documented SDK feature.
// Verified live against the real SDK (not assumed from the .d.ts alone, per
// CLAUDE.md's primary-source rule): a `customTools` entry sharing a built-in
// tool's name shadows the built-in cleanly — no `noTools`, no
// duplicate-registration error, no `tools` allowlist collision.
//
// Two gates, matching T30.2's "the gate, AND the project root":
//   1. Scope clamp — a hard boundary, never asked about. A target path
//      outside the project root is refused outright, before the approval
//      gate is even consulted.
//   2. Approval — everything inside the root still needs a yes, unless the
//      caller already said "always allow this tool" for the session.
// "Always allow everything" is a flag the caller sets explicitly at boot
// (T34.2: "a flag, not a keystroke"), never a decision reachable from
// inside a single prompt or a single "yes to all" answer.
//
// `mkdir` (WriteOperations) does not prompt on its own: it is a
// precondition `write`/`edit` need satisfied before the meaningful action
// (real file content landing on disk) can run, and gating it separately
// would double-prompt for one logical write. It still passes the scope
// clamp. `read`/`access` inside `EditOperations` are likewise ungated —
// T30.2's answer is framed around mutation and command execution, and T33
// already left the `read` tool itself untouched (Pi's own default,
// ungated, same as the container path's hop-0 surface).

import { existsSync, statSync, constants as fsConstants } from "node:fs";
import { access as accessFs, mkdir as mkdirFs, readFile as readFileFs, writeFile as writeFileFs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import {
  type BashOperations,
  type EditOperations,
  type PowerShellOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { detectFirstCommit, detectGitRemote, resolveProject } from "../session/identity.js";
import { classifyCommandRisk } from "./command-safety.js";
import { decideForMode, type GatedAction } from "./modes.js";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { decideCommandPaths } from "./bash-paths.js";
import { collectPathRules, decidePath, type PathAccess, type PathContext, type PathRule } from "./path-rules.js";
import { loadPermissions, rememberExtraDir } from "./permissions.js";
import { isWorkspaceTrusted } from "./trust.js";

/**
 * What class of thing is being approved.
 *
 * P10.6 (ticket 19, D3/D5) added the last three. They are not new approval
 * SURFACES — every one of them goes through the same `authorize()` below, the
 * same interaction-mode policy behind the gate, and the same denial record.
 * They exist because `gate/modes.ts` derives a tier from this field, and the
 * three tiers involved are genuinely different:
 *
 *   - `read` is a NETWORK read — `github`'s six read operations. `read` is the
 *     tier `web_search` and `web_fetch` are declared at, so that is the tier
 *     it takes. Calling it `bash` would run a POSIX command classifier over a
 *     `gh` argument array; calling it `write` would make Auto stop and ask
 *     before every `issue_list`. The `read` TOOL, a local file read, stays
 *     ungated: this kind shares its name and not its policy (D24). A local
 *     read and a fetch from a forge are different acts, and only the second
 *     earns a tiered request. `grep`'s missing scope clamp is the same local
 *     read question (`tools/search.ts`), and it is answered the same way.
 *   - `github` is an OUTWARD-FACING write — the three `pr_*` operations. It
 *     takes the registry's declared `hard-write`, which is what makes Auto ask
 *     before a branch becomes visible to other people.
 *   - `eval` runs arbitrary code, which is `bash`'s ceiling, and likewise
 *     takes its declared `hard-write` rather than a tier derived from reading
 *     the cell. A JavaScript cell is not a shell line and a shell parser has
 *     nothing true to say about one.
 *
 * Each of the three names a row in `tools/tool-surface.ts`'s registry, which
 * is exactly how `write`, `edit` and `powershell` already get their tiers —
 * `tierForAction` looks the name up. Adding a tool therefore means declaring
 * what it does, not editing the policy.
 *
 * P10.9 (ticket 21, D4) added `extension`, and it is the only arm here that
 * exists because a tool's declared tier is NOT believed. Every other kind
 * names a row in `tools/tool-surface.ts` that Lykos wrote and reviewed; an
 * extension-registered tool's row was written by whoever wrote the extension.
 * `tierForTool("extension")` finds no declaration and returns T107.3's
 * fail-closed `hard-write`, which is the whole point: the tier an extension
 * declares is shown to the human as a declaration and never lowers what the
 * gate asks. There is deliberately no per-extension arm — one arm for every
 * extension tool is what makes "all of them are hard-write" a property of the
 * type rather than a rule somebody has to remember.
 */
export type GatedToolKind = "write" | "edit" | "bash" | "read" | "github" | "eval" | "extension";

export interface ApprovalRequest {
  kind: GatedToolKind;
  /** One-line human-readable summary of what's about to happen. */
  summary: string;
  /** The absolute path (write/edit) or the command text (bash). */
  detail: string;
  /**
   * P10.4 (ticket 13, D3): which shell a `bash`-kind request is actually for.
   *
   * `powershell` reaches this gate as `kind: "bash"` — it is a shell, and it
   * wants the same summary, the same detail, the same session scope and the
   * same modal as `bash`. But the tier is NOT the same question. The one
   * command classifier in this codebase (`command-safety.ts`, via
   * `loop/exploration.ts`) parses POSIX shell, and `gate/modes.ts` runs it on
   * every `bash`-kind action to decide the tier. Run it on
   * `Remove-Item -Recurse -Force build` and it finds no head it recognises,
   * answers "ordinary", and Auto then offers to REMEMBER that as a pattern —
   * a recursive delete silently promoted to always-allow because a POSIX
   * parser was asked about a PowerShell line. Teaching that parser PowerShell
   * would be the second opinion `tool-risk.ts` forbids.
   *
   * So the shell is named here and `tierForAction` branches on it, taking
   * `powershell`'s declared, fail-closed `hard-write` tier from the registry
   * instead of deriving one. Absent means `bash`, which is every request
   * written before this field existed.
   */
  shell?: "bash" | "powershell";
  /** T49.1: the full body to show in the approval modal — the new file's full content for write/edit (there is no old-file diff available at this layer; see approval-modal.ts's module doc), or unset for bash, where `detail` already is the full command. Never truncated by the caller — the modal itself scrolls. */
  body?: string;
  /**
   * T210/T211: this request is a path-rule ASK (outside the directory, or an `ask` rule), not a
   * mode question. A mode never answers it: Auto and a remembered command approval do not
   * count, only a person at the prompt does. A gate with no person to ask denies it.
   * `rule` names what asked, for the denial message. `protected` marks protected writes.
   */
  pathAsk?: { rule: string; protected?: boolean };
}

/** Protected paths a person allowed for this session, per gate: one gate is one session, so another session never inherits it. Never persisted. */
const sessionAllowedProtectedPaths = new WeakMap<ApprovalGate, Set<string>>();

/** What a gate with no human tells the model when a path rule asked. */
export function pathAskDenialMessage(req: ApprovalRequest): string {
  if (req.pathAsk?.protected) {
    return (
      `lykos: ${req.kind} of ${req.detail} is a protected path (path rule: ${req.pathAsk.rule}), and nothing here can ask a human to approve it. ` +
      `Protected writes need a human's answer. Do not retry this path.`
    );
  }
  return (
    `lykos: ${req.kind} of ${req.detail} needs a human's answer (path rule: ${req.pathAsk?.rule ?? "ask"}), and nothing here can ask one. ` +
    `To allow it, allow the folder in an interactive session, or add a path_rules allow rule for it in config.yaml. Do not retry this path.`
  );
}

export type ApprovalDecision = "allow" | "deny" | "allow-always" | "allow-folder";

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
  /**
   * T161: the reason a refusal carries to the model, when it is not a human's
   * choice. Absent, a refusal reads as "the human declined". A gate that
   * refuses by rule (`ReadOnlyGate`) says which rule, because telling a model
   * a person declined when nobody was asked is a false statement it will act on.
   */
  denialReason?(req: ApprovalRequest): string | undefined;
  /**
   * T213: would this gate refuse the request by rule, whoever asks? A subagent gate checks its
   * parent before allowing anything, so a read-only parent (a Plan session) stays read-only for
   * the subagents it spawns.
   */
  refuses?(req: ApprovalRequest): boolean;
  pathRules?: PathRule[] | undefined;
  pathContext?: PathContext | undefined;
  readonly inner?: ApprovalGate | undefined;
  verifyCommand?: string | undefined;
}

export function unwrapGate(gate: ApprovalGate): ApprovalGate {
  let cur: ApprovalGate = gate;
  const seen = new Set<ApprovalGate>();
  while (cur.inner !== undefined && !seen.has(cur)) {
    seen.add(cur);
    cur = cur.inner;
  }
  return cur;
}

/** Refused before it ever reaches the real filesystem — T34's "a rejected write does not appear in the working tree." */
export class ApprovalDeniedError extends Error {}

import {
  bashTimeoutFromEnv,
  isTimeoutError,
  resolveBashTimeout,
  TIMEOUT_EXIT_CODE,
  timeoutNotice,
} from "../loop/bash-timeout.js";

/** The id the per-project permission store is keyed by; the directory itself when it has no project identity. */
export function projectIdForCwd(cwd: string): string {
  const cached = projectIds.get(cwd);
  if (cached !== undefined) return cached;
  let id = resolve(cwd);
  try {
    // A directory with no git identity has no stable project: `resolveProject` would mint a new
    // registry row on every call, so its path is its key.
    if (detectGitRemote(cwd) !== undefined || detectFirstCommit(cwd) !== undefined) id = resolveProject(cwd).id;
  } catch {
    // keep the path
  }
  projectIds.set(cwd, id);
  return id;
}
const projectIds = new Map<string, string>();

export function folderOfPath(filePath: string): string {
  try {
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      return resolve(filePath);
    }
  } catch {
    // ignore
  }
  return dirname(resolve(filePath));
}

/**
 * What the model is told when a rule denies a path. Names the rule, and that
 * retrying is pointless: a refusal the model cannot learn from becomes a stall.
 */
export function pathDenialMessage(path: string, reason: string | undefined): string {
  return (
    `lykos: refused — ${path}: ${reason ?? "denied by a path rule"}. ` +
    `A deny rule is not a question, so do not retry this path. Work elsewhere, or explain what you need and stop.`
  );
}

// `config/load` is imported on demand: it reaches `tools.ts` through the specialists, and
// `tools.ts` reaches this module, so a static import here is a load-order cycle.
export async function resolvePathRulesAndContext(cwd: string): Promise<{ rules: PathRule[]; ctx: PathContext }> {
  const projectId = projectIdForCwd(cwd);
  const perms = loadPermissions(projectId);
  const ctx: PathContext = {
    cwd,
    home: homedir(),
    extraDirs: perms.extraDirs,
    outside: perms.outside,
  };
  let rules: PathRule[] = [];
  try {
    const { loadConfig } = await import("../config/load.js");
    const { resolved } = loadConfig({ cwd });
    const trusted = isWorkspaceTrusted(cwd);
    rules = collectPathRules(resolved.path_rules, trusted);
  } catch {
    rules = [];
  }
  return { rules, ctx };
}

/** T30.2's hard boundary: never asked about, always enforced. */
export function isWithinRoot(root: string, target: string): boolean {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (targetResolved === rootResolved) return true;
  const rel = relative(rootResolved, targetResolved);
  // D17: a parent step is a whole `..` SEGMENT. A string-prefix test refused
  // `<root>/..cache/x`, which is inside the root, with a reason that is false.
  return rel !== "" && rel !== ".." && !/^\.\.[\\/]/.test(rel) && !isAbsolute(rel);
}

/** `--yes` (T34.2: "a flag, not a keystroke") — every gated action allowed with no prompt. */
export class AutoApproveGate implements ApprovalGate {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    // T210: `--yes` answers mode questions, not a path rule's ask: there is no human to answer it.
    return req.pathAsk !== undefined ? "deny" : "allow";
  }

  denialReason(req: ApprovalRequest): string | undefined {
    return req.pathAsk !== undefined ? pathAskDenialMessage(req) : undefined;
  }
}

/**
 * The safe default for a one-shot standalone run with no TTY to prompt on
 * (CLAUDE.md: never invent a permissive default). Every gated action is
 * refused with a message naming the way out — `--yes` or an interactive
 * terminal — rather than hanging forever waiting for input that cannot
 * arrive.
 */
export class DenyAllGate implements ApprovalGate {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    void req;
    return "deny";
  }
}

/**
 * P4 T149: the gate of a READ-ONLY child session (`BootConfig.readOnly`) —
 * a read is allowed, and every other kind (write, edit, bash, eval, an
 * extension's tool, a GitHub write) is refused, whatever `--yes` said. It is
 * one of the layers that make "a review can never change the code it is
 * reviewing" (spec story 32) mechanical rather than requested.
 */
export class ReadOnlyGate implements ApprovalGate {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.refuses(req) ? "deny" : "allow";
  }

  refuses(req: ApprovalRequest): boolean {
    return !(req.kind === "read" && req.pathAsk === undefined);
  }

  denialReason(req: ApprovalRequest): string {
    if (req.pathAsk !== undefined) return pathAskDenialMessage(req);
    return (
      `lykos: this ${req.kind} (${req.summary}) on ${req.detail} is refused by the read-only gate — this is a ` +
      `read-only child session, and nothing but a read is ever allowed here. Read what you need and answer in text.`
    );
  }
}

/**
 * The read-only posture of a session started under a read-only specialist (T214, ADR-0043).
 * Unlike `ReadOnlyGate`'s child, such a session keeps `bash` and `exit_plan`;
 * the posture is enforced here on the gate via `decideForMode` with `readOnly: true`,
 * and `exit_plan` lifts it for the rest of the session.
 */
export interface ReadOnlyPosture {
  readOnly: boolean;
}

const NO_ALLOWLIST = new Set<string>();

export class PostureGate implements ApprovalGate {
  constructor(
    readonly inner: ApprovalGate,
    private readonly posture: ReadOnlyPosture,
  ) {}

  private decision(req: ApprovalRequest): ReturnType<typeof decideForMode> | undefined {
    if (!this.posture.readOnly) return undefined;
    const action: GatedAction =
      req.kind === "bash"
        ? req.shell === "powershell"
          ? { kind: "powershell" }
          : { kind: "bash", command: req.detail }
        : { kind: req.kind };
    return decideForMode("manual", action, NO_ALLOWLIST, { readOnly: true });
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const d = this.decision(req);
    if (d?.verdict === "deny") return "deny";
    return this.inner.request(req);
  }

  refuses(req: ApprovalRequest): boolean {
    return this.decision(req)?.verdict === "deny" || this.inner.refuses?.(req) === true;
  }

  denialReason(req: ApprovalRequest): string | undefined {
    const d = this.decision(req);
    if (d?.verdict === "deny") {
      return (
        d.reason ??
        `lykos: this ${req.kind} (${req.summary}) on ${req.detail} is refused because the session is read-only. ` +
        `Reads and read-only commands run; present your plan with exit_plan to start making changes.`
      );
    }
    return this.inner.denialReason?.(req);
  }

  get pathRules(): PathRule[] | undefined {
    return this.inner.pathRules;
  }

  get pathContext(): PathContext | undefined {
    return this.inner.pathContext;
  }

  get mode(): string | undefined {
    return (this.inner as any).mode;
  }

  get denied(): unknown[] | undefined {
    return (this.inner as any).denied;
  }
}

/**
 * Real terminal approval. Takes an injectable `nextLine()` rather than
 * owning a `readline.Interface` itself, so a caller running a multi-turn
 * interactive loop (T34.1) can share ONE interface between the main prompt
 * and approval prompts — two independent `readline` interfaces on the same
 * stdin fight each other for lines.
 */
export class TerminalApprovalGate implements ApprovalGate {
  /**
   * Serializes concurrent `request()` calls onto one shared `nextLine()`
   * read at a time — found alongside the full-screen surface's own version
   * of this bug (2026-09-02 round five, `RawApprovalGate`'s module doc has
   * the full account). Pi runs a model's parallel tool calls concurrently,
   * so two `authorize()` calls can each call `gate.request()` before
   * either resolves. Without serializing, each `request()` would register
   * its OWN `once("line")` listener on the shared `readline` interface —
   * and since a readline `EventEmitter` fires every registered listener
   * for one line, a single "y" typed for the FIRST approval would resolve
   * BOTH pending requests as "allow" simultaneously, approving the second
   * command without anyone ever being asked about it. Chaining every call
   * onto `queue` means only one `nextLine()` await is ever outstanding —
   * later callers wait their turn, in the order they called `request()`.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly nextLine: () => Promise<string | null>,
    private readonly output: { write(chunk: string): unknown } = process.stderr,
    /** T37.1: S0 renders the prompt as a conversation block; the gate then only reads the answer. */
    private readonly onRequest?: (req: ApprovalRequest) => void,
    private readonly opts?: {
      projectId?: string;
      cwd?: string;
      onRememberFolder?: (folder: string) => void;
    },
  ) {}

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const run = this.queue.then(() => this.requestOne(req));
    // Swallow so one denied/erroring request never wedges the chain for
    // whatever is queued behind it — the caller of THIS call still sees
    // the real rejection via `run` itself.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async requestOne(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.onRequest) this.onRequest(req);
    else {
      if (req.kind === "bash" && req.pathAsk !== undefined) {
        this.output.write(
          `\nlykos approval — ${req.kind}: ${req.summary}\n` +
            `  ${req.detail}\n` +
            `  [y] allow once   [n] deny (default)\n`,
        );
      } else if (req.pathAsk?.protected) {
        this.output.write(
          `\nlykos approval — ${req.kind}: ${req.summary}\n` +
            `  ${req.detail}\n` +
            `  [y] allow for this session   [n] deny (default)\n`,
        );
      } else {
        this.output.write(
          `\nlykos approval — ${req.kind}: ${req.summary}\n` +
            `  ${req.detail}\n` +
            `  [y] allow once   [n] deny (default)   [a] always allow ${req.kind} this session   [f] allow this folder\n`,
        );
      }
    }
    this.output.write(`> `);
    const line = (await this.nextLine())?.trim().toLowerCase() ?? "n";
    if (req.kind === "bash" && req.pathAsk !== undefined) {
      if (line === "y" || line === "yes") return "allow";
      return "deny";
    }
    if (req.pathAsk?.protected) {
      if (line === "y" || line === "yes") return "allow";
      return "deny";
    }
    if (line === "a" || line === "always") return "allow-always";
    if (line === "f" || line === "folder") {
      const folder = folderOfPath(req.detail);
      // Remembering is the caller's (`authorize`, the confine), which knows the project's cwd.
      this.opts?.onRememberFolder?.(folder);
      return "allow-folder";
    }
    if (line === "y" || line === "yes") return "allow";
    return "deny";
  }
}

interface AuthorizeOpts {
  isPath: boolean;
}

async function authorize(
  cwd: string,
  gate: ApprovalGate,
  req: ApprovalRequest,
  opts: AuthorizeOpts,
  denials?: DenialLog,
): Promise<void> {
  // T87.2/T87.3: these messages are read by the MODEL, not by a log reader.
  // Pi catches a throwing tool and hands the message back as an `isError`
  // tool result (verified in the SDK's executeToolCall: the catch builds
  // `createErrorToolResult(error.message)`), so a refusal is already
  // recoverable and the turn survives — T87.1's investigation found the
  // mechanism correct. What was wrong was the text: it named an internal
  // task ID the model cannot act on, and it did not say what WOULD be
  // allowed. A refusal the model cannot learn from turns a healthy "not that
  // file" into a stall.
  let pathAsk: ApprovalRequest["pathAsk"];
  let isProtected = false;
  if (opts.isPath) {
    const access: PathAccess = req.kind === "read" ? "read" : "write";
    const { rules, ctx } =
      gate.pathRules !== undefined && gate.pathContext !== undefined
        ? { rules: gate.pathRules, ctx: gate.pathContext }
        : await resolvePathRulesAndContext(cwd);
    const pathVerdict = decidePath(req.detail, access, rules, ctx);
    if (pathVerdict.decision === "deny") {
      denials?.record("out_of_root", req.kind, req.detail);
      if ("denied" in gate && Array.isArray((gate as any).denied)) {
        (gate as any).denied.push({
          kind: req.kind,
          summary: req.summary,
          detail: req.detail,
          rule: pathVerdict.rule ?? "outside the project directory",
        });
      }
      throw new ApprovalDeniedError(pathDenialMessage(req.detail, pathVerdict.reason));
    }
    if (pathVerdict.decision === "ask") {
      isProtected = pathVerdict.protected === true;
      const normalizedPath = posix.normalize(req.detail.replace(/\\/g, "/"));
      if (!isProtected || !sessionAllowedProtectedPaths.get(gate)?.has(normalizedPath)) {
        pathAsk = {
          rule: pathVerdict.rule ?? (isProtected ? "protected path" : "outside the project directory"),
          ...(isProtected ? { protected: true } : {}),
        };
      }
    }
  } else if (req.kind === "bash") {
    const { rules, ctx } =
      gate.pathRules !== undefined && gate.pathContext !== undefined
        ? { rules: gate.pathRules, ctx: gate.pathContext }
        : await resolvePathRulesAndContext(cwd);
    const pathVerdict = decideCommandPaths(req.detail, rules, ctx);
    if (pathVerdict.covered) {
      if (pathVerdict.decision === "deny") {
        denials?.record("out_of_root", req.kind, req.detail);
        if ("denied" in gate && Array.isArray((gate as any).denied)) {
          (gate as any).denied.push({
            kind: req.kind,
            summary: req.summary,
            detail: req.detail,
            rule: pathVerdict.rule ?? "outside the project directory",
          });
        }
        throw new ApprovalDeniedError(pathDenialMessage(req.detail, pathVerdict.reason));
      }
      if (pathVerdict.decision === "ask") {
        isProtected = pathVerdict.protected === true;
        pathAsk = {
          rule: pathVerdict.rule ?? (isProtected ? "protected path" : "outside the project directory"),
          ...(isProtected ? { protected: true } : {}),
        };
      }
    }
  }
  // **Every request reaches the gate. There is no short-circuit here, and
  // adding one back is a security bug.**
  //
  // Until T131's follow-up this began `if (alwaysAllowed.has(req.kind))
  // return;`, and `allow-always` did `alwaysAllowed.add(req.kind)`. Because
  // the INTERACTION MODE lives inside the gate, that line did not merely
  // widen one approval — it removed the mode from the decision. One `a`
  // answered to `npm test` marked the whole `bash` kind allowed for the rest
  // of the process, so every later command ran unasked, `rm -rf` included,
  // and switching to Ask or Plan could not take it back.
  //
  // "Always" is now remembered at the granularity the policy actually
  // reasons about — a command PATTERN, per project, in `permissions.ts` —
  // and the gate applies it on the next request like any other input. So
  // `allow-always` here means exactly what `allow` means: this one may run.
  // The remembering already happened, inside the gate, where the mode and
  // the destructive-command check can both see it.
  const sent = pathAsk === undefined ? req : { ...req, pathAsk };
  const decision = await gate.request(sent);
  if (decision === "allow-folder") {
    if (opts.isPath && !isProtected) {
      const folder = folderOfPath(req.detail);
      try {
        rememberExtraDir(projectIdForCwd(cwd), folder);
      } catch {
        // best effort
      }
    }
    return;
  }
  if (decision === "allow-always") return;
  if (decision === "allow") {
    if (isProtected) {
      const allowed = sessionAllowedProtectedPaths.get(gate) ?? new Set<string>();
      allowed.add(posix.normalize(req.detail.replace(/\\/g, "/")));
      sessionAllowedProtectedPaths.set(gate, allowed);
    }
    return;
  }
  denials?.record("user_rejected", req.kind, req.detail);
  const ruled = gate.denialReason?.(sent);
  if (ruled !== undefined) throw new ApprovalDeniedError(ruled);
  throw new ApprovalDeniedError(
    `lykos: the human declined this ${req.kind} (${req.summary}) on ${req.detail}. ` +
      `This is a choice, not a failure — the same call will be declined again. ` +
      `Try a different approach, or ask what they would prefer.`,
  );
}

/**
 * T87.4: a refusal is a human intervention, not a failure.
 *
 * `human_interventions` has counted `steer()` calls only since T34.3. A
 * declined write is the same category of event — the human redirecting the
 * agent — and counting it as a tool failure instead would inflate the very
 * error rates T85's brake and T24's edit-retry metric read.
 */
export type DenialReason = "out_of_root" | "user_rejected" | "specialist_restricted";

export class DenialLog {
  outOfRoot = 0;
  userRejected = 0;
  specialistRestricted = 0;
  /** The most recent refusal, for the session note. */
  last: string | undefined;

  record(reason: DenialReason, kind: GatedToolKind | string, detail: string): void {
    if (reason === "out_of_root") this.outOfRoot += 1;
    else if (reason === "user_rejected") this.userRejected += 1;
    else if (reason === "specialist_restricted") this.specialistRestricted += 1;
    this.last = `${kind} ${detail} (${reason})`;
  }

  get total(): number {
    return this.outOfRoot + this.userRejected + this.specialistRestricted;
  }
}

/** Exported for direct unit testing — the gating logic itself, without needing to fake Pi's tool-dispatch machinery to exercise it. */
export function buildWriteOperations(cwd: string, gate: ApprovalGate, denials?: DenialLog): WriteOperations {
  return {
    async writeFile(absolutePath, content) {
      await authorize(
        cwd,
        gate,
        { kind: "write", summary: `write ${content.length} bytes`, detail: absolutePath, body: content },
        { isPath: true },
        denials,
      );
      await mkdirFs(dirname(absolutePath), { recursive: true });
      await writeFileFs(absolutePath, content, "utf8");
    },
    async mkdir(dir) {
      // Pi's write tool calls mkdir(dirname) before every writeFile. An existing directory is not
      // created, so there is nothing to approve: the write's own request names the file (T218).
      try {
        if (statSync(dir).isDirectory()) return;
      } catch {
        // absent: decided below
      }
      const { rules, ctx } =
        gate.pathRules !== undefined && gate.pathContext !== undefined
          ? { rules: gate.pathRules, ctx: gate.pathContext }
          : await resolvePathRulesAndContext(cwd);
      const pathVerdict = decidePath(dir, "write", rules, ctx);
      if (pathVerdict.decision === "deny") {
        denials?.record("out_of_root", "write", dir);
        if ("denied" in gate && Array.isArray((gate as any).denied)) {
          (gate as any).denied.push({
            kind: "write",
            summary: "create directory",
            detail: dir,
            rule: pathVerdict.rule ?? "outside the project directory",
          });
        }
        throw new ApprovalDeniedError(pathDenialMessage(dir, pathVerdict.reason));
      }
      if (pathVerdict.decision === "ask") {
        await authorize(
          cwd,
          gate,
          { kind: "write", summary: "create directory", detail: dir },
          { isPath: true },
          denials,
        );
      }
      await mkdirFs(dir, { recursive: true });
    },
  };
}

/**
 * P10.4 (ticket 14, D3): the one gate call, for an edit whose approval BODY
 * is not the new file's content.
 *
 * `buildEditOperations()` below shows the human the whole new file, because
 * that is all a `writeFile(path, content)` seam has to show — the comment on
 * `ApprovalRequest.body` says so, and `edit.ts` follows it. `ast_edit` has
 * something better: it computes the entire rewrite across every file before
 * it asks for anything, so it can show a unified diff of exactly what
 * changes. This is not a second approval surface and must never become one —
 * it is the SAME `authorize()`, with the same scope clamp, the same
 * `{ kind: "edit" }` operation, the same interaction-mode policy behind the
 * gate and the same denial record. The only thing that differs is which text
 * the human is shown while deciding.
 *
 * The write itself stays the caller's, because a tool that has already staged
 * every file in memory should not have to hand them back one at a time
 * through an `Operations` object to get them written.
 */
export async function authorizeEditBody(
  cwd: string,
  gate: ApprovalGate,
  absolutePath: string,
  summary: string,
  body: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(
    cwd,
    gate,
    { kind: "edit", summary, detail: absolutePath, body },
    { isPath: true },
    denials,
  );
}

/**
 * T179 (P15, stories 21-23): the one gate call for a `commit`.
 *
 * A commit is asked the way an edit is: the SAME `authorize()`, the same
 * `{ kind: "edit" }` operation and therefore the same tier, interaction-mode
 * policy and denial record, so an interaction mode that asks for edits asks
 * for commits and one that refuses them refuses these. Nothing about a commit
 * is a path inside the project root, so the scope clamp is off here; the paths
 * a call names are checked by the tool before it asks. `body` is the commit
 * message, which is what the human is deciding to record.
 */
export async function authorizeCommit(
  cwd: string,
  gate: ApprovalGate,
  summary: string,
  detail: string,
  body: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(cwd, gate, { kind: "edit", summary, detail, body }, { isPath: false }, denials);
}

/**
 * P10.5 (ticket 16, D8): the one gate call for a command that is not run
 * through Pi's `BashOperations` seam.
 *
 * `hub start` runs a command. Backgrounding it is not a permission, so it
 * reaches this gate exactly as `bash` does — the SAME `authorize()`, the same
 * `{ kind: "bash" }` operation, and therefore the same `classifyCommandRisk`
 * in `gate/modes.ts` and the same interaction-mode policy behind it. A command
 * does not become safer by being started in the background; if anything it is
 * less supervised, because nobody is watching its output as it runs.
 *
 * This exists rather than `hub` reusing `buildBashOperations()` because that
 * wrapper also owns T88's foreground timeout, and a background job whose whole
 * purpose is to outlive a timeout must not inherit one. The half `hub` needs
 * is the approval, and the half it must not have is the timer, so the
 * approval is the part that is shared.
 *
 * `summary` is the caller's because the human should be told which of the two
 * things is about to happen; `detail` is the command text, which is what the
 * `bash` path passes and what the modal renders.
 */
export async function authorizeCommand(
  cwd: string,
  gate: ApprovalGate,
  summary: string,
  command: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(cwd, gate, { kind: "bash", summary, detail: command, shell: "bash" }, { isPath: false }, denials);
}

/**
 * P10.6 (ticket 19, D3): the one gate call for a forge operation.
 *
 * `github` does not run a command line and does not touch a path, so neither
 * `authorizeCommand` nor `authorizeEditBody` fits: the first would put a `gh`
 * argument array through a POSIX shell classifier, and the second would apply
 * a project-root scope clamp to a repository on the internet. This is the SAME
 * `authorize()` both of those call, with the same interaction-mode policy
 * behind it and the same denial record; the only thing that differs is the
 * operation kind, and therefore the tier.
 *
 * `summary` is the caller's because D3 is specifically about what the human is
 * told — "push feature/x to acme/widgets — the commits become visible to
 * everyone who can see that repository" rather than "run github".
 */
export async function authorizeForgeOperation(
  cwd: string,
  gate: ApprovalGate,
  tier: "read" | "write",
  summary: string,
  detail: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(
    cwd,
    gate,
    { kind: tier === "write" ? "github" : "read", summary, detail },
    { isPath: false },
    denials,
  );
}

/**
 * P10.7 (ticket 12, D4): the one gate call for a read of something on the
 * network.
 *
 * `web_fetch` and `web_search` are the two tools the `read` KIND above was
 * described for — "a NETWORK read", in `GatedToolKind`'s own comment, written
 * when `github`'s read operations borrowed the tier those two were declared
 * at. This is not a second approval surface: it is the SAME `authorize()`,
 * with the same interaction-mode policy behind it and the same denial record.
 * The only reason it exists as its own function rather than as a call to
 * `authorizeForgeOperation` is that a web page is not a forge operation and a
 * name that says otherwise is a name that stops being read.
 *
 * `isPath: false`, like every other non-file gate call here: a URL is not a
 * path and the project-root scope clamp has nothing true to say about one.
 * The address policy that DOES apply to a URL is `tools/web-fetch.ts`'s, and
 * it runs before this — a refused address never reaches the gate, because
 * asking a human to approve something that is going to be refused anyway
 * teaches them to say yes without reading.
 */
export async function authorizeNetworkRead(
  cwd: string,
  gate: ApprovalGate,
  summary: string,
  detail: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(cwd, gate, { kind: "read", summary, detail }, { isPath: false }, denials);
}

/**
 * P10.6 (ticket 19, D5): the one gate call for an evaluated cell.
 *
 * `eval` reaches the gate on EVERY call — it runs arbitrary code, and there is
 * no version of that which is a read. The code itself is the `body`, so the
 * human approving it sees the whole cell rather than a one-line summary of it;
 * that is the same choice `write` and `edit` make, for the same reason.
 *
 * It is deliberately not a `bash`-kind request. A `bash` request is classified
 * by `command-safety.ts`, which parses POSIX shell; handed a JavaScript cell
 * it would find no head it recognises, answer "ordinary", and Auto would then
 * offer to REMEMBER that as an always-allow pattern — a pattern matched
 * against source code. This is the same trap `powershell` documents, and the
 * same answer: the declared tier wins.
 */
export async function authorizeEvalCell(
  cwd: string,
  gate: ApprovalGate,
  summary: string,
  detail: string,
  body: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(cwd, gate, { kind: "eval", summary, detail, body }, { isPath: false }, denials);
}

/**
 * P10.4 / T199 / T208: identity of an extension tool invocation parsed from an ApprovalRequest.
 */
export interface ExtensionRequestTarget {
  tool: string;
  extension: string;
}

/** Builds an ApprovalRequest for a Lykos extension tool call. */
export function buildExtensionRequest(
  tool: string,
  extension: string,
  body?: string,
): ApprovalRequest {
  const trimmedTool = tool.trim();
  const trimmedExt = extension.trim();
  return {
    kind: "extension",
    summary: `run the extension tool ${trimmedTool}`,
    detail: `${trimmedTool} (extension ${trimmedExt})`,
    ...(body !== undefined ? { body } : {}),
  };
}

/** Parses the tool name and extension name from an extension ApprovalRequest. */
export function parseExtensionRequest(req: ApprovalRequest): ExtensionRequestTarget | undefined {
  if (req.kind !== "extension") return undefined;
  const match = /^(.+?)\s+\(extension\s+([^)]+)\)$/.exec(req.detail.trim());
  if (!match) return undefined;
  return { tool: match[1]!.trim(), extension: match[2]!.trim() };
}

/**
 * P10.9 (ticket 21, D4): the one gate call for a tool a Lykos extension
 * registered.
 *
 * It exists so that `extensions/api.ts` has somewhere to call that is THIS
 * `authorize()` — the same scope-clamp decision, the same interaction-mode
 * policy behind the gate, the same denial record — rather than a second
 * approval path of its own. That is the property ticket 21's gate-bypass test
 * asserts, and the reason the API never accepts a `ToolDefinition` from an
 * extension: an extension hands over a function and the host builds the
 * definition around it, so there is no shape an extension can return that has
 * this call missing from it.
 *
 * `isPath: false`: an extension tool's arguments are its own, and the
 * project-root clamp has nothing true to say about an arbitrary JSON object.
 * Whatever that tool then does to a file goes through `write`/`edit`/`bash`
 * like anything else, and those are clamped.
 *
 * `detail` is the call as the model made it, and `body` the arguments in full,
 * because the human approving a tool nobody in this repository wrote should be
 * looking at what it was actually asked to do rather than at its name.
 */
export async function authorizeExtensionTool(
  cwd: string,
  gate: ApprovalGate,
  summary: string,
  detail: string,
  body: string,
  denials?: DenialLog,
): Promise<void> {
  await authorize(cwd, gate, { kind: "extension", summary, detail, body }, { isPath: false }, denials);
}

export function buildEditOperations(cwd: string, gate: ApprovalGate, denials?: DenialLog): EditOperations {
  return {
    readFile: (absolutePath) => readFileFs(absolutePath),
    async writeFile(absolutePath, content) {
      await authorize(
        cwd,
        gate,
        { kind: "edit", summary: "apply edit", detail: absolutePath, body: content },
        { isPath: true },
        denials,
      );
      await writeFileFs(absolutePath, content, "utf8");
    },
    access: (absolutePath) => accessFs(absolutePath, fsConstants.R_OK | fsConstants.W_OK),
  };
}

/**
 * P10.4 (ticket 13, D3): the one gated `exec`, parameterised by which shell
 * runs it.
 *
 * `bash` and `powershell` differ in exactly two places — the `Operations`
 * object Pi builds the child process from, and the `shell` tag that tells
 * `gate/modes.ts` not to run a POSIX classifier over a PowerShell line. The
 * approval request, the scope-clamp decision, the default-timeout rule and
 * the timeout notice are the same for both, so they are written once here.
 * Two copies would be two places to forget T88's timeout, and the second one
 * is the one nobody would remember to fix.
 */
function buildShellOperations(
  shell: "bash" | "powershell",
  cwd: string,
  gate: ApprovalGate,
  denials?: DenialLog,
  opts: ShellOperationsOpts = {},
): BashOperations {
  // T172: the process comes from the session's executor, chosen AFTER the
  // approval below, so which executor a session has cannot change what it is
  // asked to approve.
  const local = (opts.executor ?? localExecutor).shellOperations(shell);
  const fallback =
    opts.defaultTimeoutSeconds === undefined ? bashTimeoutFromEnv() : opts.defaultTimeoutSeconds;
  return {
    async exec(command, execCwd, options) {
      await authorize(
        cwd,
        gate,
        { kind: "bash", summary: "run command", detail: command, shell },
        { isPath: false },
        denials,
      );
      // T88: Pi ships NO default timeout ("Timeout in seconds (optional, no
      // default timeout)"), so an unattended command can hang the session
      // forever. Lykos supplies one when the model did not; a timeout the
      // model chose is always honoured, because it is allowed to know its
      // own build is slow.
      const timeout = resolveBashTimeout(options.timeout, fallback);
      let sawOutput = false;
      const onData = (data: Buffer): void => {
        if (data.length > 0) sawOutput = true;
        options.onData(data);
      };
      try {
        return await local.exec(command, execCwd, { ...options, onData, ...(timeout !== undefined ? { timeout } : {}) });
      } catch (err) {
        if (!isTimeoutError(err) || timeout === undefined) throw err;
        // T88.3: turn the throw into a normal non-zero exit so Pi formats
        // the output it already streamed. A bare rethrow would discard the
        // partial output, which is usually where the reason is.
        onData(Buffer.from(timeoutNotice(command, timeout, sawOutput), "utf8"));
        return { exitCode: TIMEOUT_EXIT_CODE };
      }
    },
  };
}

/** What the `bash` and `powershell` operations take beside the gate. */
export interface ShellOperationsOpts {
  defaultTimeoutSeconds?: number | undefined;
  /** T172: where the command runs. Absent means this machine. */
  executor?: ProjectExecutor | undefined;
}

export function buildBashOperations(
  cwd: string,
  gate: ApprovalGate,
  denials?: DenialLog,
  opts: ShellOperationsOpts = {},
): BashOperations {
  return buildShellOperations("bash", cwd, gate, denials, opts);
}

/**
 * P10.4 (ticket 13, D3): `powershell`'s operations, which are `bash`'s with a
 * different child process.
 *
 * The tool was dropped early on because "the sandbox is Linux". The machine
 * the maintainer actually sits at is Windows, Pi ships the tool, and a shell
 * is a shell — so it is restored, and it reaches the gate exactly as `bash`
 * does rather than through a second approval path. `PowerShellOperations` is
 * a type alias for `BashOperations` in Pi's own source, which is why one
 * wrapper serves both; the only Lykos-side difference is the `shell` tag on
 * the approval request.
 */
export function buildPowerShellOperations(
  cwd: string,
  gate: ApprovalGate,
  denials?: DenialLog,
  opts: ShellOperationsOpts = {},
): PowerShellOperations {
  return buildShellOperations("powershell", cwd, gate, denials, opts);
}

// The write/edit/bash *tool definitions* that shadow Pi's built-ins live in
// `tools/gated.ts`. This file owns the operations those shadows call.
