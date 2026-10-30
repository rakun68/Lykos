# Lykos — Speed & Latency Budget Reference

**Companion to:** `docs/reference/telemetry.md`
**Status:** Living reference specification for latency telemetry, harness overheads, and token-as-speed mechanisms.

---

## 0. The Wall-Clock Principles

Empirical measurements established that model time accounts for **92–94%** of wall-clock duration in Lykos sessions, while the harness (container spawn, Node boot, imports, SQLite WAL writes) accounts for only **6–8%**.

> **Amdahl's law rules: A language rewrite cannot meaningfully accelerate Lykos. In this architecture, token reduction *is* the speed optimization.**

Output tokens decode serially (~124 tokens/sec on DeepSeek V4 Flash). Eliminating output fluff, failed edit retries, and prefill cache misses yields multi-second improvements per turn.

---

## 1. Measured Harness Budget

| Component | Measurement | Wall-Clock Overhead |
|---|---|---|
| Container start | Measured 5-run average | ~770 ms per session |
| Bash spawn | Measured host fork/exec | 25–49 ms per call |
| Node boot | Measured process initialization | ~160 ms per process |
| MCP SDK import | `@modelcontextprotocol/sdk` lazy-loaded | ~881 ms once per server process |
| YAML + Zod import | `yaml` lazy-loaded | 266 ms + 198 ms |
| Ledger SQLite write | WAL mode insert benchmark | 0.076 ms per insert (1000 in 76 ms) |

---

## 2. Token Reduction Levers as Speed Mechanisms

- **Output Diet:** Eliminates conversational preamble and boilerplate, directly reducing output decode time by ~12–15%.
- **Edit failures are a latency cost too, and Lykos's answer is a numbered `read` plus exact text replacement (T168, ADR-0031).** A failed edit pays for the patch, the retry and usually a re-read. The earlier lever, per-line content-hash anchoring (`pi-hashline-edit`), is no longer shipped; the seconds-per-avoided-failure figure it was credited with was never measured in this ledger.
- **Prompt Prefix Caching:** Maximizes cache hit ratio (>78%), slashing Time to First Token (TTFT) by bypassing prompt prefill processing.

---

## 3. Latency Metrics in Telemetry

- `latency_ms`: Total elapsed time from call dispatch to completion.
- `ttft_ms`: Time from dispatch to receipt of the initial streaming token.
- `lykos cost --since`: Computes p50 and p95 latency and TTFT percentiles.
