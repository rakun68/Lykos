// T180, acceptance: a delegated `lykos run` uses a credential from Lykos's own
// pool (~/.lykos/credentials.db), not Pi's auth.json.
//
// A fake Anthropic server sees which API key each request carried. The key is
// only in the pool; the child's Pi agent dir is empty.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { openCredentialDb } from "../credentials/db.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { upsertCredential } from "../credentials/pool.js";
import { openLedgerSync } from "../ledger/use.js";
import { captureStdout, reply, runScriptedSession, say } from "./scripted-session.js";
import { runShow } from "./show.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const PROVIDER = "fakeprov";

let server: FakeAnthropicServer;
before(async () => {
  server = await startFakeAnthropicServer();
});
after(async () => {
  await server.close();
});

describe("a delegated `lykos run` uses Lykos's credential pool (T180)", () => {
  it("the request carries the pooled key, and the answer and the containment line reach stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-delegated-cred-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    mkdirSync(join(workspace, ".lykos"), { recursive: true });
    writeFileSync(
      join(workspace, ".lykos", "config.yaml"),
      ["providers:", `  ${PROVIDER}:`, "    auth: api_key", `    baseUrl: ${server.baseUrl}`, "    api: anthropic-messages", "    models:", "      - id: m1", ""].join("\n"),
    );
    const dbPath = join(root, "credentials.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    try {
      upsertCredential(db, PROVIDER, { type: "api_key", key: "pooled-key" });
    } finally {
      db.close();
    }
    server.script.set("pooled-key", [{ kind: "ok", text: "pong" }]);

    const outFile = join(root, "result.json");
    const child = spawn(process.execPath, ["--import", "tsx", join(here, "delegated-session-child.ts"), workspace, `${PROVIDER}/m1`, outFile], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), LYKOS_CREDENTIALS_DB: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    const exit = await new Promise<number | null>((res, rej) => {
      child.on("error", rej);
      child.on("exit", res);
    });
    assert.equal(exit, 0, `child failed: ${stderr}`);
    assert.equal((JSON.parse(readFileSync(outFile, "utf8")) as { code: number }).code, 0, `lykos run failed: ${stderr}`);
    assert.ok(server.seen.length >= 1 && server.seen.every((k) => k === "pooled-key"), `keys seen: ${server.seen.join(",")}`);
    assert.match(stdout, /pong/);
    assert.match(stdout, /containment: off \(commands ran on this machine\)/);

    // `lykos show` names the pool credential the ledger recorded for the session's calls.
    const ledgerPath = join(workspace, ".lykos", "ledger.db");
    const ledger = openLedgerSync(ledgerPath);
    let sessionId: string;
    let label: string | null;
    try {
      ({ session_id: sessionId, credential_label: label } = ledger.db
        .prepare("SELECT session_id, credential_label FROM calls ORDER BY rowid DESC LIMIT 1")
        .get() as { session_id: string; credential_label: string | null });
    } finally {
      ledger.close();
    }
    assert.ok(label !== null, "the ledger recorded which pool credential served the call");
    const shown = captureStdout("lykos show", () => runShow(ledgerPath, sessionId, {}));
    assert.match(shown, new RegExp(`credential\\s+${PROVIDER}: pool credential ${label} \\(\\d+ calls?\\)`));
  });
});

describe("`lykos show` says when no pool credential served a call (T186)", () => {
  it("a call on a key from outside the pool is shown as such, never as a pool credential", async () => {
    const run = await runScriptedSession({ script: [reply(say("done"))] });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.match(run.show(), /credential\s+\S+: no pool credential \([^)]+\) \(1 call\)/);
  });
});
