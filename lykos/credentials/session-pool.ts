// The session credential selector's logic.
//
// `/credential` in the TUI lists the current provider's pool, pins one row to
// the session through ticket 05's `pinCredential`, or removes the pin. It
// lives here, not in `tui/`, because it reads the credential db; the surface
// only prints what these functions return. Nothing here returns a secret.

import { activeCooldowns, openCredentialDb } from "./db.js";
import { listEnabled } from "./pool.js";
import { lastServedCredential } from "./rotate.js";
import { pinCredential, pinnedCredentialId, selectCredential, unpinCredential } from "./select.js";

export interface SessionPoolEntry {
  id: number;
  label: string;
  type: "oauth" | "api_key";
  /** Epoch ms the row's cooldown ends; absent when it is not cooling. */
  coolingUntil?: number;
  /** The row serving this session: the pin, else the last row that served, else what selection would pick now. */
  serving: boolean;
  pinned: boolean;
}

export interface SessionPoolInput {
  dbPath: string;
  sessionId: string;
  provider: string;
  /** `providers.<id>.fallbackToApiKey`. */
  fallbackToApiKey?: boolean;
  now?: number;
}

/** The provider's enabled pool as this session sees it. Empty when nothing is stored. */
export function describeSessionPool(input: SessionPoolInput): SessionPoolEntry[] {
  const db = openCredentialDb(input.dbPath, { create: false });
  if (db === undefined) return [];
  try {
    const now = input.now ?? Date.now();
    const rows = listEnabled(db, input.provider);
    const cooling = new Map<number, number>();
    for (const c of activeCooldowns(db, now)) {
      cooling.set(c.credentialId, Math.max(cooling.get(c.credentialId) ?? 0, c.untilMs));
    }
    const pinned = pinnedCredentialId(db, input.sessionId, input.provider);
    const servingId =
      (pinned !== undefined && rows.some((r) => r.id === pinned) ? pinned : undefined) ??
      lastServedCredential(input.sessionId, input.provider)?.id ??
      selectCredential(db, {
        provider: input.provider,
        sessionId: input.sessionId,
        now,
        fallbackToApiKey: input.fallbackToApiKey === true,
        peek: true,
      })?.id;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      ...(cooling.has(r.id) ? { coolingUntil: cooling.get(r.id)! } : {}),
      serving: r.id === servingId,
      pinned: r.id === pinned,
    }));
  } finally {
    db.close();
  }
}

/** The bare `/credential` listing: one line per row, `*` on the serving row. */
export function formatSessionPool(provider: string, entries: readonly SessionPoolEntry[]): string {
  if (entries.length === 0) {
    return `no credentials stored for ${provider} — /login ${provider} adds one`;
  }
  const lines = [`credentials for ${provider} (* serves this session)`];
  for (const e of entries) {
    const state = e.coolingUntil !== undefined ? `cooling until ${new Date(e.coolingUntil).toISOString()}` : "ready";
    lines.push(`  ${e.serving ? "*" : " "} ${e.label}  ${e.type}  ${state}${e.pinned ? "  pinned" : ""}`);
  }
  lines.push("  /credential <label> pins one to this session; /credential auto returns to automatic selection");
  return lines.join("\n");
}

export type PinResult = { ok: true; message: string } | { ok: false; message: string };

/** `/credential <label>`: pin the provider's enabled row with that label to this session. */
export function pinSessionCredential(input: SessionPoolInput & { label: string }): PinResult {
  const db = openCredentialDb(input.dbPath, { create: false });
  if (db === undefined) return { ok: false, message: `no credentials stored for ${input.provider}` };
  try {
    const rows = listEnabled(db, input.provider);
    const row = rows.find((r) => r.label === input.label);
    if (row === undefined) {
      const labels = rows.map((r) => r.label).join(", ");
      return {
        ok: false,
        message:
          rows.length === 0
            ? `no credentials stored for ${input.provider}`
            : `${input.provider} has no credential labelled "${input.label}"; its labels are ${labels}`,
      };
    }
    pinCredential(db, input.sessionId, input.provider, row.id);
    return { ok: true, message: `pinned ${input.provider} ${row.label} to this session` };
  } finally {
    db.close();
  }
}

/** `/credential auto`: remove this session's pin for the provider. */
export function unpinSessionCredential(input: SessionPoolInput): PinResult {
  const db = openCredentialDb(input.dbPath, { create: false });
  if (db === undefined) return { ok: true, message: `${input.provider} was not pinned; selection is automatic` };
  try {
    return unpinCredential(db, input.sessionId, input.provider)
      ? { ok: true, message: `${input.provider} credential selection is automatic again` }
      : { ok: true, message: `${input.provider} was not pinned; selection is automatic` };
  } finally {
    db.close();
  }
}
