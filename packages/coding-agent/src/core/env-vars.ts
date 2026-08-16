/**
 * Branded environment variables.
 *
 * phi reads its own `PHI_*` variables — the tool is `phi`, its config lives in
 * `.phi`, and it already shipped `PHI_DEBUG`, `PHI_DISABLE_*` and `PHI_SANDBOX_*`.
 * The inherited `PI_*` names stay accepted as a fallback so a script or shell
 * profile written against upstream pi keeps working, and writers set both.
 *
 * The brand is derived from `APP_NAME`, so a rebranded distribution gets its own
 * prefix without touching call sites.
 *
 * `config.ts` imports this module, so the prefix is read INSIDE the functions and
 * never at module scope: evaluating `APP_NAME` while the cycle is still
 * initialising throws "Cannot access 'APP_NAME' before initialization".
 */

import { APP_NAME } from "../config.ts";

const LEGACY_PREFIX = "PI_";

/** Canonical variable name for a suffix, e.g. "OFFLINE" -> "PHI_OFFLINE". */
export function brandedEnvName(suffix: string): string {
	return `${APP_NAME.toUpperCase()}_${suffix}`;
}

/** Inherited upstream name for a suffix, e.g. "OFFLINE" -> "PI_OFFLINE". */
export function legacyEnvName(suffix: string): string {
	return `${LEGACY_PREFIX}${suffix}`;
}

/** Read `PHI_<suffix>`, falling back to the inherited `PI_<suffix>`. */
export function readBrandedEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[brandedEnvName(suffix)] ?? env[legacyEnvName(suffix)];
}

/** Set both the branded and the inherited name, for values handed to child processes. */
export function setBrandedEnv(env: NodeJS.ProcessEnv, suffix: string, value: string): void {
	env[brandedEnvName(suffix)] = value;
	env[legacyEnvName(suffix)] = value;
}

/** Delete both names, used before repopulating a child environment. */
export function deleteBrandedEnv(env: NodeJS.ProcessEnv, suffix: string): void {
	delete env[brandedEnvName(suffix)];
	delete env[legacyEnvName(suffix)];
}
