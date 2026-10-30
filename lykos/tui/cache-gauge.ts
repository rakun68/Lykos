// T121: the provider only proves a cache hit after a call returns.  This
// module keeps that fact per model and marks the gap honestly when a provider
// has no contractual TTL.

export interface CacheObservation {
  model: string;
  cacheRead: number;
  cacheWrite: number;
  atUtc: string;
  ttlSeconds?: number;
}

export interface CacheGaugeEntry {
  model: string;
  cachedTokens: number;
  writtenTokens: number;
  ageSeconds: number;
  pct: number | null;
  status: "fresh" | "stale" | "unknown";
}

export function deriveCacheGauge(
  observations: readonly CacheObservation[],
  now = new Date(),
  activeModel?: string,
): CacheGaugeEntry[] {
  const byModel = new Map<string, CacheObservation>();
  for (const observation of observations) byModel.set(observation.model, observation);
  if (activeModel !== undefined && !byModel.has(activeModel)) {
    byModel.set(activeModel, {
      model: activeModel,
      cacheRead: 0,
      cacheWrite: 0,
      atUtc: now.toISOString(),
    });
  }
  return [...byModel.values()].map((observation) => {
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(observation.atUtc)) / 1000));
    const knownTtl = observation.ttlSeconds !== undefined;
    const status: CacheGaugeEntry["status"] = !knownTtl ? "unknown" : ageSeconds <= observation.ttlSeconds! ? "fresh" : "stale";
    const denominator = observation.cacheRead + observation.cacheWrite;
    return {
      model: observation.model,
      cachedTokens: observation.cacheRead,
      writtenTokens: observation.cacheWrite,
      ageSeconds,
      pct: denominator > 0 ? observation.cacheRead / denominator : null,
      status,
    };
  }).sort((a, b) => (a.model === activeModel ? -1 : b.model === activeModel ? 1 : a.model.localeCompare(b.model)));
}
