// `lykos usage` (ADR-0025).
//
// Lists credential pools, cooldowns, reset times and each cached usage window
// (ticket 09, plan D4). `--refresh` fetches a usage report for every enabled
// OAuth row of a provider with a usage endpoint, once, one after another; it
// is the only command-line path that calls those endpoints.
// Output names labels only: no token or secret is ever printed.
// An empty or absent store exits 0 with a guidance message without creating the file.

import { activeCooldowns, type Cooldown, defaultCredentialDbPath, openCredentialDb } from "../credentials/db.js";
import { listCredentials, readCredentialById } from "../credentials/pool.js";
import { type CachedReport, readCachedReport, storeReport } from "../credentials/usage/cache.js";
import { usageProviderFor } from "../credentials/usage/index.js";

export interface UsageIO {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  dbPath?: string;
  now?: () => number;
  args?: string[];
  /** The fetch `--refresh` uses. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Plan D4: `<window> <used%> resets <ISO>` per window and the report's age, or `unmeasured` (rule 4). */
function formatUsage(cached: CachedReport | undefined, nowMs: number): string {
  if (cached === undefined || cached.report.windows.length === 0) return "usage: unmeasured";
  const windows = cached.report.windows.map((w) => {
    const reset = w.resetAtMs !== undefined ? ` resets ${new Date(w.resetAtMs).toISOString()}` : "";
    return `${w.id} ${Math.round(w.usedFraction * 100)}%${reset}`;
  });
  const ageMinutes = Math.max(0, Math.floor((nowMs - cached.fetchedAt) / 60_000));
  return `usage: ${windows.join(", ")} (fetched ${ageMinutes}m ago)`;
}

/** The bound on one `--refresh` fetch, as rotation's (plan D2). */
const REFRESH_TIMEOUT_MS = 5_000;

export async function runUsage(ioIn: Partial<UsageIO> = {}): Promise<number> {
  const io: UsageIO = {
    stdout: ioIn.stdout ?? process.stdout,
    stderr: ioIn.stderr ?? process.stderr,
    env: ioIn.env ?? process.env,
    ...(ioIn.dbPath !== undefined ? { dbPath: ioIn.dbPath } : {}),
    ...(ioIn.now !== undefined ? { now: ioIn.now } : {}),
    ...(ioIn.args !== undefined ? { args: ioIn.args } : {}),
    ...(ioIn.fetch !== undefined ? { fetch: ioIn.fetch } : {}),
  };

  const args = io.args ?? [];
  const refresh = args.includes("--refresh");
  const fetchImpl = io.fetch ?? globalThis.fetch;

  const dbPath = io.dbPath ?? defaultCredentialDbPath(io.env);
  const db = openCredentialDb(dbPath, { create: false });
  if (db === undefined) {
    io.stdout.write("no credentials — run `lykos login <provider>`\n");
    return 0;
  }

  try {
    const rows = listCredentials(db);
    if (rows.length === 0) {
      io.stdout.write("no credentials — run `lykos login <provider>`\n");
      return 0;
    }

    if (refresh) {
      for (const row of rows) {
        if (row.disabledCause !== null || row.type !== "oauth") continue;
        const provider = usageProviderFor(row.provider);
        if (provider === undefined) continue;
        const full = readCredentialById(db, row.id);
        if (full === undefined) continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
        try {
          const report = await provider.fetchUsage({
            credentialData: full.data,
            fetch: fetchImpl,
            now: (io.now ?? Date.now)(),
            signal: controller.signal,
          });
          // A failed fetch is not stored (plan D1); the row keeps its last report.
          if (report !== undefined) storeReport(db, row.id, report);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const nowMs = (io.now ?? Date.now)();
    const cooldowns = activeCooldowns(db, nowMs);

    const cooldownByCred = new Map<number, Cooldown>();
    for (const cd of cooldowns) {
      const existing = cooldownByCred.get(cd.credentialId);
      if (!existing || cd.untilMs > existing.untilMs) {
        cooldownByCred.set(cd.credentialId, cd);
      }
    }

    const byProvider = new Map<string, typeof rows>();
    for (const row of rows) {
      let list = byProvider.get(row.provider);
      if (!list) {
        list = [];
        byProvider.set(row.provider, list);
      }
      list.push(row);
    }

    const providerNames = Array.from(byProvider.keys()).sort();
    for (const provider of providerNames) {
      const pRows = byProvider.get(provider)!;
      pRows.sort((a, b) => a.id - b.id);

      let enabledCount = 0;
      let coolingCount = 0;
      let disabledCount = 0;

      for (const row of pRows) {
        if (row.disabledCause !== null) {
          disabledCount += 1;
        } else {
          enabledCount += 1;
          if (cooldownByCred.has(row.id)) {
            coolingCount += 1;
          }
        }
      }

      io.stdout.write(`${provider}  (${enabledCount} enabled, ${coolingCount} cooling, ${disabledCount} disabled)\n`);

      for (const row of pRows) {
        let state: string;
        let reset: string;
        if (row.disabledCause !== null) {
          state = `disabled (${row.disabledCause})`;
          reset = "-";
        } else {
          const cd = cooldownByCred.get(row.id);
          if (cd !== undefined) {
            state = cd.reason ? `cooling (${cd.reason})` : "cooling";
            reset = new Date(cd.untilMs).toISOString();
          } else {
            state = "ok";
            reset = "-";
          }
        }
        const usageLine = formatUsage(readCachedReport(db, row.id), nowMs);
        io.stdout.write(`  ${row.label}  ${row.type}  ${state}  ${reset}  ${usageLine}\n`);
      }
    }

    return 0;
  } finally {
    db.close();
  }
}
