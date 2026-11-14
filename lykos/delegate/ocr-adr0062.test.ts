// ADR-0062: open-code-review as an opt-in review engine.
//
// Seams:
//   - `lykos review` with `delegation.review_engine: ocr`, on a real git repository, with OCR replaced by a node script
//     that writes the result file OCR writes (the shape in `cmd/opencodereview/output.go`). The endpoint is handed in.
//   - The endpoint through Lykos's real model runtime, from a provider key in the environment.
//   - The installed OCR binary's own usage, so a version that drops a flag Lykos passes fails here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../config/load.js";
import { defaultLedgerPath, withLedgerSync } from "../ledger/use.js";
import { findingsOf } from "./findings.js";
import { extraHeaders, findingOfComment, ocrCommand, ocrEndpoint, type OcrEndpoint } from "./ocr.js";
import { runReview } from "./review.js";

const saved: Record<string, string | undefined> = {};
let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-ocr-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT", "DEEPSEEK_API_KEY"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.LYKOS_TRUST_WORKSPACE;
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}
function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const OCR_CONFIG = "seal:\n  test_command: node --test {files}\ndelegation:\n  spec_check: false\n  review_engine: ocr\nfeedback:\n  enabled: false\n";

/** A project with `main` and a `feature` branch that changes one file. */
function repo(config = OCR_CONFIG): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-ocr-ws-"));
  git(ws, "init", "-q", "-b", "main");
  git(ws, "config", "core.autocrlf", "false");
  put(ws, ".gitignore", ".lykos/\n");
  put(ws, "src/math.mjs", "export const add = (a, b) => a + b;\n");
  put(ws, ".lykos/config.yaml", config);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  git(ws, "checkout", "-q", "-b", "feature");
  put(ws, "src/math.mjs", "export const add = (a, b) => a - b;\n");
  git(ws, "commit", "-qam", "subtract");
  git(ws, "checkout", "-q", "main");
  return ws;
}

/** A stand-in for OCR: writes `result` to the `--output` path, records its argv and environment, and exits `code`. */
function fakeOcr(result: unknown, code = 0): { argv: string[]; seen: () => { args: string[]; env: Record<string, string | undefined> } } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-fake-ocr-"));
  const script = join(dir, "ocr.mjs");
  const seenPath = join(dir, "seen.json");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const out = args[args.indexOf("--output") + 1];
writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ args, env: { HOME: process.env.HOME, OCR_LLM_URL: process.env.OCR_LLM_URL, OCR_LLM_TOKEN: process.env.OCR_LLM_TOKEN, OCR_LLM_MODEL: process.env.OCR_LLM_MODEL, OCR_LLM_PROTOCOL: process.env.OCR_LLM_PROTOCOL } }));
const result = ${JSON.stringify(result)};
if (result !== null) writeFileSync(out, JSON.stringify(result));
else process.stderr.write("every group failed: 401 from the provider\\n");
process.exit(${code});
`,
  );
  return { argv: [process.execPath, script], seen: () => JSON.parse(readFileSync(seenPath, "utf8")) as { args: string[]; env: Record<string, string | undefined> } };
}

const ENDPOINT: OcrEndpoint = { url: "http://127.0.0.1:9/v1", token: "sk-test-not-a-key", model: "deepseek-v4-flash", protocol: "openai", provider: "deepseek" };

const RESULT = {
  status: "complete",
  session_id: "ocr-session-1",
  comments: [
    { path: "src/math.mjs", start_line: 1, content: "add now subtracts: add(1, 2) returns -1.", severity: "high", category: "bug" },
    { path: "src/math.mjs", start_line: 1, content: "The arrow function could be named.", severity: "low", category: "style" },
  ],
  summary: { files_reviewed: 1, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 200, cache_write_tokens: 0 },
  tool_calls: { total: 3 },
};

describe("ADR-0062: lykos review with delegation.review_engine: ocr", () => {
  it("runs OCR on base..head with the endpoint by environment, and judges its comments as findings without a check", async () => {
    const ws = repo();
    const ocr = fakeOcr(RESULT);
    const r = (await runReview(ws, "feature", { trustSource: "stored", ocr: { endpoint: ENDPOINT, argv: ocr.argv } })) as Record<string, unknown> & {
      reviewer: { session_id: string; engine: string };
      findings: Array<{ severity: string; disposition: string; basis: string }>;
      next: string;
    };
    assert.equal(r["outcome"], "ok", JSON.stringify(r));
    assert.equal(r.reviewer.engine, "ocr");
    assert.deepEqual(r.findings.map((f) => [f.severity, f.disposition]), [["high", "triage"], ["low", "dropped"]], "ADR-0061: no check, so medium+ is triage and low is dropped");
    assert.equal(r.findings[0]!.basis, "src/math.mjs:1 (bug)");
    assert.equal(r.next, "triage");

    const { args, env } = ocr.seen();
    const head = git(ws, "rev-parse", "feature");
    const base = git(ws, "merge-base", "main", "feature");
    assert.equal(args[0], "review");
    assert.equal(args[args.indexOf("--from") + 1], base);
    assert.equal(args[args.indexOf("--to") + 1], head);
    assert.ok(!args.join(" ").includes(ENDPOINT.token), "the key is never on the command line");
    assert.equal(env["OCR_LLM_TOKEN"], ENDPOINT.token);
    assert.equal(env["OCR_LLM_URL"], ENDPOINT.url);
    assert.equal(env["OCR_LLM_MODEL"], "deepseek-v4-flash");
    assert.equal(env["OCR_LLM_PROTOCOL"], "openai");
    assert.ok(env["HOME"]?.startsWith(join(ws, ".lykos", "reviews")), `OCR's HOME is the run's own folder: ${env["HOME"]}`);
    assert.ok(!git(ws, "worktree", "list").includes("worktree"), "the detached worktree is removed");

    const ledgerPath = defaultLedgerPath(ws);
    withLedgerSync(ledgerPath, (ledger) => {
      assert.equal(findingsOf(ledger, r.reviewer.session_id).length, 2);
      const calls = ledger.db.prepare("SELECT phase, input_tokens, output_tokens, cache_read_tokens FROM calls WHERE session_id = ?").all(r.reviewer.session_id) as Array<Record<string, unknown>>;
      assert.deepEqual(calls, [{ phase: "ocr_aggregate", input_tokens: 1000, output_tokens: 300, cache_read_tokens: 200 }], "one aggregate row, input net of the cache read");
      const session = ledger.db.prepare("SELECT transcript_path FROM sessions WHERE id = ?").get(r.reviewer.session_id) as { transcript_path: string };
      assert.match(readFileSync(session.transcript_path, "utf8"), /ocr-session-1/, "OCR's result is the transcript");
    });
  });

  it("R14: an OCR run that wrote no result stops the review with OCR's own message, never as no findings", async () => {
    const ws = repo();
    const ocr = fakeOcr(null, 1);
    const r = await runReview(ws, "feature", { trustSource: "stored", ocr: { endpoint: ENDPOINT, argv: ocr.argv } });
    assert.equal(r["outcome"], "error", JSON.stringify(r));
    assert.equal(r["next"], "fix_environment");
    assert.match(String(r["message"]), /open-code-review gave no review \(exit 1\): every group failed: 401/);
  });

  it("the engine stays the session reviewer unless the config names ocr, and an unknown engine is refused", () => {
    const ws = repo("delegation:\n  spec_check: false\n");
    assert.equal(loadConfig({ cwd: ws }).resolved.delegation.review_engine, "session");
    const bad = repo("delegation:\n  review_engine: opencode\n");
    assert.throws(() => loadConfig({ cwd: bad }), /delegation\.review_engine must be session or ocr/);
  });
});

describe("ADR-0062: the endpoint comes from Lykos's own model runtime", () => {
  it("resolves a key-in-environment provider to its base URL, model id and OpenAI protocol", { timeout: 60_000 }, async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env-test";
    const ws = repo();
    const config = loadConfig({ cwd: ws }).resolved;
    const r = await ocrEndpoint(config, ws, "deepseek/deepseek-v4-flash");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.endpoint.token, "sk-env-test");
    assert.equal(r.endpoint.model, "deepseek-v4-flash");
    assert.equal(r.endpoint.protocol, "openai");
    assert.match(r.endpoint.url, /^https:\/\/api\.deepseek\.com/);
  });

  it("a model nobody can resolve is a refusal with the reason, not a throw", { timeout: 60_000 }, async () => {
    const ws = repo();
    const r = await ocrEndpoint(loadConfig({ cwd: ws }).resolved, ws, "nosuch/not-a-model");
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /open-code-review/);
  });
});

describe("ADR-0062: mapping", () => {
  it("a comment's severity is kept when Lykos knows it, else low; its place and category are the basis", () => {
    assert.deepEqual(findingOfComment({ path: "a.ts", start_line: 3, end_line: 5, content: " text ", severity: "critical", category: "security" }), { text: "text", severity: "critical", basis: "a.ts:3-5 (security)" });
    assert.deepEqual(findingOfComment({ path: "a.ts", content: "x", severity: "nit" }), { text: "x", severity: "low", basis: "a.ts" });
  });

  it("extra headers go as OCR's key=value list, without the ones OCR sets itself", () => {
    assert.equal(extraHeaders({ "X-Title": "Lykos", Authorization: "Bearer k", "x-api-key": "k" }), 'X-Title="Lykos"');
    assert.equal(extraHeaders({ authorization: "k" }), undefined);
    assert.equal(extraHeaders(undefined), undefined);
  });
});

describe("ADR-0062: the installed OCR still takes every flag Lykos passes", () => {
  it("ocr review --help names --repo, --from, --to, --format, --audience, --output, --timeout and --background-file", () => {
    const found = ocrCommand();
    assert.ok(found.ok, "open-code-review is installed with Lykos (optionalDependencies)");
    const help = execFileSync(found.argv[0], [found.argv[1], "review", "--help"], { encoding: "utf8", windowsHide: true });
    for (const flag of ["--repo", "--from", "--to", "--format", "--audience", "--output", "--timeout", "--background-file"]) assert.ok(help.includes(flag), `${flag} in:\n${help}`);
  });
});
