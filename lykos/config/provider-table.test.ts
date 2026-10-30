import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_PROVIDERS,
  PI_NATIVE_PROVIDERS,
} from "./provider-table.js";
import {
  builtinProviderDecls,
  generateProviderConfig,
  KNOWN_STREAMABLE_APIS,
} from "./providers.js";
import type { ProviderDecl } from "./types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function tmp(): string {
  const base = join(repoRoot, ".lykos", "cache", "tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "provider-table-"));
}

describe("built-in provider table", () => {
  it("2. Every emitted base URL starts with https://, except local providers whose host is loopback", () => {
    const isLoopback = (u: string) => {
      try {
        const parsed = new URL(u);
        return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
      } catch {
        return false;
      }
    };

    for (const [providerId, provider] of Object.entries(BUILTIN_PROVIDERS)) {
      if (provider.local) {
        assert.ok(
          isLoopback(provider.baseUrl),
          `provider ${providerId} baseUrl should be loopback (got ${provider.baseUrl})`
        );
      } else {
        assert.ok(
          provider.baseUrl.startsWith("https://"),
          `provider ${providerId} baseUrl should start with https:// (got ${provider.baseUrl})`
        );
      }

      for (const m of provider.models) {
        if (m.baseUrl !== undefined) {
          if (provider.local) {
            assert.ok(
              isLoopback(m.baseUrl),
              `model ${providerId}/${m.id} baseUrl should be loopback (got ${m.baseUrl})`
            );
          } else {
            assert.ok(
              m.baseUrl.startsWith("https://"),
              `model ${providerId}/${m.id} baseUrl should start with https:// (got ${m.baseUrl})`
            );
          }
        }
      }
    }
  });

  it("3. No emitted base URL contains {, }, <, or >", () => {
    const templateChars = ["{", "}", "<", ">"];
    for (const [providerId, provider] of Object.entries(BUILTIN_PROVIDERS)) {
      for (const ch of templateChars) {
        assert.ok(
          !provider.baseUrl.includes(ch),
          `provider ${providerId} baseUrl contains template char "${ch}"`
        );
      }
      for (const m of provider.models) {
        if (m.baseUrl !== undefined) {
          for (const ch of templateChars) {
            assert.ok(
              !m.baseUrl.includes(ch),
              `model ${providerId}/${m.id} baseUrl contains template char "${ch}"`
            );
          }
        }
      }
    }
  });

  it("4. google-antigravity and google-gemini-cli exist", () => {
    assert.ok(BUILTIN_PROVIDERS["google-antigravity"], "google-antigravity must exist in BUILTIN_PROVIDERS");
    assert.ok(BUILTIN_PROVIDERS["google-gemini-cli"], "google-gemini-cli must exist in BUILTIN_PROVIDERS");

  });

  it("5. No emitted object has a cost key", () => {
    for (const [pId, p] of Object.entries(BUILTIN_PROVIDERS)) {
      assert.equal("cost" in p, false, `provider ${pId} must not have cost key`);
      for (const m of p.models) {
        assert.equal("cost" in m, false, `model ${pId}/${m.id} must not have cost key`);
      }
    }
  });

  it("6. builtinProviderDecls contains none of PI_NATIVE_PROVIDERS, only known APIs, and contains abliteration", () => {
    const builtins = builtinProviderDecls();
    const nativeSet = new Set(PI_NATIVE_PROVIDERS);

    for (const pId of Object.keys(builtins)) {
      assert.equal(
        nativeSet.has(pId),
        false,
        `builtinProviderDecls should not include pi native provider ${pId}`
      );
      const decl = builtins[pId]!;
      assert.ok(
        KNOWN_STREAMABLE_APIS.has(decl.api!),
        `provider api "${decl.api}" for ${pId} should be in known streamable APIs`
      );
      for (const m of decl.models ?? []) {
        if (m.api !== undefined) {
          assert.ok(
            KNOWN_STREAMABLE_APIS.has(m.api),
            `model api "${m.api}" for ${pId}/${m.id} should be in known streamable APIs`
          );
        }
      }
    }

    // Verify abliteration as a representative provider Pi lacks today
    assert.ok(builtins.abliteration, "expected abliteration in builtinProviderDecls");
    assert.equal(builtins.abliteration.api, "openai-responses");
    assert.equal(builtins.abliteration.auth, "api_key");
    assert.equal(builtins.abliteration.source, "$ABLITERATION_API_KEY");
  });

  it("7. generateProviderConfig merges user decls over built-in decls (user replaces whole)", () => {
    const dir = tmp();
    const targetPath = join(dir, "models.json");

    const userDecl: ProviderDecl = {
      auth: "api_key",
      source: "$USER_KEY",
    };
    const builtinDecl: ProviderDecl = {
      auth: "api_key",
      source: "$BUILTIN_KEY",
      baseUrl: "https://builtin.example.com/v1",
      api: "openai-completions",
      models: [{ id: "builtin-model" }],
    };
    const yDecl: ProviderDecl = {
      auth: "api_key",
      source: "$Y_KEY",
      baseUrl: "https://y.example.com/v1",
      api: "openai-completions",
      models: [{ id: "y-model" }],
    };

    const result = generateProviderConfig({
      providers: { x: userDecl },
      builtins: { x: builtinDecl, y: yDecl },
      targetPath,
    });

    assert.equal(result.written, true);
    const written = JSON.parse(readFileSync(targetPath, "utf8")) as {
      providers: Record<
        string,
        { apiKey?: string; baseUrl?: string; api?: string; models?: Array<{ id: string }> }
      >;
    };

    // x comes from user decl only — built-in fields such as baseUrl/api/models are absent
    assert.equal(written.providers.x?.apiKey, "$USER_KEY");
    assert.equal(written.providers.x?.baseUrl, undefined);
    assert.equal(written.providers.x?.api, undefined);
    assert.equal(written.providers.x?.models, undefined);

    // y comes from builtin
    assert.equal(written.providers.y?.apiKey, "$Y_KEY");
    assert.equal(written.providers.y?.baseUrl, "https://y.example.com/v1");
    assert.equal(written.providers.y?.api, "openai-completions");
    assert.equal(written.providers.y?.models?.[0]?.id, "y-model");
  });

  it("8. ModelRuntime built from models.json with builtinProviderDecls resolves a model", async () => {
    const dir = tmp();
    const targetPath = join(dir, "models.json");

    const builtins = builtinProviderDecls();
    const result = generateProviderConfig({
      providers: {},
      builtins,
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

    const model = runtime.getModel("abliteration", "abliterated-model");
    assert.ok(model, "expected ModelRuntime.getModel to find abliteration/abliterated-model");
    assert.equal(model.id, "abliterated-model");
    assert.equal(model.provider, "abliteration");
    assert.equal(model.baseUrl, "https://api.abliteration.ai/v1");
  });

});
