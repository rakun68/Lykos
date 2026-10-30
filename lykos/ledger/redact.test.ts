import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets, redactValue } from "./redact.js";

describe("redactSecrets", () => {
  it("strips Anthropic, GitHub, and AWS key shapes", () => {
    const raw =
      "anthropic=sk-ant-api03-abcdefghijklmnopqrstuv " +
      "github=ghp_abcdefghijklmnopqrstuvwxyz0123456789 " +
      "aws=AKIAIOSFODNN7EXAMPLE";
    const out = redactSecrets(raw);
    assert.equal(out.includes("sk-ant-"), false);
    assert.equal(out.includes("ghp_"), false);
    assert.equal(out.includes("AKIA"), false);
    assert.equal((out.match(/\[REDACTED\]/g) ?? []).length, 3);
  });

  it("strips key=value assignments and bearer tokens", () => {
    const out = redactSecrets('Authorization: Bearer abcdef.secret-token\napi_key: s3cretvalue');
    assert.equal(out.includes("s3cretvalue"), false);
    assert.equal(out.includes("abcdef.secret-token"), false);
  });

  it("leaves ordinary task text alone", () => {
    const brief = "implement recordCall() in lykos/ledger/ledger.ts";
    assert.equal(redactSecrets(brief), brief);
  });

  it("walks nested objects", () => {
    const out = redactValue({ brief: "token=supersecret", n: 3 }) as { brief: string; n: number };
    assert.equal(out.n, 3);
    assert.equal(out.brief.includes("supersecret"), false);
  });

  it("T36.4: a planted API token never survives redactSecrets, including doctor-shaped labels", () => {
    const planted = "sk-ant-api03-abcdefghijklmnopqrstuvPLANTED";
    const label = `provider anthropic: reachable (api_key, ANTHROPIC_API_KEY=${planted}), priced`;
    const out = redactSecrets(label);
    assert.equal(out.includes(planted), false);
    assert.equal(out.includes("sk-ant-"), false);
    assert.match(out, /\[REDACTED\]/);
  });
});
