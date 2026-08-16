const PREFER_STRICT_TOOL_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

import { readBrandedEnv } from "./env-vars.ts";

export function areExperimentalFeaturesEnabled(): boolean {
	return readBrandedEnv("EXPERIMENTAL") === "1";
}

export function getExperimentalToolSampling() {
	return areExperimentalFeaturesEnabled() ? PREFER_STRICT_TOOL_SAMPLING : undefined;
}
