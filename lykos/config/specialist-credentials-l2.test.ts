// L2 (issue #93 item 1), sealed acceptance: a specialist may name a provider
// whose only credential is a login in the Lykos credential pool
// (`lykos login`, listed by `lykos usage`), e.g. `google-antigravity`.
//
// One predicate decides "is this provider usable": the config `providers:`
// table, the provider's env vars, and the credential pool (enabled rows only,
// read-only, never a secret). The startup check asks it, so the check cannot
// disagree with what the runtime's credential store would hand Pi.
//
// Every test points the credential store at a temp file (dbPath, or
// LYKOS_CREDENTIALS_DB in the env passed in) and HOME/USERPROFILE at a temp
// dir, so the real ~/.lykos is never read or written.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openCredentialDb } from "../credentials/db.js";
import { disableCredential, upsertCredential } from "../credentials/pool.js";
import * as specialistCredentials from "./specialist-credentials.js";
import { assertSpecialistProviderUsable } from "./specialist-credentials.js";
import { SpecialistValidationError } from "./specialists.js";
import type { ProvidersConfig } from "./types.js";

const SECRET_ACCESS = "l2-secret-access-token-do-not-print";
const SECRET_REFRESH = "l2-secret-refresh-token-do-not-print";
const SECRET_KEY = "l2-secret-api-key-do-not-print";

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
const savedDbEnv = process.env.LYKOS_CREDENTIALS_DB;
let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-l2-"));
  const home = join(root, "home");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_CREDENTIALS_DB = join(root, "never-used.db");
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  if (savedDbEnv === undefined) delete process.env.LYKOS_CREDENTIALS_DB;
  else process.env.LYKOS_CREDENTIALS_DB = savedDbEnv;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may still hold a WAL handle; the temp dir is harmless.
  }
});

let counter = 0;
function freshDbPath(): string {
  counter += 1;
  return join(root, `credentials-${counter}.db`);
}

/** A pool holding one enabled google-antigravity OAuth login, written through the real pool API. */
function poolWithAntigravity(): string {
  const dbPath = freshDbPath();
  const db = openCredentialDb(dbPath, { create: true })!;
  try {
    upsertCredential(db, "google-antigravity", {
      type: "oauth",
      access: SECRET_ACCESS,
      refresh: SECRET_REFRESH,
      expires: Date.now() + 3_600_000,
    } as never);
  } finally {
    db.close();
  }
  return dbPath;
}

function rowsOf(dbPath: string): Array<{ provider: string; data: string; disabled_cause: string | null }> {
  const db = openCredentialDb(dbPath, { create: false })!;
  try {
    return db
      .prepare("SELECT provider, data, disabled_cause FROM credentials ORDER BY id")
      .all() as Array<{ provider: string; data: string; disabled_cause: string | null }>;
  } finally {
    db.close();
  }
}

const deepseekOnly: ProvidersConfig = { deepseek: { auth: "api_key" } };

function errorOf(fn: () => void): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail("expected the check to throw");
}

describe("L2: a specialist may name a provider that has logins in the credential pool", () => {
  it("passes for a provider whose only credential is a pool login (dbPath)", () => {
    const dbPath = poolWithAntigravity();
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "google-antigravity",
        providers: deepseekOnly,
        env: {},
        dbPath,
      }),
    );
  });

  it("passes when the pool is found the way a session finds it (LYKOS_CREDENTIALS_DB in env, no dbPath)", () => {
    const dbPath = poolWithAntigravity();
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "google-antigravity",
        providers: deepseekOnly,
        env: { LYKOS_CREDENTIALS_DB: dbPath },
      }),
    );
  });

  it("passes with pre-resolved pool sizes naming the provider", () => {
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "google-antigravity",
        providers: deepseekOnly,
        env: {},
        poolSizes: new Map([["google-antigravity", 1]]),
      }),
    );
  });

  it("the pool lookup is read-only: rows unchanged, no secret in any message", () => {
    const dbPath = poolWithAntigravity();
    const before = rowsOf(dbPath);
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "google-antigravity",
        providers: deepseekOnly,
        env: {},
        dbPath,
      }),
    );
    const err = errorOf(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "nowhere-llm",
        providers: deepseekOnly,
        env: {},
        dbPath,
      }),
    );
    assert.deepEqual(rowsOf(dbPath), before);
    assert.ok(!err.message.includes(SECRET_ACCESS), err.message);
    assert.ok(!err.message.includes(SECRET_REFRESH), err.message);
  });

  it("a provider in none of the three still fails, and the message names the pool providers", () => {
    const dbPath = poolWithAntigravity();
    const err = errorOf(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "nowhere-llm",
        providers: deepseekOnly,
        env: {},
        dbPath,
      }),
    );
    assert.ok(err instanceof SpecialistValidationError, String(err));
    assert.match(err.message, /test-writer/);
    assert.match(err.message, /provider "nowhere-llm" is not configured/);
    assert.match(err.message, /configured providers: deepseek/);
    assert.match(err.message, /google-antigravity/, "the pool's providers are listed");
  });

  it("a pool provider whose only row is disabled is not usable", () => {
    const dbPath = poolWithAntigravity();
    const db = openCredentialDb(dbPath, { create: false })!;
    try {
      const id = (db.prepare("SELECT id FROM credentials LIMIT 1").get() as { id: number }).id;
      disableCredential(db, id, "invalidated_token");
    } finally {
      db.close();
    }
    const err = errorOf(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "google-antigravity",
        providers: deepseekOnly,
        env: {},
        dbPath,
      }),
    );
    assert.ok(err instanceof SpecialistValidationError, String(err));
    assert.match(err.message, /google-antigravity/);
  });

  it("one exported predicate, providerUsable, answers the same question the startup check asks", () => {
    const providerUsable = (specialistCredentials as Record<string, unknown>).providerUsable as
      | ((input: {
          provider: string;
          providers: ProvidersConfig;
          env: NodeJS.ProcessEnv;
          dbPath?: string;
          poolSizes?: Map<string, number>;
        }) => { usable: boolean; reason: string })
      | undefined;
    assert.equal(typeof providerUsable, "function", "specialist-credentials.ts exports providerUsable");
    const dbPath = poolWithAntigravity();
    const pooled = providerUsable!({ provider: "google-antigravity", providers: deepseekOnly, env: {}, dbPath });
    assert.equal(pooled.usable, true);
    const none = providerUsable!({ provider: "nowhere-llm", providers: deepseekOnly, env: {}, dbPath });
    assert.equal(none.usable, false);
    assert.equal(typeof none.reason, "string");
    assert.ok(none.reason.length > 0);
    const env = providerUsable!({
      provider: "deepseek",
      providers: deepseekOnly,
      env: { DEEPSEEK_API_KEY: SECRET_KEY },
      dbPath: freshDbPath(),
    });
    assert.equal(env.usable, true);
    assert.ok(!env.reason.includes(SECRET_KEY));
  });
});

describe("L2: config and env providers behave as before", () => {
  it("a configured provider with its env var set passes", () => {
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "coder",
        specialistProvider: "deepseek",
        providers: deepseekOnly,
        env: { DEEPSEEK_API_KEY: SECRET_KEY },
        dbPath: freshDbPath(),
      }),
    );
  });

  it("a known builtin absent from the table passes on its env var alone", () => {
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "coder",
        specialistProvider: "anthropic",
        providers: deepseekOnly,
        env: { ANTHROPIC_API_KEY: SECRET_KEY },
        dbPath: freshDbPath(),
      }),
    );
  });

  it("a configured api_key provider with no env var and an empty pool fails as before", () => {
    const err = errorOf(() =>
      assertSpecialistProviderUsable({
        specialistName: "coder",
        specialistProvider: "deepseek",
        providers: deepseekOnly,
        env: {},
        dbPath: freshDbPath(),
      }),
    );
    assert.ok(err instanceof SpecialistValidationError, String(err));
    assert.match(err.message, /provider "deepseek" has no usable credential/);
    assert.match(err.message, /DEEPSEEK_API_KEY/);
  });

  it("an unconfigured unknown provider with no pool fails as before, and no store file is created", () => {
    const dbPath = freshDbPath();
    const err = errorOf(() =>
      assertSpecialistProviderUsable({
        specialistName: "coder",
        specialistProvider: "unconfigured-llm",
        providers: { anthropic: { auth: "api_key" }, deepseek: { auth: "api_key" } },
        env: {},
        dbPath,
      }),
    );
    assert.ok(err instanceof SpecialistValidationError, String(err));
    assert.match(err.message, /provider "unconfigured-llm" is not configured — configured providers: anthropic, deepseek/);
    assert.equal(existsSync(dbPath), false, "a read never creates the store");
  });

  it("a configured oauth_subscription provider with a pool login passes (the documented workaround still works)", () => {
    const dbPath = poolWithAntigravity();
    assert.doesNotThrow(() =>
      assertSpecialistProviderUsable({
        specialistName: "test-writer",
        specialistProvider: "google-antigravity",
        providers: { ...deepseekOnly, "google-antigravity": { auth: "oauth_subscription" } },
        env: {},
        dbPath,
      }),
    );
  });
});
