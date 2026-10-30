import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { DenialLog } from "../gate/approval.js";
import {
  SPECIALIST_NAME_ENV,
  SPECIALIST_OFF_LIMITS_ENV,
  SPECIALIST_ALLOWED_ENV,
  buildSpecialistRefusal,
  createSpecialistGuardHandler,
  setGuardDenialLog,
  getGuardDenialLog,
  GUARD_DENIAL_LOG_KEY,
} from "./specialist-guard-extension.js";
import {
  encodeSpecialistOffLimitsEnv,
  decodeSpecialistOffLimitsEnv,
} from "../config/extensions.js";

const fakeCall = (toolName: string): ToolCallEvent =>
  ({
    type: "tool_call",
    toolCallId: "call-1",
    toolName,
    input: {},
  } as ToolCallEvent);

describe("specialist guard env encoding / decoding", () => {
  it("round-trips tool name lists", () => {
    const tools = ["write", "edit", "bash"];
    const encoded = encodeSpecialistOffLimitsEnv(tools);
    assert.deepEqual(decodeSpecialistOffLimitsEnv(encoded), tools);
  });

  it("returns null for absent, empty, or invalid env values", () => {
    assert.equal(decodeSpecialistOffLimitsEnv(undefined), null);
    assert.equal(decodeSpecialistOffLimitsEnv(""), null);
    assert.equal(decodeSpecialistOffLimitsEnv("not json"), null);
    assert.equal(decodeSpecialistOffLimitsEnv("123"), null);
    assert.equal(decodeSpecialistOffLimitsEnv("[1, 2]"), null);
    assert.equal(decodeSpecialistOffLimitsEnv("{\"tools\": [\"write\"]} "), null);
  });
});

describe("buildSpecialistRefusal (D3)", () => {
  it("includes the specialist name, the disallowed tool, and allowed alternatives", () => {
    const msg = buildSpecialistRefusal("plan", "write", ["read", "bash"]);
    assert.match(msg, /lykos: refused/);
    assert.match(msg, /"plan"/);
    assert.match(msg, /does not allow write/);
    assert.match(msg, /Allowed here: read, bash/);
  });

  it("handles empty allowed tools", () => {
    const msg = buildSpecialistRefusal("strict", "write", []);
    assert.match(msg, /Allowed here: \(none\)/);
  });
});

describe("specialist guard handler (D1, D2, D8)", () => {
  const origEnvName = process.env[SPECIALIST_NAME_ENV];
  const origEnvOffLimits = process.env[SPECIALIST_OFF_LIMITS_ENV];
  const origEnvAllowed = process.env[SPECIALIST_ALLOWED_ENV];

  beforeEach(() => {
    delete process.env[SPECIALIST_NAME_ENV];
    delete process.env[SPECIALIST_OFF_LIMITS_ENV];
    delete process.env[SPECIALIST_ALLOWED_ENV];
    setGuardDenialLog(undefined);
  });

  afterEach(() => {
    if (origEnvName !== undefined) process.env[SPECIALIST_NAME_ENV] = origEnvName;
    else delete process.env[SPECIALIST_NAME_ENV];
    if (origEnvOffLimits !== undefined) process.env[SPECIALIST_OFF_LIMITS_ENV] = origEnvOffLimits;
    else delete process.env[SPECIALIST_OFF_LIMITS_ENV];
    if (origEnvAllowed !== undefined) process.env[SPECIALIST_ALLOWED_ENV] = origEnvAllowed;
    else delete process.env[SPECIALIST_ALLOWED_ENV];
    setGuardDenialLog(undefined);
  });

  it("returns undefined immediately when no off-limits tools are set", () => {
    const handler = createSpecialistGuardHandler();
    const res = handler(fakeCall("write"));
    assert.equal(res, undefined);
  });

  it("returns undefined for tools that are not off limits", () => {
    const handler = createSpecialistGuardHandler({
      specialistName: "reviewer",
      offLimitTools: ["write", "edit"],
      allowedTools: ["read", "grep"],
    });
    const res = handler(fakeCall("read"));
    assert.equal(res, undefined);
  });

  it("blocks disallowed tool under tools_mode: append where tool is in requestToolNames (D8)", () => {
    const handler = createSpecialistGuardHandler({
      specialistName: "reviewer",
      offLimitTools: ["write", "edit"],
      allowedTools: ["read", "grep"],
    });
    const res = handler(fakeCall("write"));
    assert.ok(res !== undefined);
    assert.equal(res.block, true);
    assert.equal(res.terminate, undefined);
    assert.match(res.reason ?? "", /lykos: refused/);
    assert.match(res.reason ?? "", /"reviewer"/);
    assert.match(res.reason ?? "", /does not allow write/);
    assert.match(res.reason ?? "", /Allowed here: read, grep/);
  });

  it("reads config from process.env when not passed in options (D2)", () => {
    process.env[SPECIALIST_NAME_ENV] = "explore";
    process.env[SPECIALIST_OFF_LIMITS_ENV] = encodeSpecialistOffLimitsEnv(["write", "bash"]);
    process.env[SPECIALIST_ALLOWED_ENV] = encodeSpecialistOffLimitsEnv(["read"]);

    const handler = createSpecialistGuardHandler();
    const res = handler(fakeCall("bash"));
    assert.ok(res !== undefined);
    assert.equal(res.block, true);
    assert.match(res.reason ?? "", /"explore"/);
    assert.match(res.reason ?? "", /does not allow bash/);
    assert.match(res.reason ?? "", /Allowed here: read/);
  });

  it("records refusals in DenialLog with specialist_restricted reason (D7)", () => {
    const denials = new DenialLog();
    const handler = createSpecialistGuardHandler({
      specialistName: "read-only",
      offLimitTools: ["write"],
      allowedTools: ["read"],
      denials,
    });

    handler(fakeCall("write"));
    assert.equal(denials.specialistRestricted, 1);
    assert.equal(denials.total, 1);
    assert.match(denials.last ?? "", /write read-only \(specialist_restricted\)/);
  });

  it("blocks a tool whose residency is off in the registry and records refusal in DenialLog (D3)", () => {
    const denials = new DenialLog();
    const handler = createSpecialistGuardHandler({
      specialistName: "plan",
      denials,
    });

    const res = handler(fakeCall("subagent_workflow"));
    assert.ok(res !== undefined);
    assert.equal(res.block, true);
    assert.ok((res.reason ?? "").includes("lykos: refused"));
    assert.ok((res.reason ?? "").includes('"plan"'));
    assert.ok((res.reason ?? "").includes("subagent_workflow"));
    assert.equal(denials.specialistRestricted, 1);
    assert.equal(denials.total, 1);
    assert.ok((denials.last ?? "").includes("subagent_workflow plan (specialist_restricted)"));
  });

  it("blocks off tool configured via registryOffTools option", () => {
    const denials = new DenialLog();
    const handler = createSpecialistGuardHandler({
      specialistName: "reviewer",
      registryOffTools: ["custom_tool"],
      denials,
    });

    const res = handler(fakeCall("custom_tool"));
    assert.ok(res !== undefined);
    assert.equal(res.block, true);
    assert.equal(denials.specialistRestricted, 1);
    assert.ok((denials.last ?? "").includes("custom_tool reviewer (specialist_restricted)"));
  });
});

describe("the denial log crosses Pi's module boundary (D7)", () => {
  // Pi loads this extension through jiti with `moduleCache: false`
  // (`dist/core/extensions/loader.js`), so the instance Pi evaluates is a
  // different module object from the one boot.ts imports. A cache-busting
  // query gives Node the same separation, which is the only way to catch the
  // failure this test exists for: a module-level denial log that every
  // in-process test populated happily and that production never wrote to.
  it("a handler from a separately evaluated instance records into the host's log", async () => {
    const fresh = (await import(`./specialist-guard-extension.js?instance=${Date.now()}`)) as typeof import("./specialist-guard-extension.js");
    assert.notEqual(fresh.createSpecialistGuardHandler, createSpecialistGuardHandler, "the test needs two module instances");

    const denials = new DenialLog();
    setGuardDenialLog(denials);
    try {
      const handler = fresh.createSpecialistGuardHandler({
        specialistName: "reviewer",
        offLimitTools: ["write"],
        allowedTools: ["read"],
      });
      const result = handler({ type: "tool_call", toolCallId: "t1", toolName: "write", input: {} } as ToolCallEvent);
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /"reviewer" specialist does not allow write/);
      assert.equal(denials.total, 1, "the refusal must reach the host's DenialLog, not a second copy of it");
    } finally {
      setGuardDenialLog(undefined);
    }
  });

  it("clearing the log leaves nothing behind on globalThis", () => {
    const denials = new DenialLog();
    setGuardDenialLog(denials);
    assert.equal(getGuardDenialLog(), denials);
    setGuardDenialLog(undefined);
    assert.equal(getGuardDenialLog(), undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(globalThis, GUARD_DENIAL_LOG_KEY), false);
  });
});
