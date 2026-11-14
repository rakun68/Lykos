// open-code-review as a review engine (ADR-0062): `delegation.review_engine: ocr`. OCR (alibaba/open-code-review,
// Apache-2.0, a pinned optional dependency) reviews a diff with read-only tools and returns comments placed on lines.
// It has no shell and no write tool, and it runs on the host in a detached worktree of the head.
//
// What Lykos keeps:
//   - Model policy. The model is the reviewer role's, resolved through Lykos's own model runtime with Lykos's
//     credential; OCR is handed the endpoint, the model id and the key by environment, never on the command line. A
//     provider OCR cannot speak stops with that error (R14). OCR's HOME is the run's own folder, so a user's
//     ~/.opencodereview/config.json never chooses the model instead.
//   - The record. The run is a ledger session of its own, the id the findings hang on. OCR reports token totals for the
//     whole run, so the ledger gets one call row with those totals, phase `ocr_aggregate`, never invented per-call rows.
//     OCR's JSON result is the session's transcript, and its log is kept beside it.
//
// OCR's comments become findings with no check: ADR-0061 judges them (low dropped, medium or worse to triage).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviderDecls, cacheModelsPath, generateProviderConfig } from "../config/providers.js";
import type { ResolvedConfig } from "../config/types.js";
import { hostGit } from "../git/host-git.js";
import { withLedgerSync } from "../ledger/use.js";
import { createLykosModelRuntime } from "../session/model-runtime.js";
import { resolveHostModel } from "../session/session.js";
import { TranscriptWriter } from "../session/transcript.js";
import { SEVERITIES, recordFinding, type FindingInput, type Severity } from "./findings.js";

/** The package, pinned in package.json's optionalDependencies. */
export const OCR_PACKAGE = "@alibaba-group/open-code-review";

/** OCR's protocols (`internal/llm/protocol.go`) for the Pi APIs that speak them. Anything else is refused. */
const PROTOCOL_OF_API: Readonly<Record<string, string>> = {
  "openai-completions": "openai",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic",
};

/** The command that runs OCR: node and the package's own launcher, which finds the platform binary. */
export function ocrCommand(): { ok: true; argv: [string, string] } | { ok: false; message: string } {
  try {
    const pkg = createRequire(import.meta.url).resolve(`${OCR_PACKAGE}/package.json`);
    const launcher = join(dirname(pkg), "bin", "ocr.js");
    if (!existsSync(launcher)) return { ok: false, message: `${OCR_PACKAGE} is installed without bin/ocr.js` };
    return { ok: true, argv: [process.execPath, launcher] };
  } catch {
    return { ok: false, message: `${OCR_PACKAGE} is not installed: run npm install in Lykos (it is an optional dependency)` };
  }
}

export interface OcrEndpoint {
  url: string;
  token: string;
  model: string;
  protocol: string;
  /** The provider and model id as Lykos knows them, for the ledger. */
  provider: string;
  headers?: Record<string, string>;
}

/** How a test or another caller supplies the model runtime; absent, the one a session would build. */
export type RuntimeFactory = (config: ResolvedConfig, workspace: string) => Promise<ModelRuntime>;

const defaultRuntime: RuntimeFactory = async (config, workspace) => {
  const generated = generateProviderConfig({ providers: config.providers, builtins: builtinProviderDecls(), targetPath: cacheModelsPath(workspace) });
  if (generated.errors.length > 0) throw new Error(generated.errors.join("; "));
  return createLykosModelRuntime({ ...(generated.written ? { modelsPath: generated.targetPath } : {}), providerConfig: config.providers });
};

/** The reviewer model's endpoint and credential, through Lykos's runtime. Never throws: a refusal says why. */
export async function ocrEndpoint(
  config: ResolvedConfig,
  workspace: string,
  modelSpec: string | undefined,
  runtimeOf: RuntimeFactory = defaultRuntime,
): Promise<{ ok: true; endpoint: OcrEndpoint } | { ok: false; message: string }> {
  try {
    const runtime = await runtimeOf(config, workspace);
    const model = await resolveHostModel(modelSpec ?? config.models.default, runtime);
    const protocol = PROTOCOL_OF_API[model.api];
    if (protocol === undefined) {
      return { ok: false, message: `open-code-review cannot reach ${model.provider}/${model.id}: its API is ${model.api}, and OCR speaks only ${Object.keys(PROTOCOL_OF_API).join(", ")}` };
    }
    const auth = await new ModelRegistry(runtime).getApiKeyAndHeaders(model);
    if (!auth.ok) return { ok: false, message: `open-code-review: no credential for ${model.provider}/${model.id}: ${auth.error}` };
    if (auth.apiKey === undefined || auth.apiKey === "") return { ok: false, message: `open-code-review: ${model.provider}/${model.id} resolved no API key` };
    const url = auth.baseUrl ?? model.baseUrl;
    if (url === undefined || url === "") return { ok: false, message: `open-code-review: ${model.provider}/${model.id} has no base URL` };
    return {
      ok: true,
      endpoint: { url, token: auth.apiKey, model: model.id, protocol, provider: model.provider, ...(auth.headers !== undefined && Object.keys(auth.headers).length > 0 ? { headers: auth.headers as Record<string, string> } : {}) },
    };
  } catch (err) {
    return { ok: false, message: `open-code-review: the reviewer model cannot be resolved: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One OCR comment (`model.LlmComment`), as much of it as Lykos reads. */
export interface OcrComment {
  path?: string;
  start_line?: number;
  end_line?: number;
  content?: string;
  severity?: string;
  category?: string;
}

/** OCR's result file (`cmd/opencodereview/output.go`), as much of it as Lykos reads. */
export interface OcrResult {
  status?: string;
  message?: string;
  session_id?: string;
  comments?: OcrComment[];
  summary?: { files_reviewed?: number; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
  tool_calls?: { total?: number };
  warnings?: unknown[];
}

/** An OCR comment as a finding: its text, its severity (low when OCR names none Lykos knows), its place as the basis. */
export function findingOfComment(c: OcrComment): FindingInput {
  const severity: Severity = (SEVERITIES as readonly string[]).includes(c.severity ?? "") ? (c.severity as Severity) : "low";
  const line = c.start_line !== undefined ? `:${c.start_line}${c.end_line !== undefined && c.end_line !== c.start_line ? `-${c.end_line}` : ""}` : "";
  const text = (c.content ?? "").trim();
  return { text: text === "" ? "(open-code-review gave no text)" : text, severity, basis: `${c.path ?? "?"}${line}${c.category !== undefined ? ` (${c.category})` : ""}` };
}

export interface OcrRunInput {
  /** Any tree of the project: the worktree is added from it. */
  repo: string;
  base: string;
  head: string;
  /** Where the run keeps its HOME, its result and its log. */
  dir: string;
  endpoint: OcrEndpoint;
  /** The task and rulings, as OCR's background. */
  background?: string;
  /** OCR's `--timeout`, minutes per group and round. */
  timeoutMinutes?: number;
  signal?: AbortSignal;
  /** Tests: the command; absent, `ocrCommand()`. */
  argv?: readonly string[];
}

export interface OcrRunOutput {
  exitCode: number | null;
  result?: OcrResult;
  /** OCR's stderr. */
  log: string;
}

/** Runs OCR on base..head in a detached worktree of the head, and removes the worktree after. */
export async function runOcr(input: OcrRunInput): Promise<OcrRunOutput> {
  const argv = input.argv ?? (() => {
    const found = ocrCommand();
    if (!found.ok) throw new Error(found.message);
    return found.argv;
  })();
  const home = join(input.dir, "home");
  const tree = join(input.dir, "worktree");
  const output = join(input.dir, "ocr.json");
  mkdirSync(home, { recursive: true });
  const added = hostGit(["worktree", "add", "--detach", tree, input.head], input.repo);
  if (!added.ok) throw new Error(`open-code-review: the worktree at ${input.head.slice(0, 12)} cannot be added: ${added.stderr ?? ""}`);
  try {
    const args = ["review", "--repo", tree, "--from", input.base, "--to", input.head, "--format", "json", "--audience", "agent", "--output", output, "--timeout", String(input.timeoutMinutes ?? 15)];
    if (input.background !== undefined && input.background.trim() !== "") {
      const file = join(input.dir, "background.md");
      writeFileSync(file, input.background);
      args.push("--background-file", file);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OCR_LLM_URL: input.endpoint.url,
      OCR_LLM_TOKEN: input.endpoint.token,
      OCR_LLM_MODEL: input.endpoint.model,
      OCR_LLM_PROTOCOL: input.endpoint.protocol,
      ...(extraHeaders(input.endpoint.headers) !== undefined ? { OCR_LLM_EXTRA_HEADERS: extraHeaders(input.endpoint.headers)! } : {}),
    };
    // A Claude Code or shell-rc endpoint is a later fallback in OCR's resolver; the variables above come first.
    const { code, log } = await new Promise<{ code: number | null; log: string }>((resolveRun, reject) => {
      const child = spawn(argv[0]!, [...argv.slice(1), ...args], { cwd: input.dir, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const onAbort = (): void => void child.kill();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (c) => {
        input.signal?.removeEventListener("abort", onAbort);
        resolveRun({ code: c, log: err });
      });
    });
    let result: OcrResult | undefined;
    if (existsSync(output)) {
      try {
        result = JSON.parse(readFileSync(output, "utf8")) as OcrResult;
      } catch {
        result = undefined;
      }
    }
    return { exitCode: code, ...(result !== undefined ? { result } : {}), log };
  } finally {
    const removed = hostGit(["worktree", "remove", "--force", tree], input.repo);
    if (!removed.ok) {
      rmSync(tree, { recursive: true, force: true });
      hostGit(["worktree", "prune"], input.repo);
    }
  }
}

export interface OcrReviewRecord {
  ledgerPath: string;
  workspace: string;
  brief: string;
  endpoint: OcrEndpoint;
  run: OcrRunOutput;
  startedAt: number;
  /** The reviewer session the findings are filed under; absent, this run's own. A cycle's recheck files under round 1's. */
  findingsUnder?: string | undefined;
}

/**
 * Files an OCR run in the ledger: a session (its id is the reviewer's), one aggregate call row with OCR's totals, its
 * findings, and its JSON result and log as the transcript. Returns the session id.
 */
export function recordOcrReview(rec: OcrReviewRecord): string {
  const id = randomUUID();
  const { endpoint, run } = rec;
  const sm = run.result?.summary ?? {};
  withLedgerSync(rec.ledgerPath, (ledger) => {
    ledger.startSession({
      id,
      brief: rec.brief,
      model: `${endpoint.provider}/${endpoint.model}`,
      executionShape: "cli_delegate",
      runtime: "host",
      workspace: rec.workspace,
      captureMode: "stream",
      notes: "open-code-review engine (ADR-0062): token figures are the run's totals, one row",
    } as Parameters<typeof ledger.startSession>[0]);
    if (run.result?.summary !== undefined) {
      const cacheRead = sm.cache_read_tokens ?? 0;
      ledger.recordCall({
        sessionId: id,
        agent: "reviewer",
        phase: "ocr_aggregate",
        provider: endpoint.provider,
        model: endpoint.model,
        tokens: { input: Math.max(0, (sm.input_tokens ?? 0) - cacheRead), output: sm.output_tokens ?? 0, cacheRead, cacheWrite: sm.cache_write_tokens ?? 0 },
        latencyMs: Date.now() - rec.startedAt,
      });
    }
    for (const c of run.result?.comments ?? []) recordFinding(ledger, rec.findingsUnder ?? id, findingOfComment(c));
    const transcript = new TranscriptWriter(rec.ledgerPath, id);
    transcript.append({ kind: "assistant_message", text: JSON.stringify(run.result ?? null), final: false });
    transcript.append({ kind: "assistant_message", text: `open-code-review exit ${String(run.exitCode)}\n${run.log}`, final: true });
    const file = transcript.finalize();
    ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
  });
  return id;
}

/** Whether a run produced a review: OCR exits non-zero only when every item failed, and writes no result then. */
export function ocrReviewed(run: OcrRunOutput): boolean {
  return run.result !== undefined && Array.isArray(run.result.comments);
}

/** Headers OCR sets itself and refuses as extras (`internal/llm/resolver.go`, reservedHeaders). */
const RESERVED_HEADERS = new Set(["authorization", "x-api-key", "content-type", "user-agent"]);

/** A provider's extra headers in OCR's form: comma-separated `key=value`, values quoted. Undefined when none remain. */
export function extraHeaders(headers: Record<string, string> | undefined): string | undefined {
  const pairs = Object.entries(headers ?? {})
    .filter(([k]) => !RESERVED_HEADERS.has(k.toLowerCase()))
    .map(([k, v]) => `${k}="${v.replace(/"/g, "")}"`);
  return pairs.length > 0 ? pairs.join(",") : undefined;
}

export interface OcrReviewerInput {
  workspace: string;
  ledgerPath: string;
  config: ResolvedConfig;
  /** The reviewer role's model; absent, the default model. */
  model: string | undefined;
  base: string;
  head: string;
  /** The reviewer's brief: OCR's background (the task, the rulings, the note). */
  brief: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /** Tests: the endpoint, resolved already, and the command. */
  endpoint?: OcrEndpoint | undefined;
  argv?: readonly string[] | undefined;
  /** See `OcrReviewRecord.findingsUnder`. */
  findingsUnder?: string | undefined;
}

/**
 * One OCR review in the shape `lykos review` reads from a reviewer session: `{ outcome: "ok", sessionId }`, or an error
 * with OCR's own message and `next fix_environment` (R14). The run's folder is kept under `.lykos/reviews/`.
 */
export async function runOcrReviewer(input: OcrReviewerInput): Promise<Record<string, unknown>> {
  const fail = (message: string): Record<string, unknown> => ({ outcome: "error", message, next: "fix_environment" });
  if (input.argv === undefined) {
    const found = ocrCommand();
    if (!found.ok) return fail(found.message);
  }
  const resolved = input.endpoint !== undefined ? { ok: true as const, endpoint: input.endpoint } : await ocrEndpoint(input.config, input.workspace, input.model);
  if (!resolved.ok) return fail(resolved.message);
  const dir = join(dirname(input.ledgerPath), "reviews", `ocr-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  input.onProgress?.(`open-code-review on ${resolved.endpoint.provider}/${resolved.endpoint.model}, run folder ${dir}`);
  const startedAt = Date.now();
  let run: OcrRunOutput;
  try {
    run = await runOcr({
      repo: input.workspace,
      base: input.base,
      head: input.head,
      dir,
      endpoint: resolved.endpoint,
      background: input.brief,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.argv !== undefined ? { argv: input.argv } : {}),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!ocrReviewed(run)) {
    const tail = run.log.trim().split("\n").slice(-5).join("\n");
    return fail(`open-code-review gave no review (exit ${String(run.exitCode)})${tail !== "" ? `: ${tail}` : ""}`);
  }
  const sessionId = recordOcrReview({ ledgerPath: input.ledgerPath, workspace: input.workspace, brief: input.brief, endpoint: resolved.endpoint, run, startedAt, findingsUnder: input.findingsUnder });
  return { outcome: "ok", sessionId, engine: "ocr", ocr_status: run.result?.status ?? null, run_dir: dir };
}
