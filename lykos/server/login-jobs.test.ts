import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoginRuntime } from "../credentials/login-flow.js";
import { LoginJobs, type LoginStatus } from "./login-jobs.js";

type Interaction = Parameters<LoginRuntime["login"]>[2];

/** Polls `id` until `until` holds, as the TUI does. */
async function poll(jobs: LoginJobs, id: string, until: (s: LoginStatus) => boolean): Promise<LoginStatus> {
  for (let i = 0; i < 200; i++) {
    const s = jobs.status(id);
    if (until(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

test("a browser sign-in with no session opens its URL, asks for the code, and stores what it returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykos-login-jobs-"));
  const opened: string[] = [];
  const runtime: LoginRuntime = {
    getProvider: ((id: string) => (id === "fake" ? { auth: { oauth: { login: () => {} } } } : undefined)) as unknown as NonNullable<LoginRuntime["getProvider"]>,
    login: (async (_provider: string, _kind: string, io: Interaction) => {
      io.notify({ type: "auth_url", url: "https://sign-in.test/a" });
      const code = await io.prompt({ type: "text", message: "Paste the code" });
      return { type: "oauth", access: code, refresh: "r", expires: Date.now() + 3_600_000 };
    }) as unknown as LoginRuntime["login"],
  };
  const jobs = new LoginJobs({ dbPath: () => join(dir, "credentials.db"), openBrowser: (url) => opened.push(url), createRuntime: async () => runtime });
  try {
    const id = jobs.start("fake", false);
    const asking = await poll(jobs, id, (s) => s.ask !== undefined);
    assert.deepEqual(opened, ["https://sign-in.test/a"]);
    assert.ok(asking.lines.includes("  https://sign-in.test/a"), asking.lines.join("\n"));
    assert.deepEqual(asking.ask, { prompt: "Paste the code", secret: false });
    jobs.answer(id, "the-code");
    const done = await poll(jobs, id, (s) => s.done !== undefined);
    assert.equal(done.done?.ok, true, done.lines.join("\n"));
    assert.match(done.lines.at(-1) ?? "", /logged in to fake/);
    assert.throws(() => jobs.status(id), /no sign-in/, "a finished sign-in is forgotten once read");

    // Cancelled while it asks: the question gets no answer and the sign-in is gone.
    const second = jobs.start("fake", false);
    await poll(jobs, second, (s) => s.ask !== undefined);
    jobs.cancel(second);
    assert.throws(() => jobs.status(second), /no sign-in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
