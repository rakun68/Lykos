// P14.1 ticket 02, plan D6 cases 1-9: the credential db, the pool, the Pi
// store, auth.json isolation and the cross-process refresh lease. Every test
// uses a tmp dir and an explicit db path; none touches the real home.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLykosModelRuntime } from "../session/model-runtime.js";
import { activeCooldowns, defaultCredentialDbPath, openCredentialDb, upsertCooldown } from "./db.js";
import { disableCredential, listCredentials, listEnabled, readCredentialById, upsertCredential } from "./pool.js";
import { LykosCredentialStore } from "./pi-store.js";

// Ticket 08: keep Pi's agent dir (piHostDir) off the real ~/.lykos/pi-host.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-credstore-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.signature`;
}

function oauth(email: string, access = jwt({ email })): { type: "oauth"; access: string; refresh: string; expires: number } {
  return { type: "oauth", access, refresh: `refresh-${email}`, expires: Date.now() + 3_600_000 };
}

function withDb<T>(path: string, fn: (db: NonNullable<ReturnType<typeof openCredentialDb>>) => T): T {
  const db = openCredentialDb(path, { create: true })!;
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("credential db file (D6.1-3)", () => {
  it("1. is created with mode 0600 and in WAL mode", () => {
    const path = join(tmp(), "nested", "credentials.db");
    const db = openCredentialDb(path, { create: true })!;
    try {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    } finally {
      db.close();
    }
    assert.ok(existsSync(path));
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("2. defaults under ~/.lykos, independent of cwd; LYKOS_CREDENTIALS_DB overrides", () => {
    const before = defaultCredentialDbPath({});
    assert.equal(before, join(homedir(), ".lykos", "credentials.db"));
    const cwd = process.cwd();
    process.chdir(tmp());
    try {
      assert.equal(defaultCredentialDbPath({}), before);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(defaultCredentialDbPath({ LYKOS_CREDENTIALS_DB: "/x/y.db" }), "/x/y.db");
  });

  it("3. reading from a missing file returns undefined and does not create it", async () => {
    const path = join(tmp(), "absent", "credentials.db");
    assert.equal(openCredentialDb(path, { create: false }), undefined);
    const store = new LykosCredentialStore({ dbPath: path });
    assert.equal(await store.read("anthropic"), undefined);
    assert.deepEqual(await store.list(), []);
    await store.delete("anthropic");
    assert.equal(await store.modify("anthropic", async () => undefined), undefined);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(dirname(path)), false);
  });

  it("keeps the later cooldown on upsert (ticket 05's table)", () => {
    withDb(join(tmp(), "c.db"), (db) => {
      upsertCooldown(db, 1, 5_000, { reason: "a" });
      upsertCooldown(db, 1, 3_000, { reason: "b" });
      assert.deepEqual(activeCooldowns(db, 0), [{ credentialId: 1, scope: "", untilMs: 5_000, reason: "a" }]);
      assert.deepEqual(activeCooldowns(db, 6_000), []);
    });
  });
});

describe("the pool (D6.4-6)", () => {
  it("4. the same OAuth identity updates one row; a different one inserts a second", () => {
    withDb(join(tmp(), "c.db"), (db) => {
      const a = upsertCredential(db, "openai", oauth("alice@example.com"));
      const b = upsertCredential(db, "openai", oauth("bob@example.com"));
      const a2 = upsertCredential(db, "openai", { ...oauth("Alice@Example.com"), refresh: "rotated" });
      assert.equal(a.inserted, true);
      assert.equal(b.inserted, true);
      assert.equal(a2.inserted, false);
      assert.equal(a2.row.id, a.row.id);
      assert.equal(JSON.parse(readCredentialById(db, a.row.id)!.data).refresh, "rotated");
      assert.deepEqual(
        listCredentials(db, "openai").map((r) => r.label),
        ["alice@example.com", "bob@example.com"],
      );
    });
  });

  it("an API key source added twice updates rather than duplicates", () => {
    withDb(join(tmp(), "c.db"), (db) => {
      const first = upsertCredential(db, "openai", { type: "api_key", key: "$OPENAI_KEY" });
      const again = upsertCredential(db, "openai", { type: "api_key", key: "$OPENAI_KEY" });
      assert.equal(again.inserted, false);
      assert.equal(again.row.id, first.row.id);
      assert.equal(first.row.label, `key#${first.row.id}`);
      assert.equal(listCredentials(db, "openai").length, 1);
    });
  });

  it("5. an OAuth upsert leaves an existing api_key row enabled", () => {
    withDb(join(tmp(), "c.db"), (db) => {
      const key = upsertCredential(db, "anthropic", { type: "api_key", key: "sk-ant-literal" });
      upsertCredential(db, "anthropic", oauth("carol@example.com"));
      const row = listCredentials(db, "anthropic").find((r) => r.id === key.row.id)!;
      assert.equal(row.disabledCause, null);
      assert.equal(listEnabled(db, "anthropic").length, 2);
    });
  });

  it("6. logout soft-disables: the row stays, with disabled_cause 'logout'", async () => {
    const path = join(tmp(), "c.db");
    const id = withDb(path, (db) => {
      const a = upsertCredential(db, "openai", oauth("dave@example.com"));
      upsertCredential(db, "openai", oauth("erin@example.com"));
      assert.equal(disableCredential(db, a.row.id, "logout"), true);
      return a.row.id;
    });
    withDb(path, (db) => {
      const row = readCredentialById(db, id)!;
      assert.equal(row.disabledCause, "logout");
      assert.deepEqual(listEnabled(db, "openai").map((r) => r.label), ["erin@example.com"]);
    });
    // Pi's delete also soft-disables the active row.
    await new LykosCredentialStore({ dbPath: path }).delete("openai");
    withDb(path, (db) => {
      assert.equal(listCredentials(db, "openai").length, 2);
      assert.equal(listEnabled(db, "openai").length, 0);
    });
  });
});

describe("LykosCredentialStore key sources (D6.7)", () => {
  it("7. resolves $VAR and !command in read; list() never runs the command", async () => {
    const dir = tmp();
    const path = join(dir, "c.db");
    const marker = join(dir, "marker").replace(/\\/g, "/");
    withDb(path, (db) => {
      upsertCredential(db, "openai", { type: "api_key", key: "$LYKOS_TEST_OPENAI" });
      upsertCredential(db, "groq", { type: "api_key", key: `!node -e "require('fs').writeFileSync('${marker}','x');process.stdout.write('groq-from-command')"` });
      upsertCredential(db, "mistral", { type: "api_key", key: "${LYKOS_TEST_UNSET}" });
    });
    const store = new LykosCredentialStore({ dbPath: path, env: { ...process.env, LYKOS_TEST_OPENAI: "sk-from-env" } });

    const listed = await store.list();
    assert.deepEqual(
      [...listed].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      [
        { providerId: "groq", type: "api_key" },
        { providerId: "mistral", type: "api_key" },
        { providerId: "openai", type: "api_key" },
      ],
    );
    assert.equal(existsSync(marker), false, "list() must not execute a !command source");

    assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-from-env" });
    assert.deepEqual(await store.read("groq"), { type: "api_key", key: "groq-from-command" });
    assert.equal(existsSync(marker), true, "read() did run the command, so the marker check above is not vacuous");
    assert.equal(await store.read("mistral"), undefined, "an unset variable reads as absent");
  });

  it("a refresh returning the resolved key keeps the stored source", async () => {
    const path = join(tmp(), "c.db");
    withDb(path, (db) => upsertCredential(db, "openai", { type: "api_key", key: "$LYKOS_TEST_OPENAI" }));
    const store = new LykosCredentialStore({ dbPath: path, env: { LYKOS_TEST_OPENAI: "sk-from-env" } });
    await store.modify("openai", async (current) => current);
    withDb(path, (db) => {
      const [row] = listCredentials(db, "openai");
      assert.equal(JSON.parse(readCredentialById(db, row!.id)!.data).key, "$LYKOS_TEST_OPENAI");
    });
  });

  it("modify writes a refresh to the same row, and a different account into the pool", async () => {
    const path = join(tmp(), "c.db");
    const id = withDb(path, (db) => upsertCredential(db, "anthropic", oauth("frank@example.com")).row.id);
    const store = new LykosCredentialStore({ dbPath: path });
    const refreshedAccess = jwt({ email: "frank@example.com", n: 2 });
    await store.modify("anthropic", async (c) => (c?.type === "oauth" ? { ...c, access: refreshedAccess } : undefined));
    await store.modify("anthropic", async () => oauth("grace@example.com"));
    withDb(path, (db) => {
      const rows = listEnabled(db, "anthropic");
      assert.deepEqual(rows.map((r) => r.label), ["frank@example.com", "grace@example.com"]);
      assert.equal(JSON.parse(readCredentialById(db, id)!.data).access, refreshedAccess);
    });
  });
});

describe("one connection per burst of reads (D27)", () => {
  it("opens the db once for a burst, and releases the file on the next turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-credstore-burst-"));
    const dbPath = join(dir, "credentials.db");
    withDb(dbPath, (db) => upsertCredential(db, "anthropic", { type: "api_key", key: "sk-test" }));
    const store = new LykosCredentialStore({ dbPath });

    // `openCredentialDb` checks the file exists once per open, so counting
    // that check on this path counts the opens.
    const f = fs as unknown as { existsSync: typeof existsSync };
    const orig = f.existsSync;
    let opens = 0;
    f.existsSync = ((p: fs.PathLike) => {
      if (String(p) === dbPath) opens += 1;
      return orig(p);
    }) as typeof existsSync;
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 200; i++) assert.equal((await store.read("anthropic"))?.type, "api_key");
    } finally {
      f.existsSync = orig;
      syncBuiltinESMExports();
    }
    assert.equal(opens, 1, "200 reads in one burst must share one connection");

    // Next turn: the connection is closed, so Windows can delete the directory.
    await new Promise<void>((r) => setImmediate(r));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  });

  it("close() releases the file at once, and the next read reopens it", async () => {
    const dir = tmp();
    const dbPath = join(dir, "credentials.db");
    withDb(dbPath, (db) => upsertCredential(db, "anthropic", { type: "api_key", key: "sk-test" }));
    const store = new LykosCredentialStore({ dbPath });
    await store.read("anthropic");
    store.close();
    store.close();
    assert.equal((await store.read("anthropic"))?.type, "api_key");
    store.close();
  });
});

describe("auth.json is never read (D6.8)", () => {
  it("8. getAuth resolves the Lykos key and no path ending auth.json is opened", async () => {
    const dir = tmp();
    const agentDir = join(dir, "pi-agent");
    fs.mkdirSync(agentDir);
    const authJson = join(agentDir, "auth.json");
    writeFileSync(authJson, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-FROM-AUTH-JSON" } }));
    const dbPath = join(dir, "credentials.db");
    withDb(dbPath, (db) => upsertCredential(db, "anthropic", { type: "api_key", key: "sk-ant-FROM-LYKOS" }));

    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.ANTHROPIC_API_KEY;

    const opened: string[] = [];
    const record = (p: unknown): void => {
      opened.push(p instanceof URL ? p.pathname : String(p));
    };
    const orig = {
      readFileSync: fs.readFileSync,
      openSync: fs.openSync,
      readFile: fs.readFile,
      pReadFile: fs.promises.readFile,
      pOpen: fs.promises.open,
    };
    const f = fs as unknown as Record<string, unknown>;
    const fp = fs.promises as unknown as Record<string, unknown>;
    const spy = <T extends (...a: never[]) => unknown>(original: T): T =>
      function (this: unknown, ...a: unknown[]) {
        record(a[0]);
        return (original as unknown as (...x: unknown[]) => unknown).apply(this, a);
      } as unknown as T;
    f.readFileSync = spy(orig.readFileSync);
    f.openSync = spy(orig.openSync);
    f.readFile = spy(orig.readFile);
    fp.readFile = spy(orig.pReadFile);
    fp.open = spy(orig.pOpen);
    syncBuiltinESMExports();

    let lykosKey: string | undefined;
    let piDefaultKey: string | undefined;
    let openedDuringLykos: string[] = [];
    try {
      const runtime = await createLykosModelRuntime({ credentialDbPath: dbPath });
      lykosKey = (await runtime.getAuth("anthropic"))?.auth.apiKey;
      openedDuringLykos = [...opened];

      // Control: Pi's own default store does read auth.json, and the spies see it.
      const piDefault = await ModelRuntime.create({ authPath: authJson, modelsPath: null });
      piDefaultKey = (await piDefault.getAuth("anthropic"))?.auth.apiKey;
    } finally {
      f.readFileSync = orig.readFileSync;
      f.openSync = orig.openSync;
      f.readFile = orig.readFile;
      fp.readFile = orig.pReadFile;
      fp.open = orig.pOpen;
      syncBuiltinESMExports();
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }

    assert.equal(lykosKey, "sk-ant-FROM-LYKOS");
    assert.deepEqual(openedDuringLykos.filter((p) => p.endsWith("auth.json")), []);
    assert.equal(piDefaultKey, "sk-ant-FROM-AUTH-JSON");
    assert.ok(
      opened.slice(openedDuringLykos.length).some((p) => p.endsWith("auth.json")),
      "the spies must catch Pi's own auth.json read, or the assertion above proves nothing",
    );
  });
});

describe("refresh lease across processes (D6.9)", () => {
  async function waitFor(path: string, child: ChildProcess): Promise<void> {
    while (!existsSync(path)) {
      if (child.exitCode !== null) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function runChild(args: string[]): { child: ChildProcess; done: Promise<void> } {
    const child = spawn(process.execPath, ["--import", "tsx", join(here, "lease-child.ts"), ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    const done = new Promise<void>((res, rej) => {
      child.on("error", rej);
      child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`lease-child exited ${code}: ${err}`))));
    });
    return { child, done };
  }

  it("9. two processes refreshing one credential end with exactly one refresh and one valid token", async () => {
    const dir = tmp();
    const dbPath = join(dir, "c.db");
    const counter = join(dir, "refreshes.txt");
    const go = join(dir, "go");
    const original = "access-original";
    const refreshed = "access-refreshed";
    withDb(dbPath, (db) =>
      upsertCredential(db, "anthropic", { type: "oauth", access: original, refresh: "refresh-original", expires: 0 }),
    );

    const prefixes = [join(dir, "a"), join(dir, "b")];
    const children = prefixes.map((p) => runChild([dbPath, "anthropic", original, refreshed, counter, go, p]));
    await Promise.all(children.map((c, i) => waitFor(`${prefixes[i]}.ready`, c.child)));
    writeFileSync(go, "");
    await Promise.all(children.map((c) => c.done));

    const results = prefixes.map((p) => JSON.parse(readFileSync(`${p}.json`, "utf8")) as { access: string | null });
    assert.deepEqual(results, [{ access: refreshed }, { access: refreshed }]);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "exactly one refresh");
    withDb(dbPath, (db) => {
      const rows = listEnabled(db, "anthropic");
      assert.equal(rows.length, 1, "a refresh never forks a row");
      assert.equal(JSON.parse(readCredentialById(db, rows[0]!.id)!.data).access, refreshed);
      const leases = db.prepare("SELECT count(*) AS n FROM refresh_leases").get() as { n: number };
      assert.equal(leases.n, 0, "both leases were released");
    });
  });
});
