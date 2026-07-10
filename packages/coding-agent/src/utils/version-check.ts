import { PACKAGE_NAME } from "../config.js";
import { getPiUserAgent } from "./pi-user-agent.js";

// Version checks query the npm registry for the published phi-code package.
// (The inherited flow queried pi.dev, the upstream Pi endpoint, which reported
// upstream Pi releases and made "Update Available" fire for versions of the
// wrong product.)
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestRelease {
	version: string;
	packageName?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const response = await fetch(`${NPM_REGISTRY_URL}/${PACKAGE_NAME}/latest`, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as { name?: unknown; version?: unknown };
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
	return { version: data.version.trim(), packageName };
}

export async function getLatestVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestRelease(currentVersion, options))?.version;
}

export async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	try {
		const latestVersion = await getLatestVersion(currentVersion);
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
