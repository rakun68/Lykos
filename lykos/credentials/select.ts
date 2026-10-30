// Credential selection (ADR-0026).
//
// A session starts at `xxHash32(sessionId) % n`, keeps that credential
// (sticky, persisted), and round-robins when there is no session id. OAuth
// rows go first and API-key rows are reachable only when the provider
// has no OAuth row or `fallbackToApiKey` is set (ADR-0026), and `n` counts the
// usable rows of the chosen type rather than every row (plan D2).

import type { CredentialDb } from "./db.js";
import { type CredentialRowWithData, type CredentialType, listEnabledWithData } from "./pool.js";
import { readCachedReport } from "./usage/cache.js";
import { hasRankingStrategy, planRequirementFor, rankByUsage } from "./usage/rank.js";
import { xxHash32 } from "./xxhash32.js";

/**
 * Anthropic's OAuth prompt cache lives at most an hour, so a sticky choice idle
 * longer than this no longer holds the session. Other providers stay sticky.
 */
export const ANTHROPIC_STICKY_WARM_MS = 60 * 60_000;

export interface SelectCredentialInput {
  provider: string;
  sessionId?: string;
  /** Defaults to `Date.now()`. */
  now?: number;
  /** `providers.<id>.fallbackToApiKey` from config.yaml. Unset means false (ADR-0026). */
  fallbackToApiKey?: boolean;
  /** Rows already tried by the request in flight; never chosen again. */
  exclude?: ReadonlySet<number>;
  /** Look without writing the sticky row or advancing the round-robin counter. */
  peek?: boolean;
  /**
   * The model the request is for, when known (rotation knows it; Pi's bare
   * `read` does not). Scopes usage ranking:
   * a Codex plan requirement, the Spark meter, a Claude model family.
   */
  modelId?: string;
}

interface StickyRow {
  credentialId: number;
  updatedAt: number;
  pinned: number;
}

/** In-process round-robin position per `provider:type`. */
const roundRobin = new Map<string, number>();

function nextRoundRobin(key: string, total: number, peek: boolean): number {
  if (total <= 1) return 0;
  const current = roundRobin.get(key) ?? -1;
  const next = (current + 1) % total;
  if (!peek) roundRobin.set(key, next);
  return next;
}

export function hashedIndex(sessionId: string, total: number): number {
  if (total <= 1) return 0;
  return xxHash32(sessionId) % total;
}

function readSticky(db: CredentialDb, sessionId: string, provider: string): StickyRow | undefined {
  return db
    .prepare(
      `SELECT credential_id AS credentialId, updated_at AS updatedAt, pinned FROM sticky
       WHERE session_id = ? AND provider = ?`,
    )
    .get(sessionId, provider) as StickyRow | undefined;
}

function touchSticky(db: CredentialDb, sessionId: string, provider: string, now: number): void {
  db.prepare("UPDATE sticky SET updated_at = ? WHERE session_id = ? AND provider = ?").run(now, sessionId, provider);
}

/** Persist a selection. Never overwrites a pin. */
function writeSticky(db: CredentialDb, sessionId: string, provider: string, credentialId: number, now: number): void {
  db.prepare(
    `INSERT INTO sticky (session_id, provider, credential_id, updated_at, pinned) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(session_id, provider) DO UPDATE SET credential_id = excluded.credential_id, updated_at = excluded.updated_at
     WHERE sticky.pinned = 0`,
  ).run(sessionId, provider, credentialId, now);
}

/** Ids of every credential with a cooldown still in force at `now`, whatever its scope. */
export function coolingIds(db: CredentialDb, now: number): Set<number> {
  const rows = db.prepare("SELECT DISTINCT credential_id AS id FROM cooldowns WHERE until_ms > ?").all(now) as Array<{
    id: number;
  }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * The rows a request could still reach, in the order selection would consider
 * them: usable OAuth rows, then usable API-key rows when the provider has no
 * enabled OAuth row or `fallbackToApiKey` is set. Usable = enabled, not
 * cooling, not excluded. Rotation caps its attempts at this count.
 */
export function reachableRows(db: CredentialDb, input: SelectCredentialInput): CredentialRowWithData[] {
  const now = input.now ?? Date.now();
  const enabled = listEnabledWithData(db, input.provider);
  const cooling = coolingIds(db, now);
  const usable = enabled.filter((r) => !cooling.has(r.id) && !(input.exclude?.has(r.id) ?? false));
  const oauthUsable = usable.filter((r) => r.type === "oauth");
  const hasOAuth = enabled.some((r) => r.type === "oauth");
  const apiKeysAllowed = !hasOAuth || input.fallbackToApiKey === true;
  const apiUsable = apiKeysAllowed ? usable.filter((r) => r.type === "api_key") : [];
  return [...oauthUsable, ...apiUsable];
}

/**
 * The credential a session uses for a provider, or undefined when none may
 * serve it. Order of precedence:
 *
 * 1. A per-session pin whose row is still enabled, even while cooling. A pin
 *    that is excluded (already tried by this request) yields undefined: the
 *    user chose that account, so rotation never moves off it.
 * 2. Within the first type that has a usable row (OAuth, then API key when
 *    allowed), the session's sticky row if it is among them and, for
 *    `anthropic`, was used within the last hour (and the model has no Codex
 *    plan requirement).
 * 3. Else the usable rows of that type starting at `xxHash32(sessionId) % n`
 *    (round-robin with no session id); for OAuth rows of a provider with a
 *    usage strategy and at least one cached report, reordered by usage
 *    (ticket 09, plan D3). The first is persisted as the sticky row.
 */
export function selectCredential(db: CredentialDb, input: SelectCredentialInput): CredentialRowWithData | undefined {
  const now = input.now ?? Date.now();
  const { provider, sessionId } = input;
  const peek = input.peek === true;
  const sticky = sessionId !== undefined ? readSticky(db, sessionId, provider) : undefined;

  if (sticky !== undefined && sticky.pinned === 1) {
    const pinned = listEnabledWithData(db, provider).find((r) => r.id === sticky.credentialId);
    if (pinned !== undefined) {
      if (input.exclude?.has(pinned.id)) return undefined;
      if (!peek) touchSticky(db, sessionId!, provider, now);
      return pinned;
    }
  }

  const reachable = reachableRows(db, { ...input, now });
  if (reachable.length === 0) return undefined;
  const type: CredentialType = reachable[0]!.type;
  const candidates = reachable.filter((r) => r.type === type);

  // Cached usage reports, read only for OAuth rows of a provider with a
  // ranking strategy (plan D3). Selection never fetches one.
  const rankable = type === "oauth" && hasRankingStrategy(provider);
  const reports = new Map(candidates.map((r) => [r.id, rankable ? readCachedReport(db, r.id)?.report : undefined]));
  const hasReports = [...reports.values()].some((r) => r !== undefined);
  // A Codex model with a plan
  // requirement ranks even over a warm sticky row (only once a report exists
  // to rank on; with none, the sticky row holds as in ticket 05).
  const planRequired = planRequirementFor(provider, input.modelId) !== "none";
  let coldSticky: number | undefined;
  if (sticky !== undefined && sessionId !== undefined) {
    const warm = provider !== "anthropic" || now - sticky.updatedAt <= ANTHROPIC_STICKY_WARM_MS;
    const stuck = candidates.find((r) => r.id === sticky.credentialId);
    if (stuck !== undefined && warm && !(planRequired && hasReports)) {
      if (!peek) touchSticky(db, sessionId, provider, now);
      return stuck;
    }
    // Idle past the Anthropic warmth window: the sticky row is re-ranked, and
    // (when usage data exists) wins only genuine ties.
    if (stuck !== undefined && !warm) coldSticky = stuck.id;
  }

  const start =
    sessionId !== undefined
      ? hashedIndex(sessionId, candidates.length)
      : nextRoundRobin(`${provider}:${type}`, candidates.length, peek);
  let ordered = [...candidates.slice(start), ...candidates.slice(0, start)];

  // Plan D3: among usable OAuth rows, rank by cached usage reports (never a
  // fetch). With no report the order stays ticket 05's hashed start.
  if (hasReports && (ordered.length > 1 || planRequired)) {
    // A cold sticky row goes first so it wins genuine ties.
    if (coldSticky !== undefined && !planRequired) {
      ordered = [...ordered.filter((r) => r.id === coldSticky), ...ordered.filter((r) => r.id !== coldSticky)];
    }
    const ids = rankByUsage(
      provider,
      ordered.map((r) => ({ id: r.id, report: reports.get(r.id) })),
      { nowMs: now, ...(input.modelId !== undefined ? { modelId: input.modelId } : {}) },
    );
    const byId = new Map(ordered.map((r) => [r.id, r]));
    ordered = ids.map((id) => byId.get(id)!);
  }
  const chosen = ordered[0]!;
  if (!peek && sessionId !== undefined) writeSticky(db, sessionId, provider, chosen.id, now);
  return chosen;
}

/**
 * Pin a credential to a session (ticket 06 builds the selector). The pin
 * overrides selection while its row is enabled, even when the row is cooling.
 */
export function pinCredential(db: CredentialDb, sessionId: string, provider: string, credentialId: number): void {
  db.prepare(
    `INSERT INTO sticky (session_id, provider, credential_id, updated_at, pinned) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(session_id, provider) DO UPDATE SET credential_id = excluded.credential_id,
       updated_at = excluded.updated_at, pinned = 1`,
  ).run(sessionId, provider, credentialId, Date.now());
}

/**
 * Remove a session's pin (ticket 06, `/credential auto`). The row stays as an
 * ordinary sticky choice, so automatic selection resumes from the account the
 * session was using, and re-ranks as usual when that row cools. Returns
 * whether a pin was removed.
 */
export function unpinCredential(db: CredentialDb, sessionId: string, provider: string): boolean {
  return (
    db
      .prepare("UPDATE sticky SET pinned = 0, updated_at = ? WHERE session_id = ? AND provider = ? AND pinned = 1")
      .run(Date.now(), sessionId, provider).changes === 1
  );
}

/** The credential pinned to this session for this provider, if any, whatever its state. */
export function pinnedCredentialId(db: CredentialDb, sessionId: string, provider: string): number | undefined {
  const sticky = readSticky(db, sessionId, provider);
  return sticky !== undefined && sticky.pinned === 1 ? sticky.credentialId : undefined;
}
