import { describe, expect, it } from "vitest";
import { getLykosUserAgent } from "../src/utils/lykos-user-agent.ts";

describe("getLykosUserAgent", () => {
	it("formats the user agent expected by lykos.local", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getLykosUserAgent("1.2.3");

		expect(userAgent).toBe(`lykos/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^lykos\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
