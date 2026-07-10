import { APP_NAME } from "../config.js";

// Function name kept as-is (upstream-merge friendly); the emitted UA string
// follows the configured app name ("phi/<version> (...)" for phi-code).
export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `${APP_NAME}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
