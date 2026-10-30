import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  generateProviderConfig,
  isCredentialSource,
  specialistModelSpec,
  providerMatrix,
  resolveBootModel,
  resolveCallAccounting,
  resolveReach,
  validateProviders,
  validateDelegateModel,
} from "./providers.js";
import type { ProvidersConfig } from "./types.js";
import { redactSecrets } from "../ledger/redact.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-providers-"));
}

describe("isCredentialSource", () => {
  it("accepts $ENV_VAR, ${ENV_VAR}, and !command", () => {
    assert.equal(isCredentialSource("$DEEPSEEK_API_KEY"), true);
    assert.equal(isCredentialSource("${DEEPSEEK_API_KEY}"), true);
    assert.equal(isCredentialSource("!op read op://vault/item/credential"), true);
  });

  it("rejects a literal key and a bare name", () => {
    assert.equal(isCredentialSource("sk-ant-api03-abcdefghijklmnopqrstuv"), false);
    assert.equal(isCredentialSource("DEEPSEEK_API_KEY"), false);
    assert.equal(isCredentialSource(""), false);
  });
});

describe("validateProviders", () => {
  it("accepts the shipped deepseek declaration", () => {
    const { errors, warnings } = validateProviders({ deepseek: { auth: "api_key", priced: true } });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it("rejects a literal credential as source", () => {
    const { errors } = validateProviders({
      anthropic: { auth: "api_key", source: "sk-ant-api03-abcdefghijklmnopqrstuv" },
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /never a literal credential/);
    assert.equal(errors[0]!.includes("sk-ant-"), false);
  });

  it("accepts oauth_subscription for any provider without warnings", () => {
    const { errors, warnings } = validateProviders({
      anthropic: { auth: "oauth_subscription", priced: true },
      openrouter: { auth: "oauth_subscription", priced: false },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it("rejects a custom provider missing api/baseUrl", () => {
    const { errors } = validateProviders({
      ollama: { auth: "api_key", priced: false, models: [{ id: "llama3" }] },
    });
    assert.ok(errors.some((e) => /need api/.test(e)));
    assert.ok(errors.some((e) => /need baseUrl/.test(e)));
  });

  it("accepts fallbackToApiKey as a boolean and rejects any other value (ticket 05, ADR-0026)", () => {
    assert.deepEqual(validateProviders({ anthropic: { auth: "oauth_subscription", fallbackToApiKey: true } }).errors, []);
    assert.deepEqual(validateProviders({ anthropic: { auth: "oauth_subscription", fallbackToApiKey: false } }).errors, []);
    const { errors } = validateProviders({
      anthropic: { auth: "oauth_subscription", fallbackToApiKey: "yes" },
    } as unknown as ProvidersConfig);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /fallbackToApiKey must be true or false/);
  });
});

describe("generateProviderConfig (T35.2)", () => {
  it("does not write when every provider is built-in-only (auth + priced)", () => {
    const dir = tmp();
    const targetPath = join(dir, "models.json");
    const result = generateProviderConfig({
      providers: { deepseek: { auth: "api_key", priced: true } },
      targetPath,
    });
    assert.equal(result.written, false);
    assert.equal(result.errors.length, 0);
    assert.throws(() => readFileSync(targetPath));
  });

  it("writes models.json with $ENV sources and custom providers, never a literal key", () => {
    const dir = tmp();
    const targetPath = join(dir, ".lykos", "cache", "models.json");
    const result = generateProviderConfig({
      providers: {
        deepseek: { auth: "api_key", priced: true, source: "$DEEPSEEK_API_KEY" },
        "local-proxy": {
          auth: "gateway",
          priced: false,
          source: "$PROXY_KEY",
          baseUrl: "http://127.0.0.1:8080/v1",
          api: "openai-completions",
          models: [{ id: "proxy-model" }],
        },
      },
      targetPath,
    });
    assert.equal(result.written, true);
    assert.deepEqual(result.providers.sort(), ["deepseek", "local-proxy"]);
    const written = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(written) as {
      providers: Record<string, { apiKey?: string; baseUrl?: string; models?: Array<{ id: string }> }>;
    };
    assert.equal(parsed.providers.deepseek?.apiKey, "$DEEPSEEK_API_KEY");
    assert.equal(parsed.providers["local-proxy"]?.apiKey, "$PROXY_KEY");
    assert.equal(parsed.providers["local-proxy"]?.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(parsed.providers["local-proxy"]?.models?.[0]?.id, "proxy-model");
    assert.equal(written.includes("sk-"), false);
  });

  it("leaves a sibling auth.json byte-identical — Lykos never opens it", () => {
    const dir = tmp();
    const authPath = join(dir, "auth.json");
    const planted = JSON.stringify({
      deepseek: { type: "api_key", key: "sk-ant-api03-abcdefghijklmnopqrstuvPLANTED" },
    });
    writeFileSync(authPath, planted, "utf8");
    const before = createHash("sha256").update(readFileSync(authPath)).digest("hex");

    generateProviderConfig({
      providers: { deepseek: { auth: "api_key", priced: true, source: "$DEEPSEEK_API_KEY" } },
      targetPath: join(dir, "models.json"),
    });

    const after = createHash("sha256").update(readFileSync(authPath)).digest("hex");
    assert.equal(after, before);
    assert.equal(readFileSync(authPath, "utf8"), planted);
  });

  it("refuses to generate when a source is a literal key, and does not write the file", () => {
    const dir = tmp();
    const targetPath = join(dir, "models.json");
    const result = generateProviderConfig({
      providers: { anthropic: { auth: "api_key", source: "sk-ant-api03-abcdefghijklmnopqrstuv" } },
      targetPath,
    });
    assert.equal(result.written, false);
    assert.ok(result.errors.length > 0);
    assert.throws(() => readFileSync(targetPath));
  });

  it("a provider declared only in Lykos config is in the SDK registry with no manual Pi configuration", async () => {
    const dir = tmp();
    const targetPath = join(dir, "models.json");
    const result = generateProviderConfig({
      providers: {
        "lykos-t35": {
          auth: "gateway",
          priced: false,
          source: "$LYKOS_T35_KEY",
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          models: [{ id: "t35-model" }],
        },
      },
      targetPath,
    });
    assert.equal(result.written, true);

    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    // authPath beside the tmp models.json: without it Pi opens the real ~/.pi/agent/auth.json.
    const runtime = await ModelRuntime.create({
      modelsPath: targetPath,
      authPath: join(dirname(targetPath), "auth.json"),
      allowModelNetwork: false,
    });
    const model = runtime.getModel("lykos-t35", "t35-model");
    assert.ok(model, "expected ModelRuntime.getModel to find the generated custom provider");
    assert.equal(model.id, "t35-model");
    assert.equal(model.provider, "lykos-t35");
  });

  it("preserves per-model baseUrl and api into generated models.json", () => {
    const dir = tmp();
    const targetPath = join(dir, "models.json");
    const result = generateProviderConfig({
      providers: {
        "multi-host": {
          auth: "gateway",
          baseUrl: "https://default.example.com",
          api: "openai-completions",
          models: [
            { id: "default-model" },
            { id: "special-model", baseUrl: "https://special.example.com", api: "openai-responses" },
          ],
        },
      },
      targetPath,
    });
    assert.equal(result.written, true);
    const written = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(written) as {
      providers: Record<
        string,
        {
          baseUrl?: string;
          api?: string;
          models?: Array<{ id: string; baseUrl?: string; api?: string }>;
        }
      >;
    };
    const prov = parsed.providers["multi-host"]!;
    assert.equal(prov.baseUrl, "https://default.example.com");
    assert.equal(prov.api, "openai-completions");
    assert.equal(prov.models?.[0]?.id, "default-model");
    assert.equal(prov.models?.[0]?.baseUrl, undefined);
    assert.equal(prov.models?.[0]?.api, undefined);
    assert.equal(prov.models?.[1]?.id, "special-model");
    assert.equal(prov.models?.[1]?.baseUrl, "https://special.example.com");
    assert.equal(prov.models?.[1]?.api, "openai-responses");
  });
});

describe("resolveBootModel (T35.3)", () => {
  it("caller override wins and is recorded as caller_override", () => {
    const r = resolveBootModel({
      callerModel: "anthropic/claude-sonnet-5",
      defaultModel: "deepseek-v4-flash",
      roleModel: "deepseek-v4-flash",
    });
    assert.deepEqual(r, { spec: "anthropic/claude-sonnet-5", source: "caller_override" });
  });

  it("specialist wins over config default when no caller override", () => {
    const r = resolveBootModel({
      specialistModel: "deepseek-v4-pro",
      defaultModel: "deepseek-v4-flash",
    });
    assert.deepEqual(r, { spec: "deepseek-v4-pro", source: "specialist" });
  });

  it("falls through to the role model as config_default", () => {
    const r = resolveBootModel({
      defaultModel: "deepseek-v4-flash",
      roleModel: "deepseek-v4-pro",
    });
    assert.deepEqual(r, { spec: "deepseek-v4-pro", source: "config_default" });
  });

  it("specialistModel resolved from provider+model wins over the role model", () => {
    const specialistModel = specialistModelSpec({ provider: "anthropic", model: "claude-sonnet-5" });
    const r = resolveBootModel({
      ...(specialistModel !== undefined ? { specialistModel } : {}),
      defaultModel: "deepseek-v4-flash",
      roleModel: "deepseek-v4-pro",
    });
    assert.deepEqual(r, { spec: "anthropic/claude-sonnet-5", source: "specialist" });
  });
});

describe("specialistModelSpec (specialists ticket 02)", () => {
  it("combines provider and model into a provider/model spec", () => {
    assert.equal(specialistModelSpec({ provider: "anthropic", model: "claude-sonnet-5" }), "anthropic/claude-sonnet-5");
  });

  it("mirrors Pi's own preset extension: model alone produces no override", () => {
    assert.equal(specialistModelSpec({ model: "claude-sonnet-5" }), undefined);
  });

  it("provider alone produces no override", () => {
    assert.equal(specialistModelSpec({ provider: "anthropic" }), undefined);
  });

  it("neither set produces no override", () => {
    assert.equal(specialistModelSpec({}), undefined);
  });
});

describe("resolveCallAccounting (T36.1 / T36.2)", () => {
  const shipped: ProvidersConfig = { deepseek: { auth: "api_key", priced: true } };

  it("declared, priced, verified DeepSeek is api_key / api_list", () => {
    assert.deepEqual(resolveCallAccounting("deepseek", "deepseek-v4-flash", shipped), {
      authMode: "api_key",
      priceBasis: "api_list",
    });
  });

  it("undeclared provider is unknown / unpriced, not a guessed api_key", () => {
    assert.deepEqual(resolveCallAccounting("some-gateway", "whatever", shipped), {
      authMode: "unknown",
      priceBasis: "unpriced",
    });
  });

  it("declared priced: false records unpriced even for a verified model", () => {
    assert.deepEqual(
      resolveCallAccounting("deepseek", "deepseek-v4-flash", {
        deepseek: { auth: "api_key", priced: false },
      }),
      { authMode: "api_key", priceBasis: "unpriced" },
    );
  });

  it("omitted priced is unpriced even when prices.yaml verifies the model", () => {
    assert.deepEqual(
      resolveCallAccounting("deepseek", "deepseek-v4-flash", {
        deepseek: { auth: "api_key" },
      }),
      { authMode: "api_key", priceBasis: "unpriced" },
    );
  });

  it("OpenRouter is reachable-but-unpriced: prices.yaml has an empty models map", () => {
    assert.deepEqual(
      resolveCallAccounting("openrouter", "any-model", {
        openrouter: { auth: "api_key", priced: true },
      }),
      { authMode: "api_key", priceBasis: "unpriced" },
    );
  });

  it("anthropic oauth_subscription records api_list when priced, never plan_credit", () => {
    // Route is honored; no verified subscription credit pool exists yet.
    const r = resolveCallAccounting("anthropic", "claude-sonnet-5", {
      anthropic: { auth: "oauth_subscription", priced: true },
    });
    assert.equal(r.authMode, "oauth_subscription");
    assert.equal(r.priceBasis, "api_list");
    assert.notEqual(r.priceBasis, "plan_credit");
  });
});

describe("providerMatrix (T36.4)", () => {
  it("reports reachable vs priced as separate columns; never a token fragment", () => {
    const planted = "sk-ant-api03-abcdefghijklmnopqrstuvPLANTED";
    const rows = providerMatrix(
      {
        deepseek: { auth: "api_key", priced: true },
        openrouter: { auth: "api_key", priced: false },
        anthropic: { auth: "oauth_subscription", priced: true },
      },
      {
        env: { DEEPSEEK_API_KEY: planted, OPENROUTER_API_KEY: planted },
        poolSizes: new Map([["anthropic", 1]]),
      },
    );

    const deepseek = rows.find((r) => r.name === "deepseek")!;
    assert.equal(deepseek.reach, "reachable");
    assert.equal(deepseek.priced, true);
    assert.match(deepseek.reachReason, /DEEPSEEK_API_KEY present/);
    assert.equal(deepseek.reachReason.includes(planted), false);
    assert.equal(JSON.stringify(deepseek).includes(planted), false);

    const openrouter = rows.find((r) => r.name === "openrouter")!;
    assert.equal(openrouter.reach, "reachable");
    assert.equal(openrouter.priced, false);
    assert.match(openrouter.priceNote, /UNPRICED/);

    const anthropic = rows.find((r) => r.name === "anthropic")!;
    assert.equal(anthropic.auth, "oauth_subscription");
    assert.equal(anthropic.reach, "unknown");
    assert.match(anthropic.reachReason, /1 credential\(s\) in the Lykos store/);
    assert.equal(redactSecrets(planted).includes("sk-ant-"), false);
  });

  it("a missing env var is UNREACHABLE, not a silent ok", () => {
    const rows = providerMatrix(
      { deepseek: { auth: "api_key", priced: true } },
      { env: {} },
    );
    assert.equal(rows[0]!.reach, "unreachable");
    assert.match(rows[0]!.reachReason, /not set/);
  });

  it("declared source: $OTHER is the env var that is checked, not the built-in map", () => {
    const rows = providerMatrix(
      { deepseek: { auth: "api_key", priced: true, source: "$MY_KEY" } },
      { env: { MY_KEY: "1", DEEPSEEK_API_KEY: "" } },
    );
    assert.equal(rows[0]!.reach, "reachable");
    assert.match(rows[0]!.reachReason, /MY_KEY present/);
  });
});

describe("resolveReach (D1 / D7.3)", () => {
  it("OAuth with pool 0 is unreachable with login guidance", () => {
    const res = resolveReach("anthropic", { auth: "oauth_subscription" }, {}, 0);
    assert.equal(res.reach, "unreachable");
    assert.equal(res.reachReason, "no credential in the Lykos store — run `lykos login anthropic`");
  });

  it("OAuth with pool > 0 is unknown with store count", () => {
    const res = resolveReach("anthropic", { auth: "oauth_subscription" }, {}, 2);
    assert.equal(res.reach, "unknown");
    assert.equal(res.reachReason, "2 credential(s) in the Lykos store (contents not inspected)");
  });

  it("API key with pool > 0 and no env is reachable", () => {
    const res = resolveReach("anthropic", { auth: "api_key" }, {}, 1);
    assert.equal(res.reach, "reachable");
    assert.equal(res.reachReason, "1 credential(s) in the Lykos store");
  });

  it("API key with pool 0 falls back to env presence", () => {
    const unreachable = resolveReach("anthropic", { auth: "api_key" }, {}, 0);
    assert.equal(unreachable.reach, "unreachable");
    assert.match(unreachable.reachReason, /ANTHROPIC_API_KEY not set/);

    const reachable = resolveReach("anthropic", { auth: "api_key" }, { ANTHROPIC_API_KEY: "fake" }, 0);
    assert.equal(reachable.reach, "reachable");
    assert.match(reachable.reachReason, /ANTHROPIC_API_KEY present/);
  });
});

describe("validateDelegateModel", () => {
  const providers: ProvidersConfig = {
    deepseek: { auth: "api_key", priced: true },
  };

  it("accepts specialist and parent settings", () => {
    assert.doesNotThrow(() => validateDelegateModel("specialist"));
    assert.doesNotThrow(() => validateDelegateModel("parent"));
  });

  it("accepts valid model spec with known or configured provider", () => {
    assert.doesNotThrow(() => validateDelegateModel("deepseek-v4-flash"));
    assert.doesNotThrow(() => validateDelegateModel("deepseek/deepseek-v4-flash", providers));
    assert.doesNotThrow(() => validateDelegateModel("anthropic/claude-sonnet-4-5", providers));
  });

  it("rejects null, undefined, empty string, and non-string", () => {
    assert.throws(() => validateDelegateModel(undefined), /models\.delegate/);
    assert.throws(() => validateDelegateModel(null), /models\.delegate/);
    assert.throws(() => validateDelegateModel(""), /models\.delegate/);
    assert.throws(() => validateDelegateModel(123), /models\.delegate/);
  });

  it("rejects unknown provider when providers is specified", () => {
    assert.throws(
      () => validateDelegateModel("unknown-prov/some-model", providers),
      /provider "unknown-prov" is not configured/,
    );
  });

  it("rejects malformed model spec with empty provider or model", () => {
    assert.throws(() => validateDelegateModel("/model"), /not a valid model spec/);
    assert.throws(() => validateDelegateModel("provider/"), /not a valid model spec/);
  });
});

