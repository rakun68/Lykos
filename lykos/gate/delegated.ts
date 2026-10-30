// Delegated gate and permission inheritance (ADR-0041, ADR-0042).
//
// In a delegated session (started through MCP or `lykos run`), there is nobody
// at the terminal to ask. Any action that would prompt in an interactive session
// is denied and recorded. Subagents inherit the parent's permissions and can
// only tighten them.

import {
  type ApprovalGate,
  type ApprovalRequest,
  type ApprovalDecision,
  parseExtensionRequest,
  unwrapGate,
} from "./approval.js";
import {
  decideForMode,
  type GatedAction,
  type InteractionMode,
} from "./modes.js";
import {
  type PathRule,
  type PathContext,
  type PathDecision,
} from "./path-rules.js";
import { classifyCommandRisk } from "./command-safety.js";
import { RISK_TIER_LABEL } from "../tools/tool-risk.js";
import type { ResolvedConfig } from "../config/types.js";
import { DEFAULT_SEAL_WRITERS, DEFAULT_SEAL_ENFORCE_FOR, DEFAULT_TEST_GLOBS } from "../config/defaults.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";
import { activeSeals } from "../seal/active.js";
import { SEAL_EXTENSION } from "../extensions/defaults/index.js";
import { matchGlob } from "../seal/matcher.js";

export interface DeniedAction {
  kind: string;
  summary: string;
  detail: string;
  rule: string;
}

export interface DelegatedGateOptions {
  mode: InteractionMode;
  allowed: ReadonlySet<string>;
  denied: DeniedAction[];
  rules?: PathRule[] | undefined;
  ctx?: PathContext | undefined;
  verifyCommand?: string | undefined;
}

function actionOf(req: ApprovalRequest): GatedAction {
  if (req.kind === "bash") {
    if (req.shell === "powershell") {
      return { kind: "powershell" };
    }
    return { kind: "bash", command: req.detail };
  }
  return { kind: req.kind as any };
}

export class DelegatedGate implements ApprovalGate {
  readonly mode: InteractionMode;
  readonly allowed: ReadonlySet<string>;
  readonly denied: DeniedAction[];
  readonly pathRules?: PathRule[] | undefined;
  readonly pathContext?: PathContext | undefined;
  verifyCommand?: string | undefined;
  private readonly requestRules = new WeakMap<ApprovalRequest, string>();

  constructor(opts: DelegatedGateOptions) {
    this.mode = opts.mode;
    this.allowed = opts.allowed;
    this.denied = opts.denied;
    this.pathRules = opts.rules;
    this.pathContext = opts.ctx;
    this.verifyCommand = opts.verifyCommand;
  }

  private ruleFor(req: ApprovalRequest): string {
    if (req.pathAsk !== undefined) {
      return req.pathAsk.rule;
    }
    const action = actionOf(req);
    const decision = decideForMode(this.mode, action, this.allowed, {
      verifyCommand: this.verifyCommand,
    });
    const tierLabel = RISK_TIER_LABEL[decision.tier] ?? decision.tier;
    return `${this.mode} mode: ${tierLabel}`;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.pathAsk !== undefined) {
      const rule = req.pathAsk.rule;
      this.requestRules.set(req, rule);
      this.denied.push({
        kind: req.kind,
        summary: req.summary,
        detail: req.detail,
        rule,
      });
      return "deny";
    }

    const action = actionOf(req);
    const decision = decideForMode(this.mode, action, this.allowed, {
      verifyCommand: this.verifyCommand,
    });
    if (decision.verdict === "allow") {
      return "allow";
    }

    const tierLabel = RISK_TIER_LABEL[decision.tier] ?? decision.tier;
    const rule = `${this.mode} mode: ${tierLabel}`;
    this.requestRules.set(req, rule);
    this.denied.push({
      kind: req.kind,
      summary: req.summary,
      detail: req.detail,
      rule,
    });
    return "deny";
  }

  denialReason(req: ApprovalRequest): string {
    const rule = this.requestRules.get(req) ?? this.ruleFor(req);
    return `lykos: ${req.kind} ${req.detail} is denied (${rule}); you can grant permission and retry.`;
  }
}

const MODE_STRICTNESS: Record<InteractionMode, number> = {
  manual: 0,
  "accept-edits": 1,
  auto: 2,
};

function stricterMode(parent: InteractionMode, child?: InteractionMode): InteractionMode {
  if (child === undefined) return parent;
  return MODE_STRICTNESS[child] < MODE_STRICTNESS[parent] ? child : parent;
}

const OUTSIDE_STRICTNESS: Record<PathDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function stricterOutside(parent: PathDecision, child?: PathDecision): PathDecision {
  if (child === undefined) return parent;
  return OUTSIDE_STRICTNESS[child] > OUTSIDE_STRICTNESS[parent] ? child : parent;
}

export interface InheritPermissionsParent {
  mode: InteractionMode;
  rules: PathRule[];
  ctx: PathContext;
}

export interface InheritPermissionsChild {
  mode?: InteractionMode;
  rules?: PathRule[];
  extraDirs?: string[];
  outside?: { read?: PathDecision; write?: PathDecision };
}

export interface InheritedPermissions {
  mode: InteractionMode;
  rules: PathRule[];
  ctx: PathContext;
}

export function inheritPermissions(
  parent: InheritPermissionsParent,
  child: InheritPermissionsChild,
): InheritedPermissions {
  const mode = stricterMode(parent.mode, child.mode);
  const childRules = (child.rules ?? []).map((r) => ({
    ...r,
    // Always the subagent's own source, so its ! negations can never cancel a parent rule.
    source: "subagent",
  }));
  const rules = [...parent.rules, ...childRules];
  const parentOutside = parent.ctx?.outside ?? { read: "ask", write: "ask" };
  const home = parent.ctx?.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const ctx: PathContext = {
    cwd: parent.ctx?.cwd ?? "",
    home,
    extraDirs: parent.ctx?.extraDirs ? [...parent.ctx.extraDirs] : [],
    outside: {
      read: stricterOutside(parentOutside.read, child.outside?.read),
      write: stricterOutside(parentOutside.write, child.outside?.write),
    },
  };
  return { mode, rules, ctx };
}

export function labelForSubagent(req: ApprovalRequest, name: string): ApprovalRequest {
  const prefix = `[${name}]`;
  const summary = req.summary.startsWith(prefix) ? req.summary : `${prefix} ${req.summary}`;
  return {
    ...req,
    summary,
  };
}

export interface SubagentGateOptions {
  name: string;
  parentGate: ApprovalGate;
  mode: InteractionMode;
  rules: PathRule[];
  ctx: PathContext;
  allowed?: ReadonlySet<string>;
  readOnly?: boolean;
  verifyCommand?: string | undefined;
}

export class SubagentGate implements ApprovalGate {
  readonly name: string;
  readonly parentGate: ApprovalGate;
  readonly mode: InteractionMode;
  readonly pathRules: PathRule[];
  readonly pathContext: PathContext;
  readonly allowed: ReadonlySet<string>;
  readonly readOnly: boolean;
  verifyCommand?: string | undefined;

  constructor(opts: SubagentGateOptions) {
    this.name = opts.name;
    this.parentGate = opts.parentGate;
    this.mode = opts.mode;
    this.pathRules = opts.rules;
    this.pathContext = opts.ctx;
    this.allowed = opts.allowed ?? new Set();
    this.readOnly = opts.readOnly ?? false;
    this.verifyCommand = opts.verifyCommand ?? getGateVerifyCommand(opts.parentGate);
  }

  refuses(req: ApprovalRequest): boolean {
    if (this.parentGate.refuses?.(req) === true) return true;
    if (!this.readOnly || req.kind === "read") return false;
    if (req.kind === "bash" && req.shell !== "powershell") return classifyCommandRisk(req.detail) !== "read-only";
    return true;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    // A parent that refuses by rule (a read-only Plan session) refuses for its subagent too.
    if (this.parentGate.refuses?.(req) === true) return "deny";
    if (this.readOnly) {
      if (req.kind !== "read") {
        if (req.kind === "bash" && req.shell !== "powershell") {
          if (classifyCommandRisk(req.detail) !== "read-only") {
            return "deny";
          }
        } else {
          return "deny";
        }
      }
    }

    if (req.pathAsk !== undefined) {
      return this.parentGate.request(labelForSubagent(req, this.name));
    }

    const action = actionOf(req);
    const decision = decideForMode(this.mode, action, this.allowed, {
      readOnly: this.readOnly,
      verifyCommand: this.verifyCommand,
    });
    if (decision.verdict === "allow") return "allow";
    if (decision.verdict === "deny") return "deny";

    return this.parentGate.request(labelForSubagent(req, this.name));
  }

  denialReason(req: ApprovalRequest): string | undefined {
    if (this.readOnly && req.kind !== "read") {
      return `lykos: this ${req.kind} (${req.summary}) on ${req.detail} is refused because the subagent is read-only.`;
    }
    return this.parentGate.denialReason?.(labelForSubagent(req, this.name));
  }
}

function stripMatchingQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export interface SealTestCommandAllowanceOptions {
  cwd: string;
  config: ResolvedConfig;
  specialist?: string | undefined;
}

export interface SealTestCommandAllowance {
  (req: ApprovalRequest): boolean;
  canAllow(req: ApprovalRequest): boolean;
  refresh(): void;
  markStale(): void;
  readonly canEverAllow: boolean;
}

export function canSealAllowanceEverAllow(opts: SealTestCommandAllowanceOptions): boolean {
  const { config } = opts;
  const hasSealExtension = config.lykos_extensions.some((e) => e.name === SEAL_EXTENSION);
  if (!hasSealExtension) {
    return false;
  }
  if (config.readOnly === true) {
    return false;
  }
  const specialist = opts.specialist ?? DEFAULT_SPECIALIST;
  const writers = config.seal.writers ?? DEFAULT_SEAL_WRITERS;
  const enforceFor = config.seal.enforce_for ?? DEFAULT_SEAL_ENFORCE_FOR;
  const allowedSpecialists = new Set([...writers, ...enforceFor]);
  return allowedSpecialists.has(specialist);
}

function matchesTemplate(
  command: string,
  template: string,
  testGlobs: readonly string[],
): boolean {
  if (!template) return false;

  if (!template.includes("{files}")) {
    return command === template;
  }

  const [prefix = "", suffix = ""] = template.split("{files}");
  if (!command.startsWith(prefix)) {
    return false;
  }
  if (suffix.length > 0 && !command.endsWith(suffix)) {
    return false;
  }
  if (command.length < prefix.length + suffix.length) {
    return false;
  }

  const middle = command.slice(prefix.length, suffix.length > 0 ? command.length - suffix.length : undefined);
  const trimmedMiddle = middle.trim();
  if (trimmedMiddle.length === 0) {
    return false;
  }

  const tokens = trimmedMiddle.split(/\s+/);
  if (tokens.length === 0) {
    return false;
  }

  for (const token of tokens) {
    const stripped = stripMatchingQuotes(token);
    if (!/^[A-Za-z0-9_./@+-]+$/.test(stripped)) {
      return false;
    }
    if (stripped.split("/").includes("..")) {
      return false;
    }
    const matchesGlob = testGlobs.some((g) => matchGlob(stripped, g));
    if (!matchesGlob) {
      return false;
    }
  }

  return true;
}

/**
 * T199 / T208: allow the recorded or configured test command and dispute_test in delegated and standalone sessions.
 * Checks:
 * 1. lykos-seal extension is enabled in lykos_extensions.
 * 2. Specialist is in seal.writers or seal.enforce_for.
 * 3. dispute_test from lykos-seal is allowed for specialists in seal.enforce_for.
 * 4. Test command matching:
 *    - An active seal exists with a valid test_command, OR (when no active seal exists)
 *      the specialist is in seal.writers and config.seal.test_command is used.
 *    - The command matches the template, and all {files} tokens after stripping one
 *      pair of matching quotes match ^[A-Za-z0-9_./@+-]+$, contain no ".." segment,
 *      and match test_globs.
 *    - For powershell, compound lines, pipelines, redirects, backticks, and subexpressions
 *      (/[;|>&<`$\r\n]/) outside the token rules are rejected.
 */
export function createSealTestCommandAllowance(
  opts: SealTestCommandAllowanceOptions,
): SealTestCommandAllowance {
  const { cwd, config } = opts;
  const canEverAllow = canSealAllowanceEverAllow(opts);
  if (!canEverAllow) {
    return Object.assign((_req: ApprovalRequest) => false, {
      canAllow: (_req: ApprovalRequest) => false,
      refresh: () => {},
      markStale: () => {},
      canEverAllow: false,
    });
  }

  const specialist = opts.specialist ?? DEFAULT_SPECIALIST;
  const writers = new Set(config.seal.writers ?? DEFAULT_SEAL_WRITERS);
  const isWriter = writers.has(specialist);
  const enforceFor = new Set(config.seal.enforce_for ?? DEFAULT_SEAL_ENFORCE_FOR);
  const isEnforced = enforceFor.has(specialist);

  let cachedSeals = activeSeals({ cwd });
  let stale = false;

  function refresh(): void {
    stale = false;
    cachedSeals = activeSeals({ cwd });
  }

  function markStale(): void {
    stale = true;
  }

  function canAllow(req: ApprovalRequest): boolean {
    if (stale) {
      refresh();
    }
    if (req.pathAsk !== undefined) {
      return false;
    }

    const ext = parseExtensionRequest(req);
    if (ext) {
      if (isEnforced && ext.tool === "dispute_test" && ext.extension === SEAL_EXTENSION) {
        return true;
      }
      return false;
    }

    if (req.kind !== "bash") {
      return false;
    }

    const isPowershell = req.shell === "powershell";
    const command = req.detail.trim();
    if (/[\r\n]/.test(command)) {
      return false;
    }

    if (isPowershell && /[;|>&<`$\r\n]/.test(command)) {
      return false;
    }

    const testGlobs = config.seal.test_globs ?? DEFAULT_TEST_GLOBS;
    const seals = cachedSeals.filter((s) => !s.untrustedKey && !s.invalidSignature && !s.missingAtHead);

    const templates: string[] = [];
    if (seals.length > 0) {
      for (const s of seals) {
        const t = s.seal.test_command?.trim();
        if (t && !templates.includes(t)) {
          templates.push(t);
        }
      }
    } else if (isWriter) {
      const t = config.seal.test_command?.trim();
      if (t) {
        templates.push(t);
      }
    }

    if (templates.length === 0) {
      return false;
    }

    for (const template of templates) {
      if (matchesTemplate(command, template, testGlobs)) {
        return true;
      }
    }

    return false;
  }

  return Object.assign((req: ApprovalRequest) => canAllow(req), {
    canAllow,
    refresh,
    markStale,
    canEverAllow: true,
  });
}

export class SealAllowanceGate implements ApprovalGate {
  constructor(
    readonly inner: ApprovalGate,
    readonly allowance: SealTestCommandAllowance,
  ) {}

  get denied(): DeniedAction[] | undefined {
    return "denied" in this.inner && Array.isArray((this.inner as { denied?: unknown }).denied)
      ? (this.inner as { denied: DeniedAction[] }).denied
      : undefined;
  }

  get pathRules(): PathRule[] | undefined {
    return this.inner.pathRules;
  }

  get pathContext(): PathContext | undefined {
    return this.inner.pathContext;
  }

  get verifyCommand(): string | undefined {
    return this.inner.verifyCommand;
  }

  refresh(): void {
    this.allowance.refresh();
    if ("refresh" in this.inner && typeof (this.inner as { refresh?: unknown }).refresh === "function") {
      (this.inner as { refresh: () => void }).refresh();
    }
  }

  refuses(req: ApprovalRequest): boolean {
    if (this.allowance.canAllow(req)) {
      return false;
    }
    return this.inner.refuses?.(req) ?? false;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.allowance.canAllow(req)) {
      return "allow";
    }
    const decision = await this.inner.request(req);
    if (req.summary?.startsWith("git commit") || req.detail?.startsWith("git commit")) {
      this.allowance.markStale();
    }
    return decision;
  }

  denialReason(req: ApprovalRequest): string | undefined {
    return this.inner.denialReason?.(req);
  }
}

export function wrapApprovalGateWithSealAllowance(
  gate: ApprovalGate,
  allowance: SealTestCommandAllowance,
): ApprovalGate {
  if (!allowance.canEverAllow) {
    return gate;
  }
  return new SealAllowanceGate(gate, allowance);
}

/** T204: typed accessor for persisted or gate-allowed patterns from an ApprovalGate. */
export function getAllowedPatterns(gate: ApprovalGate): ReadonlySet<string> {
  const unwrapped = unwrapGate(gate);
  if (unwrapped instanceof SubagentGate || unwrapped instanceof DelegatedGate) {
    return unwrapped.allowed;
  }
  return new Set();
}

/** L4: accessor for verifyCommand from an ApprovalGate. */
export function getGateVerifyCommand(gate: ApprovalGate): string | undefined {
  return gate.verifyCommand ?? unwrapGate(gate).verifyCommand;
}
