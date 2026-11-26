// P5 #52: `lykos` runs the prebuilt lykos-tui. Which binary it finds, how it starts it, and how `npm install`
// fetches one: from a release's assets, checked against its SHA256SUMS.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { trustedAtPath } from "../gate/trust.js";
import { findTui, tuiLaunch, vendoredTui } from "./tui.js";

interface InstallResult {
  path?: string;
  version?: string;
  cached?: boolean;
  skipped?: string;
  error?: string;
}
interface InstallModule {
  install(opts: { root: string; platform: string; arch: string; env: Record<string, string>; log: (s: string) => void }): Promise<InstallResult>;
}
// A plain script npm runs, so it is loaded as one: it has no types.
const { install } = (await import(new URL("../../scripts/tui/install.mjs", import.meta.url).href)) as InstallModule;

function project(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "lykos-tui-install-"));
  writeFileSync(join(root, "Cargo.toml"), `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${version}"\nedition = "2021"\n`);
  return root;
}

async function serve(files: Record<string, Buffer | string>): Promise<{ server: Server; url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const name = (req.url ?? "").split("/").pop() ?? "";
    hits.push(name);
    const body = req.url?.includes("/nope/") === true ? undefined : files[name];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/tui-v1.2.3`, hits };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe("P5 #52: lykos opens lykos-tui", () => {
  it("finds LYKOS_TUI_BIN, then a source build, then the fetched one", () => {
    const root = project("1.2.3");
    assert.equal(findTui({}, root, "linux"), undefined, "none installed");
    const vendored = vendoredTui(root, "linux", "x64");
    mkdirSync(join(vendored, ".."), { recursive: true });
    writeFileSync(vendored, "");
    assert.equal(findTui({}, root, "linux"), process.arch === "x64" ? vendored : undefined);
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(join(root, "target", "release", "lykos-tui"), "");
    assert.equal(findTui({}, root, "linux"), join(root, "target", "release", "lykos-tui"), "a source build wins over the fetched one");
    assert.equal(findTui({ LYKOS_TUI_BIN: "/x/tui" }, root, "linux"), "/x/tui");
  });

  it("knows a trusted project by its registered path without git, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-tui-trust-"));
    const registryPath = join(dir, "projects.json");
    const trustPath = join(dir, "trust.json");
    const row = (id: string, root_path: string) => ({ id, root_path, git_remote: null, first_commit: null, name: "p", created_utc: "2026-01-01T00:00:00Z", last_seen_utc: "2026-01-01T00:00:00Z" });
    writeFileSync(registryPath, JSON.stringify({ version: 1, projects: [row("a", join(dir, "trusted")), row("b", join(dir, "other"))] }));
    writeFileSync(trustPath, JSON.stringify({ version: 1, projects: { a: { trustedUtc: "2026-01-01T00:00:00Z" } } }));
    assert.equal(trustedAtPath(join(dir, "trusted"), { registryPath, trustPath }), true);
    assert.equal(trustedAtPath(join(dir, "other"), { registryPath, trustPath }), false, "registered, not trusted");
    assert.equal(trustedAtPath(join(dir, "elsewhere"), { registryPath, trustPath }), false, "not registered");
  });

  it("starts the TUI in the cwd, with this Node as its server command unless one is set", () => {
    const l = tuiLaunch("/bin/tui", "/w", false, { PATH: "p" });
    assert.deepEqual(l.args, ["--cwd", "/w"]);
    const serve = JSON.parse(l.env.LYKOS_SERVE_CMD ?? "[]") as string[];
    assert.equal(serve[0], process.execPath);
    assert.equal(serve.at(-1), "serve");
    assert.equal(l.env.PATH, "p");
    assert.deepEqual(tuiLaunch("/bin/tui", "/w", true, { LYKOS_SERVE_CMD: "[\"x\"]" }).args, ["--cwd", "/w", "--trust-workspace"], "trusted for this run only");
    assert.equal(tuiLaunch("/bin/tui", "/w", true, { LYKOS_SERVE_CMD: "[\"x\"]" }).env.LYKOS_SERVE_CMD, "[\"x\"]");
  });

  it("fetches the platform's binary from the release, checked against SHA256SUMS, once per version", async () => {
    const root = project("1.2.3");
    const bin = Buffer.from("the linux binary");
    const { server, url, hits } = await serve({ SHA256SUMS: `${sha(bin)}  lykos-tui-linux-x64\n${sha(Buffer.from("w"))}  lykos-tui-win32-x64.exe\n`, "lykos-tui-linux-x64": bin });
    try {
      const env = { LYKOS_TUI_RELEASE_URL: url };
      const r = await install({ root, platform: "linux", arch: "x64", env, log: () => {} });
      assert.equal(r.error, undefined);
      assert.equal(r.path, vendoredTui(root, "linux", "x64"));
      assert.deepEqual(readFileSync(r.path!), bin);
      assert.deepEqual(hits, ["SHA256SUMS", "lykos-tui-linux-x64"]);
      const again = await install({ root, platform: "linux", arch: "x64", env, log: () => {} });
      assert.equal(again.cached, true);
      assert.equal(hits.length, 2, "the same version is not fetched again");
      assert.match((await install({ root, platform: "darwin", arch: "arm64", env, log: () => {} })).error ?? "", /no prebuilt lykos-tui for darwin-arm64/);
    } finally {
      server.close();
    }
  });

  it("refuses a binary whose checksum differs, and fails without failing npm install", async () => {
    const root = project("1.2.3");
    const { server, url } = await serve({ SHA256SUMS: `${"0".repeat(64)}  lykos-tui-linux-x64\n`, "lykos-tui-linux-x64": "tampered" });
    try {
      const r = await install({ root, platform: "linux", arch: "x64", env: { LYKOS_TUI_RELEASE_URL: url }, log: () => {} });
      assert.match(r.error ?? "", /sha256 .* SHA256SUMS says 0{64}/);
      assert.equal(findTui({}, root, "linux"), undefined, "nothing was installed");
      const missing = await install({ root: project("9.9.9"), platform: "linux", arch: "x64", env: { LYKOS_TUI_RELEASE_URL: `${url}/nope` }, log: () => {} });
      assert.match(missing.error ?? "", /HTTP 404/);
      assert.equal((await install({ root, platform: "linux", arch: "x64", env: { LYKOS_TUI_SKIP_DOWNLOAD: "1" }, log: () => {} })).skipped, "LYKOS_TUI_SKIP_DOWNLOAD=1");
    } finally {
      server.close();
    }
  });
});
