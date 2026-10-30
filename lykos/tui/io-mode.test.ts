import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { claimProtocolStream, getIoMode, resetIoMode, setIoMode, stdoutWrite } from "./io-mode.js";

afterEach(() => {
  resetIoMode();
  delete process.env.LYKOS_IO_MODE;
});

describe("io-mode", () => {
  it("setIoMode wins over everything else, including a later env var", () => {
    setIoMode("standalone");
    process.env.LYKOS_IO_MODE = "mcp";
    assert.equal(getIoMode(), "standalone");
  });

  it("LYKOS_IO_MODE overrides the TTY heuristic when no mode was explicitly set", () => {
    process.env.LYKOS_IO_MODE = "piped";
    assert.equal(getIoMode(), "piped");
  });

  it("an invalid LYKOS_IO_MODE value is ignored, not accepted as a fourth mode", () => {
    process.env.LYKOS_IO_MODE = "not-a-real-mode";
    assert.notEqual(getIoMode(), "not-a-real-mode");
  });

  it("is resolved once and cached: a later env change does not retroactively change it", () => {
    process.env.LYKOS_IO_MODE = "standalone";
    assert.equal(getIoMode(), "standalone");
    process.env.LYKOS_IO_MODE = "piped";
    assert.equal(getIoMode(), "standalone");
  });

  it("stdoutWrite throws in mcp mode and never touches process.stdout — both directions demonstrated", () => {
    const original = process.stdout.write;
    let calls = 0;
    process.stdout.write = ((..._args: unknown[]) => {
      calls++;
      return true;
    }) as typeof process.stdout.write;
    try {
      setIoMode("mcp");
      assert.throws(() => stdoutWrite("hello"), /stdout is the JSON-RPC/);
      assert.equal(calls, 0, "stdoutWrite must not have touched the real stream before throwing");

      setIoMode("standalone");
      stdoutWrite("hello");
      assert.equal(calls, 1, "stdoutWrite must pass through in a non-mcp mode");
    } finally {
      process.stdout.write = original;
    }
  });
});

describe("io-mode protocol stream (T181)", () => {
  it("hands the real stdout to the frame writer and sends every other write to stderr", async () => {
    resetIoMode();
    const toStdout: string[] = [];
    const toStderr: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    process.stdout.write = ((c: unknown, cb?: () => void) => (toStdout.push(String(c)), cb?.(), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => (toStderr.push(String(c)), true)) as typeof process.stderr.write;
    try {
      const stream = claimProtocolStream();
      assert.equal(getIoMode(), "protocol");
      stream.write('{"type":"progress"}\n');
      stdoutWrite("a writer that asks the mode\n");
      process.stdout.write("a writer that does not ask\n");
      await stream.flush();
      assert.deepEqual(toStdout.filter((t) => t.length > 0), ['{"type":"progress"}\n']);
      assert.deepEqual(toStderr, ["a writer that asks the mode\n", "a writer that does not ask\n"]);
    } finally {
      resetIoMode();
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
  });
});
