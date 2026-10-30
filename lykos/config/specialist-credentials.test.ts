import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertHostProviderUsable, assertSpecialistProviderUsable } from "./specialist-credentials.js";
import {
  projectSpecialistsDir,
  resolveSpecialistLayer,
  SPECIALIST_FIELD_NAMES,
  SpecialistValidationError,
} from "./specialists.js";
import type { ProvidersConfig } from "./types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-spec-cred-"));
}

function writeSpecialist(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), content, "utf8");
}

describe("assertSpecialistProviderUsable (D1 / Ticket 06)", () => {
  const sampleProviders: ProvidersConfig = {
    anthropic: { auth: "api_key" },
    deepseek: { auth: "api_key" },
  };

  it("no specialist -> no throw", () => {
    assert.doesNotThrow(() => {
      assertSpecialistProviderUsable({
        providers: sampleProviders,
        env: {},
      });
    });
  });

  it("specialist with no provider -> no throw", () => {
    assert.doesNotThrow(() => {
      assertSpecialistProviderUsable({
        specialistName: "generalist",
        providers: sampleProviders,
        env: {},
      });
    });
  });

  it("specialist naming an unconfigured provider throws", () => {
    assert.throws(
      () => {
        assertSpecialistProviderUsable({
          specialistName: "code-specialist",
          specialistProvider: "unconfigured-llm",
          providers: sampleProviders,
          env: {},
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        const msg = (err as Error).message;
        assert.match(msg, /code-specialist/);
        assert.match(msg, /unconfigured-llm/);
        assert.match(msg, /anthropic/);
        assert.match(msg, /deepseek/);
        return true;
      },
    );
  });

  it("specialist naming configured provider with unset env var throws", () => {
    assert.throws(
      () => {
        assertSpecialistProviderUsable({
          specialistName: "claude-expert",
          specialistProvider: "anthropic",
          providers: sampleProviders,
          env: {},
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        const msg = (err as Error).message;
        assert.match(msg, /claude-expert/);
        assert.match(msg, /anthropic/);
        assert.match(msg, /ANTHROPIC_API_KEY/);
        return true;
      },
    );
  });

  it("specialist naming configured provider with set env var passes", () => {
    assert.doesNotThrow(() => {
      assertSpecialistProviderUsable({
        specialistName: "claude-expert",
        specialistProvider: "anthropic",
        providers: sampleProviders,
        env: { ANTHROPIC_API_KEY: "fake-key" },
      });
    });
  });

  it("specialist naming custom source provider with unset env var throws", () => {
    const custom: ProvidersConfig = {
      custom_gw: { auth: "api_key", source: "$MY_TOKEN" },
    };
    assert.throws(
      () => {
        assertSpecialistProviderUsable({
          specialistName: "gateway-agent",
          specialistProvider: "custom_gw",
          providers: custom,
          env: {},
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /MY_TOKEN/);
        return true;
      },
    );
  });

  it("specialist naming oauth provider with pooled credential passes", () => {
    assert.doesNotThrow(() => {
      assertSpecialistProviderUsable({
        specialistName: "copilot-agent",
        specialistProvider: "github-copilot",
        providers: { "github-copilot": { auth: "oauth_subscription" } },
        env: {},
        poolSizes: new Map([["github-copilot", 1]]),
      });
    });
  });

  it("specialist naming oauth provider with empty pool throws", () => {
    assert.throws(
      () => {
        assertSpecialistProviderUsable({
          specialistName: "copilot-agent",
          specialistProvider: "github-copilot",
          providers: { "github-copilot": { auth: "oauth_subscription" } },
          env: {},
          poolSizes: new Map([["github-copilot", 0]]),
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /no credential in the Lykos store/);
        return true;
      },
    );
  });

  it("unconfigured built-in provider with pooled credential passes", () => {
    assert.doesNotThrow(() => {
      assertSpecialistProviderUsable({
        specialistName: "claude-agent",
        specialistProvider: "anthropic",
        providers: {},
        env: {},
        poolSizes: new Map([["anthropic", 1]]),
      });
    });
  });

  it("unconfigured built-in provider with no credential anywhere throws, naming the variable", () => {
    assert.throws(
      () => {
        assertSpecialistProviderUsable({
          specialistName: "claude-agent",
          specialistProvider: "anthropic",
          providers: {},
          env: {},
          poolSizes: new Map([["anthropic", 0]]),
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /ANTHROPIC_API_KEY/);
        assert.match((err as Error).message, /claude-agent/);
        return true;
      },
    );
  });

  it("a provider Lykos cannot probe is not failed at session start", () => {
    // github-copilot has no entry in PROVIDER_ENV_VARS, so there is no variable
    // whose absence proves anything. Failing here would block a working setup on
    // the strength of a check that did not run; the first call reports the truth.
    assert.doesNotThrow(() => {
      assertSpecialistProviderUsable({
        specialistName: "copilot-agent",
        specialistProvider: "github-copilot",
        providers: {},
        env: {},
        poolSizes: new Map([["github-copilot", 0]]),
      });
    });
  });
});

describe("assertHostProviderUsable (D4)", () => {
  it("known provider with empty pool and no env var fails with D4 message", () => {
    assert.throws(
      () => {
        assertHostProviderUsable({
          provider: "anthropic",
          providers: { anthropic: { auth: "api_key" } },
          env: {},
          poolSizes: new Map([["anthropic", 0]]),
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          'lykos: provider "anthropic" has no usable credential (ANTHROPIC_API_KEY not set) — run `lykos login anthropic`',
        );
        return true;
      },
    );
  });

  it("known provider with pooled credential passes", () => {
    assert.doesNotThrow(() => {
      assertHostProviderUsable({
        provider: "anthropic",
        providers: { anthropic: { auth: "api_key" } },
        env: {},
        poolSizes: new Map([["anthropic", 1]]),
      });
    });
  });

  it("known provider with env var set passes", () => {
    assert.doesNotThrow(() => {
      assertHostProviderUsable({
        provider: "anthropic",
        providers: { anthropic: { auth: "api_key" } },
        env: { ANTHROPIC_API_KEY: "sk-fake" },
        poolSizes: new Map([["anthropic", 0]]),
      });
    });
  });

  it("unknown provider does not throw here (deferred to resolveHostModel)", () => {
    assert.doesNotThrow(() => {
      assertHostProviderUsable({
        provider: "nonexistent",
        providers: {},
        env: {},
      });
    });
  });
});

describe("specialist vocabulary contains no credential fields (D5)", () => {
  it("provider is the only credential-adjacent field in the closed vocabulary", () => {
    const forbidden = ["source", "apiKey", "api_key", "token", "credential", "secret"];
    for (const field of forbidden) {
      assert.equal((SPECIALIST_FIELD_NAMES as readonly string[]).includes(field), false);
    }
    assert.ok((SPECIALIST_FIELD_NAMES as readonly string[]).includes("provider"));
  });

  it("rejects a specialist declaring secret fields via closed vocabulary check", () => {
    const cwd = tmp();
    const globalDir = tmp();
    for (const key of ["source: $KEY", "apiKey: secret", "api_key: secret", "token: tok", "credential: cred"]) {
      writeSpecialist(projectSpecialistsDir(cwd), "secret-agent", `${key}\n`);
      assert.throws(
        () => resolveSpecialistLayer("secret-agent", cwd, globalDir),
        SpecialistValidationError,
      );
    }
  });
});
