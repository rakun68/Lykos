import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.LYKOS_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.LYKOS_EXPERIMENTAL;
		} else {
			process.env.LYKOS_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when LYKOS_EXPERIMENTAL is unset", () => {
		delete process.env.LYKOS_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when LYKOS_EXPERIMENTAL is empty", () => {
		process.env.LYKOS_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when LYKOS_EXPERIMENTAL is set to 1", () => {
		process.env.LYKOS_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when LYKOS_EXPERIMENTAL is set to 0", () => {
		process.env.LYKOS_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when LYKOS_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.LYKOS_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
