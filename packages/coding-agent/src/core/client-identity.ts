import { type ClientIdentity, LYKOS_ATTRIBUTION } from "@lykos/ai";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * How lykos's requests identify it to providers: a detailed `User-Agent` with lykos's version, and attribution to lykos as a
 * CLI agent while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager) ? LYKOS_ATTRIBUTION : null,
	};
}
