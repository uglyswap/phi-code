import { APP_NAME } from "../config.ts";

// Function name kept as-is (upstream-merge friendly); the emitted UA string
// follows the configured app name ("phi/<version> (...)" for phi-code).
export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `${APP_NAME}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

/**
 * Upstream pi release whose model schema phi-code's model layer (phi-code-ai) implements.
 * Keep it equal to the phi-code-ai package version: bump it when an upstream merge moves
 * the internal packages (a regression test compares the two).
 */
export const PI_MODEL_CATALOG_COMPAT_VERSION = "0.84.2";

/**
 * User-Agent for the pi.dev model catalog (`/api/models/providers/<id>`).
 *
 * pi.dev only serves a schema-compatible catalog revision to clients whose User-Agent
 * matches `pi/<version> (...)` (pi scripts/model-catalog-protocol.ts): it redirects them
 * to `?pi-version=<version>` and picks the newest revision whose minimumPiVersion does
 * not exceed it. Any other User-Agent, including `phi/<version>`, gets the latest
 * revision, whose schema may be newer than what phi-code-ai understands. Announcing the
 * upstream base version (never phi's own 0.99.x, which pi.dev would read as a newer pi)
 * selects the revision phi was built against. phi stays identifiable in the comment part,
 * which the protocol's pattern accepts.
 */
export function getModelCatalogUserAgent(appVersion: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pi/${PI_MODEL_CATALOG_COMPAT_VERSION} (${process.platform}; ${runtime}; ${process.arch}; ${APP_NAME}/${appVersion})`;
}
