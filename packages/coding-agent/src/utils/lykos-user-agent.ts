import { formatUserAgent } from "@lykos/ai";

/** lykos's `User-Agent` for its own network requests; the same detailed form lykos-ai sends to providers. */
export function getLykosUserAgent(version: string): string {
	return formatUserAgent({ userAgent: "detailed", version });
}
