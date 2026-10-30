import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PI_DEFAULT_RETRY,
  describeRetryPolicy,
  endedOnExhaustedRetry,
  newRetryObservation,
  observeRetryEvent,
  readRetryPolicy,
} from "./retry-observer.js";

describe("readRetryPolicy", () => {
  it("reports Pi's real defaults when the settings manager is absent", () => {
    assert.deepEqual(readRetryPolicy(undefined), { ...PI_DEFAULT_RETRY, source: "pi_default" });
  });

  it("reads what the settings manager actually says", () => {
    const view = readRetryPolicy({ getRetrySettings: () => ({ enabled: true, maxRetries: 5, baseDelayMs: 500 }) });
    assert.deepEqual(view, { enabled: true, maxRetries: 5, baseDelayMs: 500, source: "pi_settings" });
  });

  it("treats an explicit false as off, and anything else as on", () => {
    assert.equal(readRetryPolicy({ getRetrySettings: () => ({ enabled: false }) }).enabled, false);
    assert.equal(readRetryPolicy({ getRetrySettings: () => ({}) }).enabled, true);
  });

  it("never throws when the settings manager does", () => {
    const view = readRetryPolicy({
      getRetrySettings: () => {
        throw new Error("no settings");
      },
    });
    assert.equal(view.source, "pi_default");
  });

  it("falls back per field rather than discarding a partial reading", () => {
    const view = readRetryPolicy({ getRetrySettings: () => ({ enabled: true, maxRetries: "nonsense" }) });
    assert.equal(view.maxRetries, PI_DEFAULT_RETRY.maxRetries);
    assert.equal(view.source, "pi_settings");
  });
});

describe("describeRetryPolicy", () => {
  it("names Pi as the owner so no report implies Lykos chose the numbers", () => {
    const line = describeRetryPolicy(readRetryPolicy(undefined));
    assert.ok(line.includes("3 attempts"));
    assert.ok(line.includes("not by .lykos/config.yaml"));
  });

  it("says OFF loudly, because a disabled retry is a capability loss", () => {
    const line = describeRetryPolicy({ enabled: false, maxRetries: 3, baseDelayMs: 2000, source: "pi_settings" });
    assert.ok(line.includes("OFF"));
  });
});

describe("observeRetryEvent", () => {
  it("counts a recovered episode", () => {
    const obs = newRetryObservation();
    observeRetryEvent(obs, { type: "auto_retry_start", attempt: 1, errorMessage: "429 rate limit" });
    observeRetryEvent(obs, { type: "auto_retry_end", success: true, attempt: 1 });
    assert.equal(obs.retryStarts, 1);
    assert.equal(obs.retriesRecovered, 1);
    assert.equal(obs.retriesExhausted, 0);
    assert.equal(obs.maxAttempt, 1);
    assert.equal(obs.lastError, "429 rate limit");
  });

  it("counts an exhausted episode separately", () => {
    const obs = newRetryObservation();
    observeRetryEvent(obs, { type: "auto_retry_start", attempt: 1, errorMessage: "overloaded" });
    observeRetryEvent(obs, { type: "auto_retry_start", attempt: 2, errorMessage: "overloaded" });
    observeRetryEvent(obs, { type: "auto_retry_end", success: false, attempt: 3, finalError: "still overloaded" });
    assert.equal(obs.retryStarts, 2);
    assert.equal(obs.retriesExhausted, 1);
    assert.equal(obs.retriesRecovered, 0);
    assert.equal(obs.maxAttempt, 3);
    assert.equal(obs.lastError, "still overloaded");
  });

  it("ignores every unrelated event, so it can share the existing subscribe switch", () => {
    const obs = newRetryObservation();
    observeRetryEvent(obs, { type: "turn_start" });
    observeRetryEvent(obs, { type: "tool_execution_end" });
    assert.deepEqual(obs, newRetryObservation());
  });

  it("does not record an end it never saw the start of", () => {
    const obs = newRetryObservation();
    observeRetryEvent(obs, { type: "auto_retry_end", success: false, attempt: 2 });
    assert.equal(obs.retriesExhausted, 0);
  });
});

describe("endedOnExhaustedRetry", () => {
  it("is true only when the session errored after a retry ran out", () => {
    const obs = newRetryObservation();
    observeRetryEvent(obs, { type: "auto_retry_start", attempt: 1, errorMessage: "502" });
    observeRetryEvent(obs, { type: "auto_retry_end", success: false, attempt: 3 });
    assert.equal(endedOnExhaustedRetry(obs, "error"), true);
    assert.equal(endedOnExhaustedRetry(obs, "done"), false);
  });

  it("is false for an ordinary error with no retry behind it", () => {
    assert.equal(endedOnExhaustedRetry(newRetryObservation(), "error"), false);
  });
});
