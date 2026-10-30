# Lykos — Model Access: Providers, Authentication, & Accounting

**Companion to:** `docs/reference/telemetry.md`
**Status:** Living reference specification for model providers, authentication mechanisms, and ledger accounting.

---

## 0. The Guiding Principle

> **Lykos is provider-agnostic and authentication-mechanism agnostic.** Whatever way a user has of reaching a model — a metered API key, a subscription, a cloud provider, a gateway, or the vendor's own CLI — Lykos can use it. Where a vendor's sanction for third-party use is unverified, Lykos says so before the first login.

**Reachable is not Priced.** A provider is *reachable* when authentication works. It becomes *priced* only when its per-token rates **and its cache semantics** have been verified from primary provider documentation. A reachable-but-unpriced provider records tokens with a NULL dollar figure and is marked `price_basis = 'unpriced'`.

---

## 1. Access Routes & Ledger Attribution

Every model call records its exact route in `calls.auth_mode`:

| Route | `auth_mode` | Mechanism |
|---|---|---|
| **R1 — Metered Credentials** | `api_key`, `cloud_provider`, `gateway` | User-supplied API keys (Anthropic, DeepSeek, OpenAI) or cloud credentials (Bedrock, Vertex). Billed at published token rates. |
| **R2 — Delegated Authentication** | `oauth_subscription` | `lykos login` OAuth flows where credentials mint via vendor pages and are stored in Lykos's credential store. Honored for every provider Lykos ships a login for, plus Radius through Pi. Where a vendor's sanction for third-party use is unverified, `lykos login` warns before the first login. |
| **R3 — Vendor CLI Adapter** | `vendor_cli` | Driving the vendor's unmodified CLI (e.g. its MCP server mode) as an external process. |

---

## 2. Ledger `price_basis` Values

The ledger attributes cost basis per call to avoid corrupting financial reporting:

- `api_list`: Metered calls priced at primary published rates from `prices.yaml`.
- `plan_credit`: Drawn from a subscription credit pool denominated at API rates. **No verified plan-denominated pool exists yet** — `oauth_subscription` calls record `api_list` when priced, never `plan_credit`, until one is verified.
- `unpriced`: Calls through reachable providers lacking verified primary pricing or cache semantics. Dollars are stored as `NULL` (never $0.00).

`lykos cost` refuses to sum across different price bases or average cache metrics across providers with differing cache semantics.

---

## 3. The Credential Boundary

> **Lykos holds the credentials a user gives it through its own login, and never reads another product's.** ADR-0025 supersedes the earlier rule that Lykos stored no credentials at all.

- **The credential store.**
  - **Location:** a user-level SQLite database under the home `.lykos` directory, never inside a workspace.
  - **Protection:** plaintext, mode 0600 where the platform honours it.
  - **How Pi reaches it:** injected into Pi as its `CredentialStore`. Pi no longer reads `~/.pi/agent/auth.json`.
- **Pools and rotation.** A provider's credentials form a **credential pool**. **Rotation** spreads sessions across it and **cooldown** rests a credential that hit a limit. A subscription pool falls back to metered API keys only when `providers.<id>.fallbackToApiKey` is set.
- **Key sources.** A stored API key is a literal, `$ENV_VAR`, or `!command`. `config.yaml` rejects literals.
- **Where secrets never go.** No token or secret is persisted to a workspace `.lykos/`, written to `transcript.jsonl`, or recorded in the ledger. The ledger records a credential's non-secret label in `calls.credential_label`.
- **Redaction.** `redact.ts` scrubs credentials before any persistence occurs.
- **Extensions.** An extension sees only the credential the session is using, never the pool.
- **Doctor.** `lykos doctor` reports credential pool counts per provider. It never inspects or prints credential *content*.

---

## 4. Specialist Providers & Authentication Failures

A specialist declares a provider by **name**, never a credential. This keeps specialist files shareable and portable across machines.

### Missing or Unconfigured Provider at Session Start

A specialist's `provider:` is accepted when the provider is in `providers:`, has its env var set, or has a `lykos login` in the pool. When a specialist declares a provider that is unconfigured or lacks usable credentials, Lykos fails at **session start** before any API call is made or budget is spent:

- **Unconfigured Provider:** If the requested provider is neither declared in `config.yaml`, recognized as a built-in provider, nor present in the credential pool, Lykos halts immediately with a `SpecialistValidationError`. The message names the specialist, the requested provider, and lists the configured and logged-in providers:
  `lykos: specialist "<name>" (<path>) is invalid — provider "<bad-provider>" is not configured — configured providers: <list> — logged-in providers: <list>`
- **Unset Credential:** If the provider is known but has no usable credential, Lykos says so. Its credential pool is empty, or its only source is an unset environment variable, which Lykos names:
  `lykos: specialist "<name>" (<path>) is invalid — provider "<provider>" has no usable credential (<VAR> not set) — configured providers: <list> — logged-in providers: <list>`
- **Non-specialist Empty Pool:** When no specialist declares a provider and the host provider lacks a usable credential or pool:
  `lykos: provider "<provider>" has no usable credential (<reason>) — run \`lykos login <provider>\``

### Present-but-Rejected Credentials (Authentication Failure)

An unconfigured provider is distinct from an **authentication failure**:

- An authentication failure happens when the credential was present in the environment or configuration, but the provider's API rejected it at call time (e.g. invalid key or revoked permissions).
- A refused credential in a pool with other usable credentials triggers **rotation**, not an error. The failure is reported only when every credential in the pool has been refused. It names the provider and the label, or the environment variable, of each refused credential:
  `lykos: authentication failure for provider "<provider>" — credential in <VAR> was present and refused`
  `lykos: authentication failure for provider "<provider>" — credentials <label1>, <label2> were present and refused (first error: <original errorMessage>)`
  (singular `credential <label> was` for one).
- Authentication failure messages never use the words "specialist" or "not found", clearly distinguishing bad credentials from configuration typos.
