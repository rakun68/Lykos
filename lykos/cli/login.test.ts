// P14.1 ticket 02, plan D6 cases 10-13: `lykos login` and `lykos logout`.
// Every test uses a tmp db path; none touches the real home.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { openCredentialDb } from "../credentials/db.js";
import { type Credential, listCredentials, listEnabled, readCredentialById } from "../credentials/pool.js";
import type { LykosModelRuntimeOptions } from "../session/model-runtime.js";
import { type LoginIO, type LoginRuntime, redactTokens, runLogin, runLogout } from "./login.js";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-login-"));
  dirs.push(d);
  return join(d, "credentials.db");
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Captured {
  io: Partial<LoginIO>;
  out: () => string;
  err: () => string;
}

function io(dbPath: string, stdin = "", extra: Partial<LoginIO> = {}): Captured {
  let out = "";
  let err = "";
  return {
    io: {
      stdin: Readable.from(stdin.length > 0 ? [stdin] : []),
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      env: {},
      dbPath,
      openBrowser: () => {},
      ...extra,
    },
    out: () => out,
    err: () => err,
  };
}

function rows(dbPath: string, provider: string): ReturnType<typeof listCredentials> {
  const db = openCredentialDb(dbPath, { create: false })!;
  try {
    return listCredentials(db, provider);
  } finally {
    db.close();
  }
}

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.signature`;
}

/** A runtime whose `login` persists each queued credential the way Pi's does: `credentials.modify(id, async () => c)`. */
function fakeRuntime(queue: Credential[]): (opts: LykosModelRuntimeOptions) => Promise<LoginRuntime> {
  return async (opts) => ({
    async login(providerId, _type, interaction) {
      interaction.notify({ type: "auth_url", url: "https://auth.example.com/authorize?a=1&b=2" });
      const credential = queue.shift()!;
      await opts.credentials!.modify(providerId, async () => credential);
      return credential;
    },
  });
}

const WARNING = /warning — openai's sanction for third-party use is unverified/;

describe("lykos login --api-key (D6.10)", () => {
  it("10. stores one api_key row; stdout and stderr never contain the key", async () => {
    const dbPath = tmpDb();
    const c = io(dbPath, "sk-test-SECRET\n");
    assert.equal(await runLogin(["openai", "--api-key"], c.io), 0);

    const stored = rows(dbPath, "openai");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.type, "api_key");
    assert.equal(stored[0]!.disabledCause, null);
    const db = openCredentialDb(dbPath, { create: false })!;
    try {
      assert.equal(JSON.parse(readCredentialById(db, stored[0]!.id)!.data).key, "sk-test-SECRET");
    } finally {
      db.close();
    }
    assert.match(c.out(), /^logged in to openai as key#1 \(1 credential\(s\) in pool\)\n$/);
    assert.ok(!c.out().includes("sk-test-SECRET"));
    assert.ok(!c.err().includes("sk-test-SECRET"));
  });

  it("stores a $VAR source as written, without resolving it", async () => {
    const dbPath = tmpDb();
    const c = io(dbPath, "$MY_OPENAI_KEY\n", { env: { MY_OPENAI_KEY: "sk-resolved-SECRET" } });
    assert.equal(await runLogin(["openai", "--api-key"], c.io), 0);
    const db = openCredentialDb(dbPath, { create: false })!;
    try {
      assert.equal(JSON.parse(readCredentialById(db, rows(dbPath, "openai")[0]!.id)!.data).key, "$MY_OPENAI_KEY");
    } finally {
      db.close();
    }
    assert.ok(!(c.out() + c.err()).includes("sk-resolved-SECRET"));
  });

  it("refuses empty stdin", async () => {
    const dbPath = tmpDb();
    const c = io(dbPath, "");
    assert.equal(await runLogin(["openai", "--api-key"], c.io), 1);
    assert.equal(openCredentialDb(dbPath, { create: false }), undefined, "a failed login creates no db");
  });
});

describe("first-login warning (D6.11)", () => {
  it("11. warns before the first openai login, not for openrouter, not before a second openai login", async () => {
    const dbPath = tmpDb();
    const first = io(dbPath, "sk-first\n");
    await runLogin(["openai", "--api-key"], first.io);
    assert.match(first.err(), WARNING);
    assert.equal(first.err().split("\n").filter((l) => l.length > 0).length, 1, "one line");

    const router = io(dbPath, "sk-or-key\n");
    await runLogin(["openrouter", "--api-key"], router.io);
    assert.doesNotMatch(router.err(), /sanction/);

    const second = io(dbPath, "sk-second\n");
    await runLogin(["openai", "--api-key"], second.io);
    assert.doesNotMatch(second.err(), /sanction/);

    const oauthFirst = io(tmpDb(), "", {
      createRuntime: fakeRuntime([{ type: "oauth", access: jwt({ email: "a@x.io" }), refresh: "r", expires: 1 }]),
    });
    assert.equal(await runLogin(["openai"], oauthFirst.io), 0);
    assert.match(oauthFirst.err(), WARNING, "the OAuth path warns too");
  });

  it("warns before first kimi-coding and xai logins on empty pool; openrouter shows no warning (ticket 16, D4, D5.3)", async () => {
    const dbPath = tmpDb();
    const router = io(dbPath, "sk-or-key\n");
    await runLogin(["openrouter", "--api-key"], router.io);
    assert.doesNotMatch(router.err(), /sanction/);

    const kimi = io(dbPath, "sk-kimi-key\n");
    await runLogin(["kimi-coding", "--api-key"], kimi.io);
    assert.match(kimi.err(), /warning — kimi-coding's sanction for third-party use is unverified/);

    const kimiSecond = io(dbPath, "sk-kimi-key2\n");
    await runLogin(["kimi-coding", "--api-key"], kimiSecond.io);
    assert.doesNotMatch(kimiSecond.err(), /sanction/);

    const xai = io(dbPath, "sk-xai-key\n");
    await runLogin(["xai", "--api-key"], xai.io);
    assert.match(xai.err(), /warning — xai's sanction for third-party use is unverified/);

    const xaiSecond = io(dbPath, "sk-xai-key2\n");
    await runLogin(["xai", "--api-key"], xaiSecond.io);
    assert.doesNotMatch(xaiSecond.err(), /sanction/);
  });
});

describe("lykos login OAuth (D6.12)", () => {
  it("12. lands in the Lykos db; a second identity joins the pool; a repeat identity updates", async () => {
    const dbPath = tmpDb();
    const alice = { type: "oauth" as const, access: jwt({ email: "alice@example.com" }), refresh: "rt-ALICE-1", expires: 1 };
    const bob = { type: "oauth" as const, access: jwt({ email: "bob@example.com" }), refresh: "rt-BOB-1", expires: 1 };
    const aliceAgain = { ...alice, refresh: "rt-ALICE-2" };
    const createRuntime = fakeRuntime([alice, bob, aliceAgain]);
    const outputs: string[] = [];
    const opened: string[] = [];

    const login = async (): Promise<Captured> => {
      const c = io(dbPath, "", { createRuntime, openBrowser: (u) => opened.push(u) });
      assert.equal(await runLogin(["openai"], c.io), 0, c.err());
      outputs.push(c.out() + c.err());
      return c;
    };

    const one = await login();
    assert.equal(one.out(), "logged in to openai as alice@example.com (1 credential(s) in pool)\n");
    const two = await login();
    assert.equal(two.out(), "logged in to openai as bob@example.com (2 credential(s) in pool)\n");
    const three = await login();
    assert.equal(three.out(), "updated openai as alice@example.com (2 credential(s) in pool)\n");

    const stored = rows(dbPath, "openai");
    assert.deepEqual(stored.map((r) => [r.type, r.label, r.disabledCause]), [
      ["oauth", "alice@example.com", null],
      ["oauth", "bob@example.com", null],
    ]);
    const db = openCredentialDb(dbPath, { create: false })!;
    try {
      assert.equal(JSON.parse(readCredentialById(db, stored[0]!.id)!.data).refresh, "rt-ALICE-2");
    } finally {
      db.close();
    }
    assert.deepEqual(opened, Array(3).fill("https://auth.example.com/authorize?a=1&b=2"));
    for (const text of outputs) {
      for (const secret of ["rt-ALICE-1", "rt-ALICE-2", "rt-BOB-1", alice.access, bob.access]) {
        assert.ok(!text.includes(secret), "no token in output");
      }
    }
  });

  it("an OAuth login leaves the provider's api_key rows enabled", async () => {
    const dbPath = tmpDb();
    await runLogin(["openai", "--api-key"], io(dbPath, "sk-keep\n").io);
    const c = io(dbPath, "", {
      createRuntime: fakeRuntime([{ type: "oauth", access: jwt({ email: "k@x.io" }), refresh: "r", expires: 1 }]),
    });
    assert.equal(await runLogin(["openai"], c.io), 0);
    const db = openCredentialDb(dbPath, { create: false })!;
    try {
      assert.deepEqual(listEnabled(db, "openai").map((r) => r.type), ["api_key", "oauth"]);
    } finally {
      db.close();
    }
  });

  it("names the provider and suggests --api-key when it has no OAuth login", async () => {
    const dbPath = tmpDb();
    const c = io(dbPath, "", {
      createRuntime: async () => ({
        login: async () => {
          throw new Error("login must not run");
        },
        getProvider: (() => ({ id: "groq", auth: {} })) as unknown as NonNullable<LoginRuntime["getProvider"]>,
      }),
    });
    assert.equal(await runLogin(["groq"], c.io), 1);
    assert.match(c.err(), /groq has no OAuth login; use `lykos login groq --api-key`/);
    assert.equal(openCredentialDb(dbPath, { create: false }), undefined);
  });

  it("redacts token-shaped text from a failed flow's error", async () => {
    const token = jwt({ email: "leak@example.com", pad: "x".repeat(40) });
    const c = io(tmpDb(), "", {
      createRuntime: async () => ({
        login: async () => {
          throw new Error(`token exchange failed: ${token} sk-${"A".repeat(40)}`);
        },
      }),
    });
    assert.equal(await runLogin(["openai"], c.io), 1);
    assert.match(c.err(), /openai OAuth login failed: token exchange failed: \[redacted\]/);
    assert.ok(!c.err().includes(token));
    assert.ok(!c.err().includes("A".repeat(40)));
    assert.equal(redactTokens("plain words stay"), "plain words stay");
  });
});

describe("lykos logout (D6.13)", () => {
  it("13. disables one by label, then all; prints labels and no secrets", async () => {
    const dbPath = tmpDb();
    await runLogin(["openai", "--api-key"], io(dbPath, "sk-secret-AAA\n").io);
    await runLogin(["openai", "--api-key"], io(dbPath, "sk-secret-BBB\n").io);
    await runLogin(["openai", "--api-key"], io(dbPath, "sk-secret-CCC\n").io);

    const one = io(dbPath);
    assert.equal(await runLogout(["openai", "key#1"], one.io), 0);
    assert.equal(one.out(), "logged out key#1\n");
    assert.deepEqual(rows(dbPath, "openai").map((r) => r.disabledCause), ["logout", null, null]);

    const unknown = io(dbPath);
    assert.equal(await runLogout(["openai", "key#9"], unknown.io), 1);
    assert.match(unknown.err(), /openai has no credential labelled "key#9"; its labels are key#2, key#3/);

    const all = io(dbPath);
    assert.equal(await runLogout(["openai"], all.io), 0);
    assert.equal(all.out(), "logged out key#2\nlogged out key#3\n");
    const after = rows(dbPath, "openai");
    assert.equal(after.length, 3, "logout never deletes a row");
    assert.ok(after.every((r) => r.disabledCause === "logout"));

    const text = [one, unknown, all].map((c) => c.out() + c.err()).join("");
    for (const secret of ["sk-secret-AAA", "sk-secret-BBB", "sk-secret-CCC"]) assert.ok(!text.includes(secret));
  });
});
