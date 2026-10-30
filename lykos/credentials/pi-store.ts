// LykosCredentialStore: Pi's `CredentialStore` over the Lykos credential db
// (ADR-0025).
//
// Injected through `createLykosModelRuntime`, so Pi never reads `auth.json`.
// `read` hands Pi exactly one credential, the one `selectCredential` picks (or,
// inside a rotation attempt, the row the wrapper chose); no extension API can
// list the pool. `modify` is Pi's refresh path and is
// serialised across processes by a lease row, because providers rotate the
// refresh token and two parallel refreshes would log each other out.

import { randomUUID } from "node:crypto";
import type { CredentialStore } from "../session/model-runtime.js";
import { credentialContext } from "./context.js";
import { type CredentialDb, defaultCredentialDbPath, openCredentialDb, upsertCooldown } from "./db.js";
import { oauthIdentityKey } from "./identity.js";
import {
  type Credential,
  type CredentialRowWithData,
  type CredentialType,
  type StoredApiKey,
  disableCredential,
  listEnabled,
  readCredentialById,
  serializeCredentialData,
  upsertCredential,
} from "./pool.js";
import { resolveKeySource } from "./resolve-key.js";
import { coolingIds, reachableRows, selectCredential } from "./select.js";
import { readFreshReport, storeReport } from "./usage/cache.js";
import { usageProviderFor } from "./usage/index.js";
import { usageLimitResetAt } from "./usage/rank.js";
import type { UsageProvider, UsageReport } from "./usage/types.js";

/** A pool row as rotation sees it: never the secret. */
export interface PoolRowRef {
  id: number;
  label: string;
  type: CredentialType;
}

function toRef(row: { id: number; label: string; type: CredentialType }): PoolRowRef {
  return { id: row.id, label: row.label, type: row.type };
}

type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];
type OperationOptions = Parameters<CredentialStore["read"]>[1];

/** A lease lives 15 s, is polled every 50 ms and renewed every 5 s. */
export const LEASE_TTL_MS = 15_000;
export const LEASE_POLL_MS = 50;
export const LEASE_RENEW_MS = 5_000;
/** Plan D2: the bound on a usage fetch made after a usage limit. */
export const USAGE_FETCH_TIMEOUT_MS = 5_000;

export interface LykosCredentialStoreOptions {
  /** Defaults to `defaultCredentialDbPath(env)`. */
  dbPath?: string;
  /**
   * Session id for selection when no request is in flight. Inside a
   * `streamSimple` call the session id Pi passes there wins (`context.ts`).
   */
  sessionId?: string;
  /** Environment for `$VAR` and `!command` key sources. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `providers.<id>.fallbackToApiKey` from config.yaml (ADR-0026). Omitted = false for every provider. */
  fallbackToApiKey?: (provider: string) => boolean;
  /**
   * The usage endpoints (ticket 09, plan D2). Omitted = the real providers
   * (`usage/index.ts`) over `globalThis.fetch`. Tests point these at a fake
   * server; nothing else sets them.
   */
  usage?: {
    providerFor?: (provider: string) => UsageProvider | undefined;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Take the refresh lease on one credential row, waiting while another live owner holds it. */
async function acquireLease(db: CredentialDb, credentialId: number, owner: string, signal?: AbortSignal): Promise<void> {
  const acquire = db.prepare(
    `INSERT INTO refresh_leases (credential_id, owner, expires_at_ms) VALUES (?, ?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET owner = excluded.owner, expires_at_ms = excluded.expires_at_ms
     WHERE refresh_leases.expires_at_ms <= ?`,
  );
  for (;;) {
    signal?.throwIfAborted();
    const now = Date.now();
    if (acquire.run(credentialId, owner, now + LEASE_TTL_MS, now).changes === 1) return;
    await sleep(LEASE_POLL_MS, signal);
  }
}

function renewLease(db: CredentialDb, credentialId: number, owner: string): void {
  db.prepare("UPDATE refresh_leases SET expires_at_ms = ? WHERE credential_id = ? AND owner = ?").run(
    Date.now() + LEASE_TTL_MS,
    credentialId,
    owner,
  );
}

function releaseLease(db: CredentialDb, credentialId: number, owner: string): void {
  db.prepare("DELETE FROM refresh_leases WHERE credential_id = ? AND owner = ?").run(credentialId, owner);
}

/** Run `body` holding the lease on `credentialId`, renewing it until `body` settles. */
async function withLease<T>(
  db: CredentialDb,
  credentialId: number,
  signal: AbortSignal | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const owner = `${process.pid}:${randomUUID()}`;
  await acquireLease(db, credentialId, owner, signal);
  const renew = setInterval(() => {
    try {
      renewLease(db, credentialId, owner);
    } catch {
      // A busy db past busy_timeout: the next tick retries; the TTL covers the gap.
    }
  }, LEASE_RENEW_MS);
  renew.unref();
  try {
    return await body();
  } finally {
    clearInterval(renew);
    releaseLease(db, credentialId, owner);
  }
}

export class LykosCredentialStore implements CredentialStore {
  private readonly dbPath: string;
  private readonly sessionId: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallbackToApiKey: (provider: string) => boolean;
  /** The row the last `read` outside a rotation attempt returned, so a following `modify` refreshes that row. */
  private readonly lastRead = new Map<string, number>();
  private readonly usageProviderFor: (provider: string) => UsageProvider | undefined;
  private readonly usageFetch: typeof globalThis.fetch | undefined;
  private readonly usageTimeoutMs: number;
  /** Usage fetches started by `extendCooldownFromUsage` and not yet settled. */
  private readonly pendingUsage = new Set<Promise<void>>();
  /** D27: the connection shared by one burst of synchronous work; see `burstDb`. */
  private burst: CredentialDb | undefined;

  constructor(opts: LykosCredentialStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.dbPath = opts.dbPath ?? defaultCredentialDbPath(this.env);
    this.sessionId = opts.sessionId;
    this.fallbackToApiKey = opts.fallbackToApiKey ?? (() => false);
    this.usageProviderFor = opts.usage?.providerFor ?? usageProviderFor;
    this.usageFetch = opts.usage?.fetch;
    this.usageTimeoutMs = opts.usage?.timeoutMs ?? USAGE_FETCH_TIMEOUT_MS;
  }

  /** The session selection is for: the request in flight, else the one this store was built with. */
  private currentSessionId(): string | undefined {
    return credentialContext.getStore()?.sessionId ?? this.sessionId;
  }

  /**
   * The row Pi's call for `providerId` must use. Inside a rotation attempt it
   * is the row the wrapper chose, and only while that row is enabled. Outside
   * one, `read` selects (persisting the session's sticky row), and `modify` /
   * `delete` act on whatever `read` last returned, else on a side-effect-free
   * selection.
   */
  private activeRow(
    db: CredentialDb,
    providerId: string,
    mode: "read" | "act",
  ): CredentialRowWithData | undefined {
    const ctx = credentialContext.getStore();
    if (ctx !== undefined && ctx.provider === providerId && ctx.credentialId !== undefined) {
      const row = readCredentialById(db, ctx.credentialId);
      return row !== undefined && row.disabledCause === null && row.provider === providerId ? row : undefined;
    }
    if (mode === "act") {
      const lastId = this.lastRead.get(providerId);
      const last = lastId === undefined ? undefined : readCredentialById(db, lastId);
      if (last !== undefined && last.disabledCause === null && last.provider === providerId) return last;
    }
    const sessionId = this.currentSessionId();
    const row = selectCredential(db, {
      provider: providerId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      fallbackToApiKey: this.fallbackToApiKey(providerId),
      peek: mode === "act",
    });
    if (row !== undefined && mode === "read") this.lastRead.set(providerId, row.id);
    return row;
  }

  /**
   * D27: one connection per burst of work, closed on the next turn of the
   * event loop. Pi's availability refresh calls `read` once per provider, a
   * few hundred times per refresh and several refreshes per request, and a
   * fresh open-and-close costs about 6.5 ms against 0.04 ms for a query on an
   * open connection (measured 2026-09-26). Closing on the next turn rather
   * than holding the file for the store's lifetime means no handle outlives
   * the work, so Windows can still delete the directory a test put it in.
   *
   * Only for synchronous use. Anything that holds a lease across an `await`
   * opens its own connection, because this one may close under it.
   */
  private burstDb(): CredentialDb | undefined {
    if (this.burst !== undefined) return this.burst;
    const db = openCredentialDb(this.dbPath, { create: false });
    if (db === undefined) return undefined;
    this.burst = db;
    setImmediate(() => this.close()).unref();
    return db;
  }

  /** Close the burst connection now. Safe to call at any time; the next use reopens. */
  close(): void {
    const db = this.burst;
    this.burst = undefined;
    db?.close();
  }

  /** The db for a rotation operation; undefined when no login ever created it. */
  private withDb<T>(fn: (db: CredentialDb) => T, fallback: T): T {
    const db = this.burstDb();
    return db === undefined ? fallback : fn(db);
  }

  // -------------------------------------------------------------------------
  // Rotation surface (ticket 05). Never returns a secret.
  // -------------------------------------------------------------------------

  /** How many enabled rows the provider's pool holds. */
  enabledCount(providerId: string): number {
    return this.withDb((db) => listEnabled(db, providerId).length, 0);
  }

  /** How many rows a request starting now could reach (plan D4: the attempt cap). */
  reachableCount(providerId: string, now: number = Date.now()): number {
    return this.withDb(
      (db) => reachableRows(db, { provider: providerId, now, fallbackToApiKey: this.fallbackToApiKey(providerId) }).length,
      0,
    );
  }

  /** Select the row for one attempt, skipping `exclude`, and persist the session's sticky choice. */
  selectForRequest(
    providerId: string,
    sessionId: string | undefined,
    exclude: ReadonlySet<number>,
    now: number = Date.now(),
    modelId?: string,
  ): PoolRowRef | undefined {
    return this.withDb((db) => {
      const row = selectCredential(db, {
        provider: providerId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        now,
        fallbackToApiKey: this.fallbackToApiKey(providerId),
        exclude,
      });
      return row === undefined ? undefined : toRef(row);
    }, undefined);
  }

  /** Persist a cooldown; the db keeps the later of two. Shared with every process on the same file. */
  recordCooldown(credentialId: number, untilMs: number, reason: string): void {
    this.withDb((db) => upsertCooldown(db, credentialId, untilMs, { reason }), undefined);
  }

  /** Soft-disable a row. Nothing in rotation deletes one. */
  softDisable(credentialId: number, cause: string): void {
    this.withDb((db) => disableCredential(db, credentialId, cause), false);
  }

  /** The earliest time an enabled, cooling row of the provider becomes usable again. */
  nextCooldownEnd(providerId: string, now: number = Date.now()): number | undefined {
    return this.withDb((db) => {
      const ids = new Set(listEnabled(db, providerId).map((r) => r.id));
      const cooling = coolingIds(db, now);
      let soonest: number | undefined;
      for (const id of ids) {
        if (!cooling.has(id)) continue;
        const until = db.prepare("SELECT max(until_ms) AS u FROM cooldowns WHERE credential_id = ?").get(id) as {
          u: number;
        };
        if (soonest === undefined || until.u < soonest) soonest = until.u;
      }
      return soonest;
    }, undefined);
  }

  /**
   * Plan D2 (ticket 09): after a usage limit on an OAuth row, read the row's
   * usage report (a fresh cached one, else one fetch bounded by
   * `USAGE_FETCH_TIMEOUT_MS`) and, when the windows the request uses are
   * exhausted, extend the row's cooldown to when they have all reset. The caller has already recorded
   * the parsed-or-default cooldown and does not wait: the replay on the next
   * row runs while this settles. A failed or timed-out fetch, a report with
   * nothing exhausted, or an earlier reset leaves that cooldown as it is
   * (`upsertCooldown` keeps the later time). A failed fetch is not stored.
   */
  extendCooldownFromUsage(
    credentialId: number,
    provider: string,
    request: { baseUrl?: string; modelId?: string } = {},
  ): void {
    const usage = this.usageProviderFor(provider);
    if (usage === undefined) return;
    const task = this.extendFromUsage(usage, credentialId, provider, request).catch(() => {
      // A busy or missing db, or anything else: the fallback cooldown stands.
    });
    this.pendingUsage.add(task);
    void task.finally(() => this.pendingUsage.delete(task));
  }

  /** Wait for every usage fetch `extendCooldownFromUsage` started (tests, and a clean exit). */
  async settleUsageFetches(): Promise<void> {
    while (this.pendingUsage.size > 0) await Promise.all([...this.pendingUsage]);
  }

  private async extendFromUsage(
    usage: UsageProvider,
    credentialId: number,
    provider: string,
    request: { baseUrl?: string; modelId?: string },
  ): Promise<void> {
    const started = Date.now();
    const known = this.withDb((db) => {
      const row = readCredentialById(db, credentialId);
      if (row === undefined || row.type !== "oauth" || row.provider !== provider) return undefined;
      return { data: row.data, report: readFreshReport(db, credentialId, started) };
    }, undefined);
    if (known === undefined) return;

    let report: UsageReport | undefined = known.report;
    if (report === undefined) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.usageTimeoutMs);
      timer.unref?.();
      try {
        report = await usage.fetchUsage({
          credentialData: known.data,
          fetch: this.usageFetch ?? globalThis.fetch,
          now: started,
          signal: controller.signal,
          ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
        });
      } finally {
        clearTimeout(timer);
      }
      if (report === undefined) return;
      const fetched = report;
      this.withDb((db) => storeReport(db, credentialId, fetched), undefined);
    }

    const resetAt = usageLimitResetAt(provider, report, Date.now(), request.modelId);
    if (resetAt === undefined) return;
    this.withDb((db) => upsertCooldown(db, credentialId, resetAt, { reason: "usage_limit" }), undefined);
  }

  /**
   * Make an OAuth row's access token read as expired, under the row's refresh
   * lease, so Pi's next auth resolution refreshes it through `modify` (plan
   * D4: a 401 force-refreshes the same row once). Returns whether it did.
   */
  async expireAccessToken(credentialId: number, signal?: AbortSignal): Promise<boolean> {
    const db = openCredentialDb(this.dbPath, { create: false });
    if (db === undefined) return false;
    try {
      return await withLease(db, credentialId, signal, async () => {
        const row = readCredentialById(db, credentialId);
        if (row === undefined || row.disabledCause !== null || row.type !== "oauth") return false;
        const data = JSON.parse(row.data) as Record<string, unknown>;
        data.expires = 0;
        db.prepare("UPDATE credentials SET data = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(data),
          Date.now(),
          credentialId,
        );
        return true;
      });
    } finally {
      db.close();
    }
  }

  /** The Pi credential a row stands for; an `api_key` source that does not resolve reads as absent. */
  private toCredential(row: CredentialRowWithData): Credential | undefined {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      return undefined;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    if (row.type === "oauth") return { ...(data as Record<string, unknown>), type: "oauth" } as Credential;
    const stored = data as Partial<StoredApiKey>;
    if (typeof stored.key !== "string") return undefined;
    const key = resolveKeySource(stored.key, this.env);
    if (key === undefined) return undefined;
    return stored.env !== undefined ? { type: "api_key", key, env: stored.env } : { type: "api_key", key };
  }

  async read(providerId: string, options?: OperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const db = this.burstDb();
    if (db === undefined) return undefined;
    const row = this.activeRow(db, providerId, "read");
    return row === undefined ? undefined : this.toCredential(row);
  }

  /**
   * One entry per provider with an enabled row, typed as selection would pick
   * now (or as its first enabled row when every row is cooling). Never
   * resolves a key source, so never runs a command, and never writes.
   */
  async list(options?: OperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const db = this.burstDb();
    if (db === undefined) return [];
    const providers = db
      .prepare("SELECT DISTINCT provider FROM credentials WHERE disabled_cause IS NULL ORDER BY provider")
      .all() as Array<{ provider: string }>;
    const sessionId = this.currentSessionId();
    const out: CredentialInfo[] = [];
    for (const { provider } of providers) {
      const row =
        selectCredential(db, {
          provider,
          ...(sessionId !== undefined ? { sessionId } : {}),
          fallbackToApiKey: this.fallbackToApiKey(provider),
          peek: true,
        }) ?? listEnabled(db, provider)[0];
      if (row !== undefined) out.push({ providerId: provider, type: row.type });
    }
    return out;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: OperationOptions,
  ): Promise<Credential | undefined> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    const existing = openCredentialDb(this.dbPath, { create: false });
    const active = existing === undefined ? undefined : this.activeRow(existing, providerId, "act");
    if (active === undefined) {
      existing?.close();
      // Nothing stored: this is a login. Only a returned credential creates the file.
      const next = await fn(undefined);
      if (next === undefined) return undefined;
      const db = openCredentialDb(this.dbPath, { create: true })!;
      try {
        upsertCredential(db, providerId, next);
      } finally {
        db.close();
      }
      return next;
    }

    const db = existing!;
    try {
      return await withLease(db, active.id, signal, async () => {
        // Re-read inside the lease: a process that waited sees the token the
        // lease holder just wrote, and Pi's refresh `fn` finds it still valid.
        const fresh = readCredentialById(db, active.id);
        const enabled = fresh !== undefined && fresh.disabledCause === null ? fresh : undefined;
        const current = enabled === undefined ? undefined : this.toCredential(enabled);
        const next = await fn(current);
        if (next === undefined) return current;
        this.writeBack(db, providerId, enabled, current, next);
        return next;
      });
    } finally {
      db.close();
    }
  }

  /**
   * Persist what `fn` returned. A refresh of the same account writes to the
   * same row id and never forks a new one. A credential for a different
   * account or of a different type is a login (Pi's `/login` inside a session)
   * and goes into the pool through `upsertCredential`, so it can neither
   * overwrite another account's row nor turn an `api_key` row into OAuth.
   */
  private writeBack(
    db: CredentialDb,
    providerId: string,
    row: CredentialRowWithData | undefined,
    current: Credential | undefined,
    next: Credential,
  ): void {
    const now = Date.now();
    if (row !== undefined && row.type === "oauth" && next.type === "oauth") {
      const nextIdentity = oauthIdentityKey(providerId, next);
      if (nextIdentity === null || row.identityKey === null || nextIdentity === row.identityKey) {
        db.prepare(
          "UPDATE credentials SET data = ?, identity_key = coalesce(identity_key, ?), updated_at = ? WHERE id = ?",
        ).run(serializeCredentialData(next), nextIdentity, now, row.id);
        return;
      }
    }
    if (row !== undefined && row.type === "api_key" && next.type === "api_key" && current?.type === "api_key") {
      if (next.key === current.key) {
        // Same key: keep the stored source (`$VAR`, `!command`) rather than
        // replacing it with its resolved value; only `env` may change.
        const stored = JSON.parse(row.data) as StoredApiKey;
        const data: StoredApiKey = { key: stored.key };
        const env = next.env ?? stored.env;
        if (env !== undefined) data.env = { ...env } as Record<string, string>;
        db.prepare("UPDATE credentials SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), now, row.id);
        return;
      }
    }
    upsertCredential(db, providerId, next);
  }

  /** Pi's logout: soft-disable the active row with cause `logout`, serialised against `modify` by the lease. */
  async delete(providerId: string, options?: OperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    const db = openCredentialDb(this.dbPath, { create: false });
    if (db === undefined) return;
    try {
      const active = this.activeRow(db, providerId, "act");
      if (active === undefined) return;
      await withLease(db, active.id, options?.signal, async () => {
        db.prepare(
          "UPDATE credentials SET disabled_cause = 'logout', updated_at = ? WHERE id = ? AND disabled_cause IS NULL",
        ).run(Date.now(), active.id);
      });
    } finally {
      db.close();
    }
  }
}
