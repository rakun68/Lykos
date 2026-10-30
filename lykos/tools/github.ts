// Forge operations, through the `gh` command-line tool.
//
// **IT RUNS `gh`; IT IS NOT AN API CLIENT (D1).** `gh` already owns
// authentication, enterprise hosts, pagination and rate limits, and
// reimplementing any of that would be work with no upside and a second place
// for a credential to live. Nine operations, each of which builds an ARGUMENT
// ARRAY and spawns the binary directly — never a shell string. There is no
// quoting bug to have if there is no shell, which is why a pull-request body
// full of backticks is passed as one `--body` argument here where the
// reference writes it to a temporary file to keep a shell away from it.
//
// **THIS IS WHY IT DOES NOT GO THROUGH `classifyCommandRisk`.** Every other
// command in this codebase reaches `gate/command-safety.ts` because a human
// or a model wrote a command LINE and something has to read it. Nothing here
// is a line: the operation is a closed set of nine tokens, the binary is
// fixed, and every argument is one Lykos built from a typed parameter. Putting
// `["pr", "create", "--title", <model text>]` through a POSIX parser would
// answer a question nobody asked and would classify the model's PR title. The
// tier comes from the registry declaration instead (D3, below), which is the
// same answer `powershell` gets and for the same reason: a tool whose tier is
// a property of the TOOL does not get a second opinion derived from its text.
//
// **A MISSING OR UNAUTHENTICATED `gh` IS A SENTENCE, NOT AN EXCEPTION (D2).**
// The binary is checked at call time — by trying to spawn it, which is the
// only check that cannot go stale between the probe and the call — and an
// `ENOENT` becomes ordinary text naming `gh`, how to install it and how to
// authenticate it. `gh`'s own authentication failure is translated the same
// way. This is `lsp`'s rule for a missing language server, restated: a model
// handed a spawn error or a CLI usage dump learns nothing and retries; a model
// handed a sentence tells the human what to install.
//
// **THE GATE, AND WHY THE TIERS DIFFER (D3).** The six read operations reach
// the gate at the `read` tier — they are network reads, which is the tier
// `web_search` and `web_fetch` are declared at. The three `pr_*` operations
// reach it as writes at the tool's own declared `hard-write` tier, because
// they are OUTWARD-FACING: a created pull request and a pushed branch are
// visible to people who are not in this room, and no scope clamp on the
// project root can take that back. The approval summary therefore names the
// repository and the branch rather than saying "run github", because "what
// will other people see" is the question being answered.
//
// **NO TEST REACHES GITHUB (D4).** The process runner is injected. Every test
// drives a stub that returns canned `gh` output, and `LOCAL_GH_RUNNER` is the
// only thing in this file that spawns anything. **This repository is
// local-only and has no remote**; nothing here adds one.
//
// **WHAT IS DELIBERATELY NOT BUILT**: a dedicated PR worktree
// machinery and its branch-config metadata, the session artifact store for
// failed-job logs, the per-repo write lock, the SQLite response cache, and the
// five `search_*` variants beyond `search_code`. Each is its own lifecycle
// owner; none of them is what this ticket is for.
//
// **`pr_push` IS THE ONE OPERATION THAT IS NOT A `gh` CALL**, and the
// reference says so too ("`gh` command: None. This path uses git, not `gh`") —
// `gh` has no push. It spawns `git` through the same argv runner, so it is
// still an argument array and still not a shell string.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D10), reached through `tool_call`. The measured numbers are asserted in
// `github.test.ts`, so a description that doubles the bill fails a test rather
// than passing silently.

import { spawn } from "node:child_process";
import { PROTECTION_ENV, protectedGitArgs } from "../git/host-git.js";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ApprovalDeniedError,
  authorizeForgeOperation,
  type ApprovalGate,
  type DenialLog,
} from "../gate/approval.js";
import { TREE_KILL_SPAWN_OPTIONS, killProcessTree } from "./job-runner.js";

export const GITHUB_TOOL_NAME = "github";

/** D1's nine. Read operations first, then the three outward-facing writes. */
export const GITHUB_OPS = [
  "repo_view",
  "file_read",
  "issue_list",
  "issue_view",
  "search_code",
  "run_watch",
  "pr_create",
  "pr_checkout",
  "pr_push",
] as const;

export type GithubOp = (typeof GITHUB_OPS)[number];

/**
 * D3: the three that other people can see the result of.
 *
 * Exported and asserted by the test rather than checked inline, so "which
 * operations are writes" has one answer that a later edit cannot quietly
 * disagree with in a second place.
 */
export const GITHUB_WRITE_OPS: readonly GithubOp[] = ["pr_create", "pr_checkout", "pr_push"];

export function isGithubWriteOp(op: GithubOp): boolean {
  return GITHUB_WRITE_OPS.includes(op);
}

/** The reference's `GH_COMMAND_TIMEOUT_MS`, kept: five minutes is long enough for `run watch` to see a workflow finish. */
export const GH_COMMAND_TIMEOUT_MS = 300_000;

/** How much of one `gh` result is handed to the model before it is cut. A result nobody can read is not a result. */
export const GH_MAX_OUTPUT_BYTES = 40_000;

/** Default `--limit` for the two listing operations. The reference's `SEARCH_LIMIT_DEFAULT`. */
export const GH_DEFAULT_LIMIT = 10;

/** The most either listing operation will ask for, whatever was requested. The reference's `SEARCH_LIMIT_MAX`. */
export const GH_MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// The runner (D4)
// ---------------------------------------------------------------------------

export interface GhCommandResult {
  /**
   * `ok` means the process ran and exited, whatever its exit code — a `gh`
   * that says "no such pull request" ran fine and answered. `missing` means
   * the binary is not on this machine. `failed` means the spawn itself did
   * not produce an exit code (a timeout, a permission error).
   */
  status: "ok" | "missing" | "failed";
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when output hit `GH_MAX_OUTPUT_BYTES` and the rest was dropped. */
  truncated: boolean;
  /** Why a `failed` spawn failed, in the words the model is shown. */
  reason?: string;
}

export interface GhRunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The seam every test replaces (D4).
 *
 * `command` is a closed pair rather than a string, so nothing can widen this
 * into "run whatever you like" by passing a different binary: `gh` for the
 * eight forge operations and `git` for `pr_push`, which `gh` cannot do.
 */
export interface GhRunner {
  run(command: "gh" | "git", args: readonly string[], opts: GhRunOptions): Promise<GhCommandResult>;
}

/**
 * The real one, and the only thing in this module that spawns anything.
 *
 * **stdin is `ignore`, and that is the actual guarantee of non-interactivity.**
 * The environment variables below are belt and braces — a `gh` that asked a
 * question would be asking it of a closed pipe and would fail rather than hang
 * — but a tool that hangs forever waiting for a password nobody can type is
 * the failure mode worth spending five lines on twice.
 *
 * The kill on timeout is `killProcessTree` from `job-runner.ts`, not a second
 * implementation: `gh` shells out to `git` for some operations, and killing
 * the direct child on Windows would leave the `git` it started running.
 */
export const LOCAL_GH_RUNNER: GhRunner = {
  run(command, args, opts) {
    return new Promise<GhCommandResult>((resolvePromise) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let truncated = false;
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const finish = (result: GhCommandResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };

      let child;
      try {
        child = spawn(command, command === "git" ? protectedGitArgs(opts.cwd, args) : [...args], {
          cwd: opts.cwd,
          windowsHide: true,
          // No `shell: true`. The whole point of D1 is that there is no shell
          // to quote for.
          stdio: ["ignore", "pipe", "pipe"],
          ...TREE_KILL_SPAWN_OPTIONS,
          env: {
            ...process.env,
            // Never page, never colour, never prompt. A pager would fill the
            // capture buffer with escape sequences; a prompt would block.
            GH_PAGER: "cat",
            PAGER: "cat",
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
            GIT_TERMINAL_PROMPT: "0",
            NO_COLOR: "1",
            // T170: a git that `gh` starts is host git too.
            ...PROTECTION_ENV,
          },
        });
      } catch (err) {
        finish({ status: "failed", code: null, stdout: "", stderr: "", truncated: false, reason: (err as Error).message });
        return;
      }

      const append = (which: "out" | "err") => (chunk: Buffer): void => {
        if (bytes >= GH_MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const room = GH_MAX_OUTPUT_BYTES - bytes;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (slice.length < chunk.length) truncated = true;
        bytes += slice.length;
        if (which === "out") stdout += slice.toString("utf8");
        else stderr += slice.toString("utf8");
      };
      child.stdout?.on("data", append("out"));
      child.stderr?.on("data", append("err"));

      child.on("error", (err) => {
        const code = (err as { code?: string }).code;
        // ENOENT is D2's whole case: the binary is not on this machine. It is
        // reported as its own status rather than as an error string, because
        // the caller turns it into a sentence and must not have to parse one.
        if (code === "ENOENT") {
          finish({ status: "missing", code: null, stdout: "", stderr: "", truncated: false });
          return;
        }
        finish({ status: "failed", code: null, stdout, stderr, truncated, reason: (err as Error).message });
      });

      child.on("close", (code) => {
        finish({ status: "ok", code, stdout, stderr, truncated });
      });

      const timeoutMs = opts.timeoutMs ?? GH_COMMAND_TIMEOUT_MS;
      timer = setTimeout(() => {
        void killProcessTree(child.pid);
        finish({
          status: "failed",
          code: null,
          stdout,
          stderr,
          truncated,
          reason: `\`${command} ${args.join(" ")}\` did not finish within ${Math.round(timeoutMs / 1000)}s and was killed.`,
        });
      }, timeoutMs);

      if (opts.signal !== undefined) {
        onAbort = () => {
          void killProcessTree(child.pid);
          finish({ status: "failed", code: null, stdout, stderr, truncated, reason: "the call was cancelled." });
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },
};

// ---------------------------------------------------------------------------
// D2: the two sentences, and the two patterns that produce them
// ---------------------------------------------------------------------------

/** Exported and asserted verbatim, so it cannot decay into "gh failed" by a later edit that means well. */
export const GH_MISSING_NOTICE =
  "The GitHub CLI (`gh`) is not installed on this machine, so no forge operation can run. Install it — " +
  "`winget install GitHub.cli` on Windows, `brew install gh` on macOS, or see https://cli.github.com — then " +
  "authenticate once with `gh auth login`. Nothing was sent anywhere. Do not retry this call until `gh` is " +
  "installed; use `bash` with `git` for anything that only needs the local repository.";

export const GH_UNAUTHENTICATED_NOTICE =
  "The GitHub CLI (`gh`) is installed but not authenticated, so GitHub refused the request. Run `gh auth login` " +
  "once in a terminal — a human has to do that, this tool cannot — and then retry. Nothing was sent anywhere.";

export const GH_NO_REPO_NOTICE =
  "`gh` could not work out which GitHub repository this is: the working directory has no GitHub remote. Pass " +
  "`repo` explicitly as `owner/name` (or `host/owner/name` for an enterprise host). This project is local-only, " +
  "so there may genuinely be no remote to infer.";

/**
 * Whether `gh`'s complaint is about credentials.
 *
 * Deliberately generous: a false positive tells the human to run `gh auth
 * login`, which is cheap and harmless, while a false negative hands the model
 * a raw CLI error, which is exactly what D2 exists to prevent.
 */
export function isAuthFailure(text: string): boolean {
  return /not logged in|not logged into|gh auth login|authentication token|bad credentials|requires authentication|HTTP 401|GH_TOKEN/i.test(
    text,
  );
}

/** Whether `gh` could not work out which repository it is in. */
export function isNoRepoFailure(text: string): boolean {
  return /no git remotes|none of the git remotes|not a git repository|could not determine|no remotes found|unable to determine/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// D1: the argument arrays
// ---------------------------------------------------------------------------

export interface GithubParams {
  op?: string;
  repo?: string;
  branch?: string;
  path?: string;
  pr?: string;
  issue?: string;
  state?: string;
  query?: string;
  limit?: number;
  run?: string;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  fill?: boolean;
  force?: boolean;
  force_with_lease?: boolean;
}

/**
 * What this module had to ask for before it could build the argv: the
 * repository `gh` would have inferred, the branch git is on, and the workflow
 * run id. Each one is filled in by a call that already happened, so
 * `ghArgsFor` stays pure and a test can assert the argv without a runner.
 */
export interface GhResolved {
  repo?: string;
  branch?: string;
  run?: string;
}

const REPO_VIEW_FIELDS =
  "nameWithOwner,description,url,defaultBranchRef,visibility,isArchived,isFork,stargazerCount,forkCount,primaryLanguage,updatedAt";

const ISSUE_VIEW_FIELDS = "number,title,state,author,createdAt,updatedAt,labels,url,body";

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return GH_DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), GH_MAX_LIMIT);
}

/** `--repo <r>` when the caller named one, and nothing at all when they did not — which is how `gh` infers it from the checkout. */
function repoFlag(repo: string | undefined): string[] {
  return repo === undefined || repo.trim() === "" ? [] : ["--repo", repo.trim()];
}

/**
 * The argument array for one operation, as a pure function.
 *
 * Pure so a test can assert the exact argv without spawning anything, which is
 * the cheapest possible proof that no shell string is ever built: there is no
 * string to build.
 */
export function ghArgsFor(op: GithubOp, params: GithubParams, resolved: GhResolved = {}): string[] {
  const repo = params.repo?.trim() === "" ? undefined : params.repo;
  switch (op) {
    case "repo_view":
      return ["repo", "view", ...(repo !== undefined ? [repo.trim()] : []), "--json", REPO_VIEW_FIELDS];
    case "file_read": {
      const target = resolved.repo ?? repo ?? "";
      const encoded = (params.path ?? "")
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const ref = params.branch?.trim();
      return [
        "api",
        `/repos/${target}/contents/${encoded}`,
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github.raw+json",
        ...(ref !== undefined && ref !== "" ? ["-f", `ref=${ref}`] : []),
      ];
    }
    case "issue_list": {
      const state = params.state?.trim();
      const query = params.query?.trim();
      return [
        "issue",
        "list",
        ...repoFlag(repo),
        "--limit",
        String(clampLimit(params.limit)),
        ...(state !== undefined && state !== "" ? ["--state", state] : []),
        ...(query !== undefined && query !== "" ? ["--search", query] : []),
      ];
    }
    case "issue_view":
      return ["issue", "view", (params.issue ?? "").trim(), ...repoFlag(repo), "--json", ISSUE_VIEW_FIELDS];
    case "search_code":
      return [
        "search",
        "code",
        (params.query ?? "").trim(),
        ...(repo !== undefined ? ["--repo", repo.trim()] : []),
        "--limit",
        String(clampLimit(params.limit)),
      ];
    case "run_watch":
      return ["run", "watch", (resolved.run ?? params.run ?? "").trim(), ...repoFlag(repo), "--exit-status"];
    case "pr_create": {
      const title = params.title?.trim();
      return [
        "pr",
        "create",
        ...repoFlag(repo),
        ...(params.fill === true ? ["--fill"] : []),
        ...(title !== undefined && title !== "" ? ["--title", title] : []),
        // An empty body is passed EXPLICITLY rather than omitted: `gh pr
        // create` with no body opens an interactive editor, and there is
        // nobody here to close one.
        ...(params.fill === true ? [] : ["--body", params.body ?? ""]),
        ...(params.base?.trim() ? ["--base", params.base.trim()] : []),
        ...(params.head?.trim() ? ["--head", params.head.trim()] : []),
        ...(params.draft === true ? ["--draft"] : []),
      ];
    }
    case "pr_checkout":
      return [
        "pr",
        "checkout",
        ...(params.pr?.trim() ? [params.pr.trim()] : []),
        ...repoFlag(repo),
        ...(params.force === true ? ["--force"] : []),
      ];
    case "pr_push": {
      const branch = (resolved.branch ?? params.branch ?? "").trim();
      return [
        "push",
        ...(params.force_with_lease === true ? ["--force-with-lease"] : []),
        "origin",
        `HEAD:refs/heads/${branch}`,
      ];
    }
  }
}


// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const GITHUB_DESCRIPTION =
  "GitHub, through the `gh` command line. Reads: `repo_view` describes a repository; `file_read` returns one " +
  "file's contents from GitHub (use it rather than curl for a file in a GitHub repo); `issue_list` and " +
  "`issue_view` list and open issues; `search_code` searches code on GitHub; `run_watch` follows an Actions run " +
  "to completion and reports what failed. Writes, which other people can see: `pr_create` opens a pull request, " +
  "`pr_checkout` checks one out locally, and `pr_push` pushes the current branch to its remote. `repo` is " +
  "`owner/name` and defaults to the checkout's own repository; omit it unless you mean a different one. Every " +
  "write asks a human first, naming the repository and the branch. If `gh` is missing or not signed in, this " +
  "says so in a sentence and sends nothing.";

export const GITHUB_PARAMETERS = Type.Object({
  op: Type.String({ description: `One of: ${GITHUB_OPS.join(", ")}.` }),
  repo: Type.Optional(
    Type.String({ description: "owner/name, or host/owner/name on an enterprise host. Omit for the current checkout's repository." }),
  ),
  branch: Type.Optional(
    Type.String({ description: "Branch. file_read reads it at this ref; pr_push pushes to it; run_watch looks for its latest run. Defaults to the current branch." }),
  ),
  path: Type.Optional(Type.String({ description: "Repository-relative path to the file. Required for file_read; no leading slash." })),
  pr: Type.Optional(Type.String({ description: "pr_checkout: a PR number, a branch name or a PR URL. Omit for the current branch's PR." })),
  issue: Type.Optional(Type.String({ description: "issue_view: an issue number or URL." })),
  state: Type.Optional(Type.String({ description: "issue_list: open, closed or all. Default open." })),
  query: Type.Optional(Type.String({ description: "search_code: what to search for. issue_list: an optional search filter." })),
  limit: Type.Optional(Type.Number({ description: `How many results to return (default ${GH_DEFAULT_LIMIT}, at most ${GH_MAX_LIMIT}).` })),
  run: Type.Optional(Type.String({ description: "run_watch: an Actions run id or URL. Omit to watch the newest run on `branch`." })),
  title: Type.Optional(Type.String({ description: "pr_create: the pull request title. Required unless fill is true." })),
  body: Type.Optional(Type.String({ description: "pr_create: the pull request body. Omitted means an empty body, never an editor." })),
  base: Type.Optional(Type.String({ description: "pr_create: the branch to merge into." })),
  head: Type.Optional(Type.String({ description: "pr_create: the branch to merge from. Defaults to the current branch." })),
  draft: Type.Optional(Type.Boolean({ description: "pr_create: open it as a draft." })),
  fill: Type.Optional(Type.Boolean({ description: "pr_create: take the title and body from the commits. Cannot be combined with title or body." })),
  force: Type.Optional(Type.Boolean({ description: "pr_checkout: reset an existing local branch to the PR head." })),
  force_with_lease: Type.Optional(Type.Boolean({ description: "pr_push: push with --force-with-lease." })),
});

export interface GithubToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** D4: the process runner. Omitted, the real one; every test passes a stub. */
  runner?: GhRunner;
}

function text(s: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text: s }];
}

interface ToolOut {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

/**
 * D2's shape, borrowed from `lsp`: ordinary text, `success: false`, no throw.
 *
 * `isError` is deliberately NOT set. "You have not installed `gh`" is an
 * answer to the question the model asked, not a failure of the turn, and
 * marking it an error is what makes a model retry the same call.
 */
function unavailable(notice: string, op: GithubOp, why: string): ToolOut {
  return { content: text(notice), details: { op, success: false, available: false, why } };
}

function failure(body: string, op: GithubOp, extra: Record<string, unknown> = {}): ToolOut {
  return { content: text(body), isError: true, details: { op, success: false, ...extra } };
}

/**
 * One `gh`/`git` call, with D2's three translations applied in one place.
 *
 * Returns either the successful output or a finished tool result, so no caller
 * has to remember to check for a missing binary — forgetting once is how a
 * spawn error reaches the model.
 */
async function invoke(
  opts: GithubToolOpts,
  runner: GhRunner,
  op: GithubOp,
  command: "gh" | "git",
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ ok: true; stdout: string; stderr: string; truncated: boolean } | { ok: false; out: ToolOut }> {
  const result = await runner.run(command, args, {
    cwd: opts.cwd,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.status === "missing") {
    return { ok: false, out: unavailable(GH_MISSING_NOTICE, op, `${command} is not installed`) };
  }
  if (result.status === "failed") {
    return {
      ok: false,
      out: failure(`lykos github: ${result.reason ?? `\`${command}\` could not be run.`}`, op),
    };
  }
  if (result.code !== 0) {
    const complaint = `${result.stderr}\n${result.stdout}`;
    if (isAuthFailure(complaint)) {
      return { ok: false, out: unavailable(GH_UNAUTHENTICATED_NOTICE, op, "gh is not authenticated") };
    }
    if (isNoRepoFailure(complaint)) {
      return { ok: false, out: unavailable(GH_NO_REPO_NOTICE, op, "no repository context") };
    }
    // Everything else is `gh`'s own account of what went wrong, which for a
    // missing pull request or a bad ref is the most useful thing there is. The
    // two cases above are the ones where it is not.
    const said = (result.stderr.trim() || result.stdout.trim() || "(no output)").slice(0, 4000);
    return {
      ok: false,
      out: failure(`lykos github: \`${command} ${args.join(" ")}\` exited ${result.code}.\n${said}`, op, {
        exitCode: result.code,
      }),
    };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
}

function truncationNote(truncated: boolean): string {
  return truncated
    ? `\n\n(Output passed the ${GH_MAX_OUTPUT_BYTES}-byte cap and was cut here. Narrow the request — a smaller ` +
        `limit, a single file — rather than assuming this is all of it.)`
    : "";
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function field(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const named = (value as { name?: unknown; login?: unknown }).name ?? (value as { login?: unknown }).login;
    return typeof named === "string" ? named : undefined;
  }
  return undefined;
}

function renderRepoView(stdout: string): string {
  const data = parseJson(stdout);
  if (data === undefined || typeof data !== "object" || data === null) return stdout.trim();
  const record = data as Record<string, unknown>;
  const lines = [`# ${field(record, "nameWithOwner") ?? "(unnamed repository)"}`];
  for (const [label, key] of [
    ["description", "description"],
    ["url", "url"],
    ["default branch", "defaultBranchRef"],
    ["visibility", "visibility"],
    ["language", "primaryLanguage"],
    ["stars", "stargazerCount"],
    ["forks", "forkCount"],
    ["archived", "isArchived"],
    ["fork", "isFork"],
    ["updated", "updatedAt"],
  ] as const) {
    const value = field(record, key);
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

function renderIssueView(stdout: string): string {
  const data = parseJson(stdout);
  if (data === undefined || typeof data !== "object" || data === null) return stdout.trim();
  const record = data as Record<string, unknown>;
  const labels = Array.isArray(record.labels)
    ? (record.labels as Array<{ name?: unknown }>).map((l) => String(l?.name ?? "")).filter((n) => n !== "")
    : [];
  const lines = [
    `# #${field(record, "number") ?? "?"} ${field(record, "title") ?? ""}`.trimEnd(),
    `state: ${field(record, "state") ?? "?"}`,
    `author: ${field(record, "author") ?? "?"}`,
    `created: ${field(record, "createdAt") ?? "?"}`,
    ...(labels.length > 0 ? [`labels: ${labels.join(", ")}`] : []),
    ...(field(record, "url") !== undefined ? [`url: ${field(record, "url")}`] : []),
  ];
  const body = typeof record.body === "string" ? record.body.trim() : "";
  return body === "" ? lines.join("\n") : `${lines.join("\n")}\n\n${body}`;
}

/**
 * D3's approval summary: what other people will be able to see.
 *
 * The repository is named as the model gave it, or as "the current checkout's
 * repository" when it did not — never as a value this module inferred by
 * calling out to the network BEFORE the human said yes, which would be a
 * request made in order to describe a request that has not been approved.
 */
export function writeSummaryFor(op: GithubOp, params: GithubParams, branch: string | undefined): string {
  const repo = params.repo?.trim() ? params.repo.trim() : "the current checkout's repository";
  switch (op) {
    case "pr_create": {
      const head = params.head?.trim() || branch || "the current branch";
      const base = params.base?.trim() || "its default branch";
      return `open a pull request on ${repo} from ${head} into ${base} — visible to everyone who can see that repository`;
    }
    case "pr_checkout": {
      const which = params.pr?.trim() || "the current branch's";
      return `check out pull request ${which} of ${repo} into this working copy, creating a local branch`;
    }
    case "pr_push": {
      const target = branch || params.branch?.trim() || "the current branch";
      return `push ${target} to ${repo}${params.force_with_lease === true ? " with --force-with-lease" : ""} — the commits become visible to everyone who can see that repository`;
    }
    default:
      return `run github ${op}`;
  }
}

export function buildGithubTool(opts: GithubToolOpts): ToolDefinition {
  const runner = opts.runner ?? LOCAL_GH_RUNNER;
  return defineTool({
    name: GITHUB_TOOL_NAME,
    label: "GitHub",
    description: GITHUB_DESCRIPTION,
    promptSnippet: "Read and write GitHub through the gh CLI",
    promptGuidelines: [
      "Use file_read rather than curl or wget for a file that lives in a GitHub repository.",
      "A pull request and a pushed branch are visible to other people; say what you are about to publish before you ask for it.",
    ],
    parameters: GITHUB_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      const raw = params as GithubParams;
      const op = String(raw.op ?? "").trim() as GithubOp;
      if (!(GITHUB_OPS as readonly string[]).includes(op)) {
        const reason = `lykos: unknown github op ${JSON.stringify(raw.op)}. What exists: ${GITHUB_OPS.join(", ")}.`;
        return { content: text(reason), isError: true, details: { error: reason } };
      }

      // ---- per-op local validation, before anything is spawned or approved
      if (op === "file_read") {
        const path = raw.path?.trim() ?? "";
        if (path === "") return failure("lykos github: file_read needs a `path`.", op);
        if (path.startsWith("/")) {
          return failure(
            `lykos github: \`path\` is repository-relative, so it must not start with "/". Pass ${JSON.stringify(path.replace(/^\/+/, ""))}.`,
            op,
          );
        }
      }
      if (op === "issue_view" && (raw.issue?.trim() ?? "") === "") {
        return failure("lykos github: issue_view needs an `issue` — a number or a URL.", op);
      }
      if (op === "search_code" && (raw.query?.trim() ?? "") === "") {
        return failure("lykos github: search_code needs a `query`.", op);
      }
      if (op === "pr_create") {
        if (raw.fill === true && (raw.title?.trim() || raw.body !== undefined)) {
          return failure(
            "lykos github: `fill` takes the title and body from the commits, so it cannot be combined with `title` or `body`. Pick one.",
            op,
          );
        }
        if (raw.fill !== true && (raw.title?.trim() ?? "") === "") {
          return failure("lykos github: pr_create needs a `title`, or `fill: true` to take one from the commits.", op);
        }
      }

      const resolved: { repo?: string; branch?: string; run?: string } = {};

      // ---- the two things that have to be asked before the argv exists ----
      //
      // Both are LOCAL reads of this working copy, not network calls: `git
      // rev-parse` reads `.git/HEAD`. Doing them before the gate is therefore
      // not a request made ahead of approval.
      if ((op === "pr_push" || op === "pr_create") && (raw.branch?.trim() ?? "") === "") {
        const head = await invoke(opts, runner, op, "git", ["rev-parse", "--abbrev-ref", "HEAD"], signal);
        if (head.ok) {
          const name = head.stdout.trim();
          if (name !== "" && name !== "HEAD") resolved.branch = name;
        }
        // A failure here is not fatal for pr_create (git will not be asked
        // again) but it is for pr_push, which has nothing to push.
        if (!head.ok && op === "pr_push") return head.out;
      }
      if (op === "pr_push" && resolved.branch === undefined && (raw.branch?.trim() ?? "") === "") {
        return failure(
          "lykos github: pr_push could not work out which branch to push — this working copy has no branch checked out (a detached HEAD). Pass `branch` explicitly.",
          op,
        );
      }

      // ---- D3: the gate ----
      try {
        if (isGithubWriteOp(op)) {
          await authorizeForgeOperation(
            opts.cwd,
            opts.gate,
            "write",
            writeSummaryFor(op, raw, resolved.branch),
            `github ${op}`,
            opts.denials,
          );
        } else {
          await authorizeForgeOperation(
            opts.cwd,
            opts.gate,
            "read",
            `read from GitHub (${op})`,
            `github ${op}`,
            opts.denials,
          );
        }
      } catch (err) {
        if (err instanceof ApprovalDeniedError) {
          return { content: text(err.message), isError: true, details: { op, error: err.message } };
        }
        throw err;
      }

      // ---- the calls that need a repository spelled out in a URL path ----
      if (op === "file_read" && (raw.repo?.trim() ?? "") === "") {
        const found = await invoke(opts, runner, op, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], signal);
        if (!found.ok) return found.out;
        const name = found.stdout.trim();
        if (name === "") return unavailable(GH_NO_REPO_NOTICE, op, "no repository context");
        resolved.repo = name;
      }

      // ---- run_watch with no run id: the newest one on this branch ----
      if (op === "run_watch" && (raw.run?.trim() ?? "") === "") {
        const branch = raw.branch?.trim();
        const listed = await invoke(
          opts,
          runner,
          op,
          "gh",
          [
            "run",
            "list",
            ...repoFlag(raw.repo),
            ...(branch !== undefined && branch !== "" ? ["--branch", branch] : []),
            "--limit",
            "1",
            "--json",
            "databaseId",
            "-q",
            ".[0].databaseId",
          ],
          signal,
        );
        if (!listed.ok) return listed.out;
        const id = listed.stdout.trim();
        if (id === "") {
          return {
            content: text(
              `No workflow run has been recorded${branch ? ` for branch ${branch}` : ""} yet, so there is nothing to watch. ` +
                "Push a commit, or pass `run` with a run id.",
            ),
            details: { op, success: false, runs: 0 },
          };
        }
        resolved.run = id;
      }

      const command: "gh" | "git" = op === "pr_push" ? "git" : "gh";
      const args = ghArgsFor(op, raw, resolved);
      const result = await invoke(opts, runner, op, command, args, signal);
      if (!result.ok) return result.out;

      const body =
        op === "repo_view"
          ? renderRepoView(result.stdout)
          : op === "issue_view"
            ? renderIssueView(result.stdout)
            : (result.stdout.trim() || result.stderr.trim() || "(no output)");

      return {
        content: text(`${body}${truncationNote(result.truncated)}`),
        details: {
          op,
          success: true,
          command,
          args,
          truncated: result.truncated,
          ...(resolved.repo !== undefined ? { repo: resolved.repo } : {}),
          ...(resolved.branch !== undefined ? { branch: resolved.branch } : {}),
          ...(resolved.run !== undefined ? { run: resolved.run } : {}),
        },
      };
    },
  }) as ToolDefinition;
}
