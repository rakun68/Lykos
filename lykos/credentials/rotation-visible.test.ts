// P14.6 ticket 06, plan D8 cases 6-8: rotation made visible.
//
// A fake Anthropic Messages server on 127.0.0.1:0 (`fake-anthropic-server.ts`)
// is scripted per API key. Every credential db, Pi agent dir, home and ledger
// is a tmp path; nothing here reaches the real home, the real ledger or the
// network. Each case asserts what a user, an extension or the ledger can
// observe.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { createLykosModelRuntime, RotationRelay } from "../session/model-runtime.js";
import { createCredentialCommands, showRotationNotices } from "../tui/credential-commands.js";
import { openCredentialDb } from "./db.js";
import { anthropicError, type FakeAnthropicServer, startFakeAnthropicServer } from "./fake-anthropic-server.js";
import { upsertCredential } from "./pool.js";
import { formatRotationNotice, servedCredentialFor } from "./rotate.js";
import { xxHash32 } from "./xxhash32.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-rotation-visible-"));
  dirs.push(d);
  return d;
}
// Nothing here may read the real home: Pi's agent dir and the default db path point at tmp.
process.env.PI_CODING_AGENT_DIR = tmp();
process.env.LYKOS_CREDENTIALS_DB = join(tmp(), "absent.db");

const PROVIDER = "fakeprov";
let server: FakeAnthropicServer;

before(async () => {
  server = await startFakeAnthropicServer();
});
after(async () => {
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => server.reset());

interface Pool {
  dbPath: string;
  modelsPath: string;
}

function newPool(keys: string[]): { pool: Pool; ids: number[]; labels: string[] } {
  const dir = tmp();
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { [PROVIDER]: { baseUrl: server.baseUrl, api: "anthropic-messages", models: [{ id: "m1" }] } } }),
  );
  const dbPath = join(dir, "credentials.db");
  const db = openCredentialDb(dbPath, { create: true })!;
  try {
    const rows = keys.map((key) => upsertCredential(db, PROVIDER, { type: "api_key", key }).row);
    return { pool: { dbPath, modelsPath }, ids: rows.map((r) => r.id), labels: rows.map((r) => r.label) };
  } finally {
    db.close();
  }
}

function runtimeFor(pool: Pool, opts: { sessionId?: string; onRotation?: RotationRelay["emit"] } = {}): Promise<ModelRuntime> {
  return createLykosModelRuntime({
    modelsPath: pool.modelsPath,
    credentialDbPath: pool.dbPath,
    providers: {},
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.onRotation !== undefined ? { onRotation: opts.onRotation } : {}),
  });
}

async function ask(runtime: ModelRuntime, sessionId: string): Promise<{ text: string; message: unknown }> {
  const model = runtime.getModel(PROVIDER, "m1")!;
  const stream = runtime.streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
    { sessionId, maxRetries: 0 } as never,
  );
  let text = "";
  for await (const event of stream) if (event.type === "text_delta") text += event.delta;
  return { text, message: await stream.result() };
}

/** A session id whose xxHash32 lands on `index` among `n` rows. */
function sessionStartingAt(index: number, n: number, tag: string): string {
  for (let i = 0; ; i++) {
    const id = `${tag}-${i}`;
    if (xxHash32(id) % n === index) return id;
  }
}

function sticky(pool: Pool, sessionId: string): { credentialId: number; pinned: number } | undefined {
  const db = openCredentialDb(pool.dbPath, { create: false })!;
  try {
    return db
      .prepare("SELECT credential_id AS credentialId, pinned FROM sticky WHERE session_id = ? AND provider = ?")
      .get(sessionId, PROVIDER) as { credentialId: number; pinned: number } | undefined;
  } finally {
    db.close();
  }
}

describe("the rotation notice and per-call attribution through a real runtime (D2, D4)", () => {
  it("the notice names provider, old label, new label and reason; each message carries its own credential", async () => {
    const { pool, ids, labels } = newPool(["notice-key-a", "notice-key-b"]);
    server.script.set("notice-key-a", [
      { kind: "ok", text: "first from a" },
      { kind: "status", status: 429, body: anthropicError("rate_limit_error", "You have reached your usage limit") },
    ]);
    server.script.set("notice-key-b", [{ kind: "ok", text: "second from b" }]);
    const relay = new RotationRelay();
    const notices: string[] = [];
    showRotationNotices(relay, (line) => notices.push(line));
    const runtime = await runtimeFor(pool, { onRotation: relay.emit });
    const sid = sessionStartingAt(0, 2, "notice");

    const first = await ask(runtime, sid);
    const second = await ask(runtime, sid);
    assert.equal(first.text, "first from a");
    assert.equal(second.text, "second from b");
    assert.deepEqual(notices, [`credential rotated: ${PROVIDER} ${labels[0]} → ${labels[1]} (usage_limit)`]);
    assert.equal(notices[0], formatRotationNotice({ provider: PROVIDER, fromLabel: labels[0]!, toLabel: labels[1]!, reason: "usage_limit" }));
    assert.ok(!notices.join("").includes("notice-key"), "no secret in the notice");
    assert.deepEqual(servedCredentialFor(first.message), { id: ids[0], label: labels[0], type: "api_key" });
    assert.deepEqual(servedCredentialFor(second.message), { id: ids[1], label: labels[1], type: "api_key" });
  });
});

describe("/credential pins a credential for the session (D6, D8.6)", () => {
  it("pins by label, the next call uses the pinned row, and /credential auto unpins", async () => {
    const { pool, ids, labels } = newPool(["pin-key-a", "pin-key-b"]);
    server.script.set("pin-key-a", [{ kind: "ok", text: "from a" }]);
    server.script.set("pin-key-b", [{ kind: "ok", text: "from b" }]);
    const sid = sessionStartingAt(0, 2, "pin");
    const runtime = await runtimeFor(pool, { sessionId: sid });
    const commands = createCredentialCommands({
      session: { sessionId: sid, model: { provider: PROVIDER } },
      config: SHIPPED_DEFAULTS,
      dbPath: pool.dbPath,
    });

    assert.equal((await ask(runtime, sid)).text, "from a", "automatic selection starts on the hashed row");
    const listing = commands.credential("");
    assert.match(listing, new RegExp(`\\* ${labels[0]} {2}api_key {2}ready`));
    assert.match(listing, new RegExp(`  ${labels[1]} {2}api_key {2}ready`));
    assert.ok(!listing.includes("pin-key"), "the listing names labels, never keys");

    assert.equal(commands.credential(labels[1]!), `pinned ${PROVIDER} ${labels[1]} to this session`);
    assert.deepEqual(sticky(pool, sid), { credentialId: ids[1], pinned: 1 });
    assert.equal((await ask(runtime, sid)).text, "from b", "the pin overrides automatic selection");
    assert.match(commands.credential(""), new RegExp(`\\* ${labels[1]} {2}api_key {2}ready {2}pinned`));

    assert.match(commands.credential("key#9"), /has no credential labelled "key#9"; its labels are key#1, key#2/);
    assert.equal(commands.credential("auto"), `${PROVIDER} credential selection is automatic again`);
    assert.equal(sticky(pool, sid)?.pinned, 0);
    assert.equal(commands.credential("auto"), `${PROVIDER} was not pinned; selection is automatic`);
  });
});

describe("an extension reaches only the active credential (D7, D8.7)", () => {
  it("modelRegistry and getAuth return the session's selected key, never the pool, and the pinned one after a pin", async () => {
    const secretA = "sk-ant-EXT-REACH-SECRET-aaaa";
    const secretB = "sk-ant-EXT-REACH-SECRET-bbbb";
    const { pool, ids } = newPool([secretA, secretB]);
    const sid = sessionStartingAt(0, 2, "reach");
    const runtime = await runtimeFor(pool, { sessionId: sid });
    // What Pi hands an extension as `ctx.modelRegistry`.
    const registry = new ModelRegistry(runtime);
    const model = registry.find(PROVIDER, "m1")!;

    const before = await registry.getApiKeyAndHeaders(model);
    assert.ok(before.ok);
    assert.equal(before.ok && before.apiKey, secretA, "the session's selected credential");
    assert.equal(await registry.getApiKeyForProvider(PROVIDER), secretA);
    assert.equal((await runtime.getAuth(PROVIDER))?.auth.apiKey, secretA);
    const listed = await runtime.listCredentials();
    assert.deepEqual(listed.filter((c) => c.providerId === PROVIDER), [{ providerId: PROVIDER, type: "api_key" }]);
    assert.ok(!JSON.stringify(listed).includes("EXT-REACH-SECRET"), "listing the store reveals no key and no pool");

    const db = openCredentialDb(pool.dbPath, { create: false })!;
    try {
      const { pinCredential } = await import("./select.js");
      pinCredential(db, sid, PROVIDER, ids[1]!);
    } finally {
      db.close();
    }
    const pinned = await registry.getApiKeyAndHeaders(model);
    assert.equal(pinned.ok && pinned.apiKey, secretB, "after a pin, the pinned credential and only it");
    assert.equal((await runtime.getAuth(PROVIDER))?.auth.apiKey, secretB);
  });
});

describe("a real interactive session makes rotation visible end to end (D8.8)", () => {
  it("shows the notice, fires credential_rotated, and records two ledger rows with the two labels", async () => {
    const root = tmp();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    mkdirSync(join(workspace, ".lykos"), { recursive: true });
    writeFileSync(
      join(workspace, ".lykos", "config.yaml"),
      [
        "providers:",
        `  ${PROVIDER}:`,
        "    auth: api_key",
        `    baseUrl: ${server.baseUrl}`,
        "    api: anthropic-messages",
        "    models:",
        "      - id: m1",
        "",
      ].join("\n"),
    );
    const dbPath = join(root, "credentials.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    const labelOf = new Map<string, string>();
    for (const key of ["e2e-key-a", "e2e-key-b"]) labelOf.set(key, upsertCredential(db, PROVIDER, { type: "api_key", key }).row.label);
    db.close();
    // The session id is minted inside the child, so the script is by request
    // order: the first call succeeds on whichever row the session starts on,
    // the second is refused with a usage limit on that row and rotates, and
    // everything after succeeds.
    server.upcoming.push(
      { kind: "ok", text: "pong one" },
      { kind: "status", status: 429, body: anthropicError("rate_limit_error", "You have reached your usage limit") },
    );
    server.script.set("e2e-key-a", [{ kind: "ok", text: "pong two" }]);
    server.script.set("e2e-key-b", [{ kind: "ok", text: "pong two" }]);

    const ledgerPath = join(workspace, ".lykos", "ledger.db");
    const eventsFile = join(root, "events.jsonl");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      LYKOS_CREDENTIALS_DB: dbPath,
    };
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(here, "rotation-visible-child.ts"),
        workspace,
        `${PROVIDER}/m1`,
        ledgerPath,
        eventsFile,
        "first question",
        "second question",
      ],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "";
    child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
    const code = await new Promise<number | null>((res, rej) => {
      child.on("error", rej);
      child.on("exit", res);
    });
    assert.equal(code, 0, `child failed:\n${output}`);

    const [first, second, ...rest] = server.seen;
    assert.ok(first !== undefined && second === first, `the second call starts on the same row: ${server.seen.join(",")}`);
    const other = first === "e2e-key-a" ? "e2e-key-b" : "e2e-key-a";
    assert.deepEqual(rest, [other], `the rotation replays on the other row: ${server.seen.join(",")}`);
    const fromLabel = labelOf.get(first)!;
    const toLabel = labelOf.get(other)!;

    // The one-line notice, on the surface the user reads.
    assert.ok(
      output.includes(`credential rotated: ${PROVIDER} ${fromLabel} → ${toLabel} (usage_limit)`),
      `notice missing from the surface output:\n${output}`,
    );
    assert.ok(!output.includes("e2e-key-"), "no key reaches the surface");

    // The event, from the session's own extension host.
    assert.ok(existsSync(eventsFile), "credential_rotated fired");
    const events = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);
    assert.deepEqual(events, [{ provider: PROVIDER, from: fromLabel, to: toLabel, reason: "usage_limit" }]);

    // Two ledger rows, each with the label of the credential that served it.
    const ledger = new Database(ledgerPath, { readonly: true });
    try {
      const rows = ledger
        .prepare(
          `SELECT credential_label, auth_mode FROM calls WHERE provider = ? AND agent = 'worker' ORDER BY ts_utc, rowid`,
        )
        .all(PROVIDER) as Array<{ credential_label: string | null; auth_mode: string }>;
      assert.deepEqual(rows, [
        { credential_label: fromLabel, auth_mode: "api_key" },
        { credential_label: toLabel, auth_mode: "api_key" },
      ]);
    } finally {
      ledger.close();
    }
  });
});
