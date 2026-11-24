// `npm install`'s postinstall (P5 #52): the prebuilt lykos-tui for this platform, from the GitHub release that
// `.github/workflows/tui.yml` makes for the Cargo workspace's version (tag `tui-v<version>`), checked against the
// release's SHA256SUMS and put in `vendor/tui/<platform>-<arch>/`. `lykos` runs it (`lykos/cli/tui.ts`).
//
// Nothing is fetched when LYKOS_TUI_BIN names a binary, a source build is at target/release/, the vendored one is
// already this version, or LYKOS_TUI_SKIP_DOWNLOAD=1. A failure never fails `npm install`: it says how to get one.
// LYKOS_TUI_RELEASE_URL replaces the release's download URL (a mirror, or a test server).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The platforms a release has a binary for, by Node's platform-arch. */
export const ASSETS = { "win32-x64": "lykos-tui-win32-x64.exe", "linux-x64": "lykos-tui-linux-x64" };

export function workspaceVersion(root) {
  const m = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "Cargo.toml"), "utf8"));
  if (!m) throw new Error("no [workspace.package] version in Cargo.toml");
  return m[1];
}

/** Fetch and check the binary; returns where it is, or why there is none. */
export async function install({ root, platform = process.platform, arch = process.arch, env = process.env, log = (s) => process.stderr.write(`${s}\n`) }) {
  const exe = platform === "win32" ? "lykos-tui.exe" : "lykos-tui";
  if (env.LYKOS_TUI_BIN) return { skipped: "LYKOS_TUI_BIN names the binary" };
  if (env.LYKOS_TUI_SKIP_DOWNLOAD === "1") return { skipped: "LYKOS_TUI_SKIP_DOWNLOAD=1" };
  if (existsSync(join(root, "target", "release", exe))) return { skipped: "a source build is at target/release" };
  const asset = ASSETS[`${platform}-${arch}`];
  if (asset === undefined) return { error: `no prebuilt lykos-tui for ${platform}-${arch}: cargo build --release -p lykos-tui builds one` };
  const version = workspaceVersion(root);
  const dir = join(root, "vendor", "tui", `${platform}-${arch}`);
  const dest = join(dir, exe);
  const stamp = join(dir, "VERSION");
  if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) return { path: dest, version, cached: true };
  const base = (env.LYKOS_TUI_RELEASE_URL || `https://github.com/rakun68/Lykos/releases/download/tui-v${version}`).replace(/\/$/, "");
  const get = async (name) => {
    const res = await fetch(`${base}/${name}`);
    if (!res.ok) throw new Error(`${base}/${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  try {
    const sums = (await get("SHA256SUMS")).toString("utf8");
    const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(`*${asset}`));
    if (!line) throw new Error(`SHA256SUMS lists no ${asset}`);
    const want = line.trim().split(/\s+/)[0].toLowerCase();
    const bytes = await get(asset);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`${asset}: sha256 ${got}, SHA256SUMS says ${want}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dest}.part`, bytes);
    if (platform !== "win32") chmodSync(`${dest}.part`, 0o755);
    renameSync(`${dest}.part`, dest);
    writeFileSync(stamp, `${version}\n`);
    log(`lykos: lykos-tui ${version} installed in ${dir}`);
    return { path: dest, version };
  } catch (err) {
    return { error: `could not fetch lykos-tui ${version}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const r = await install({ root });
  if (r.error) {
    process.stderr.write(`lykos: ${r.error}\n  cargo build --release -p lykos-tui builds it, LYKOS_TUI_BIN names one; lykos --old-tui runs the old TUI.\n`);
  }
}
