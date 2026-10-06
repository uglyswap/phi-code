import fs from "node:fs";
import { join } from "node:path";
import { InvalidAddonPath } from "./exceptions.ts";
import { getPath, unzip, webdl } from "./pkgman.ts";
import { getAsBooleanFromENV } from "./utils.ts";

export const DefaultAddons = {
	/**
	 * Default addons to be downloaded.
	 *
	 * SECURITY: `UBO` resolves to a rolling "latest.xpi" served by
	 * addons.mozilla.org. The archive is fetched over HTTPS and extracted with
	 * no additional checksum/signature verification, so its integrity relies
	 * solely on TLS to addons.mozilla.org. Because AMO serves a moving target,
	 * a static SHA256 pin would break on every uBlock update; pin a specific
	 * versioned xpi URL plus its hash if stronger integrity is required. The
	 * add-on runs inside the launched browser.
	 */
	UBO: "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi",
};

export function confirmPaths(paths: string[]): void {
	/**
	 * Confirms that the addon paths are valid
	 */
	for (const path of paths) {
		if (!fs.existsSync(path) || !fs.lstatSync(path).isDirectory()) {
			throw new InvalidAddonPath(path);
		}
		if (!fs.existsSync(join(path, "manifest.json"))) {
			throw new InvalidAddonPath(
				"manifest.json is missing. Addon path must be a path to an extracted addon.",
			);
		}
	}
}

export async function addDefaultAddons(
	addonsList: string[],
	excludeList: (keyof typeof DefaultAddons)[] = [],
): Promise<void> {
	/**
	 * Adds default addons, minus any specified in excludeList, to addonsList
	 */
	const addons: Record<string, string> = {};
	for (const [name, url] of Object.entries(DefaultAddons)) {
		if (!excludeList.includes(name as keyof typeof DefaultAddons)) {
			// PHI-VENDOR: default addons are optional. After a failed download
			// (typically offline) skip it for a while instead of delaying every
			// launch with retries; `camoufox fetch` still downloads unconditionally.
			if (!isExtractedAddon(getAddonPath(name)) && isDownloadBackedOff(name)) continue;
			addons[name] = url;
		}
	}
	await maybeDownloadAddons(addons, addonsList);
	// Downloads skipped on purpose are not failures.
	if (getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) return;
	for (const name of Object.keys(addons)) {
		recordDownloadOutcome(name, addonsList.includes(getAddonPath(name)));
	}
}

/** PHI-VENDOR: how long a failed default-addon download is not retried at launch. */
export const ADDON_DOWNLOAD_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** PHI-VENDOR: marker file whose mtime records the last failed download of an addon. */
function backoffMarkerPath(addonName: string): string {
	return getPath(join("addons", `.${addonName}.download-failed`));
}

function isDownloadBackedOff(addonName: string): boolean {
	try {
		const age = Date.now() - fs.statSync(backoffMarkerPath(addonName)).mtimeMs;
		// abs(): file mtimes can be a few ms ahead of Date.now(), while a marker far in
		// the future (clock set back) must not block the download forever.
		return Math.abs(age) < ADDON_DOWNLOAD_BACKOFF_MS;
	} catch {
		return false;
	}
}

function recordDownloadOutcome(addonName: string, succeeded: boolean): void {
	const marker = backoffMarkerPath(addonName);
	try {
		if (succeeded) {
			fs.rmSync(marker, { force: true });
		} else {
			fs.mkdirSync(join(marker, ".."), { recursive: true });
			fs.writeFileSync(marker, new Date().toISOString());
			console.error(
				`Skipping ${addonName} download attempts for ${ADDON_DOWNLOAD_BACKOFF_MS / 3_600_000} h; launching without it.`,
			);
		}
	} catch (e) {
		// The backoff is an optimisation: a read-only cache must not break the launch.
		console.error(`Could not update the ${addonName} download backoff marker: ${e}`);
	}
}

/**
 * Downloads and extracts an addon from a given URL to a specified path.
 *
 * SECURITY: the downloaded archive is not checksum- or signature-verified;
 * integrity relies on TLS to the source (see DefaultAddons). Extraction via
 * unzip() (adm-zip) is zip-slip safe, so the residual risk is a tampered
 * add-on if TLS to the source is compromised.
 */
export async function downloadAndExtract(
	url: string,
	extractPath: string,
	name: string,
): Promise<void> {
	// PHI-VENDOR: a single attempt; addons are optional and a failure must not
	// stall the launch (5 retries spaced 5 s apart cost ~25 s offline).
	const buffer = await webdl(url, `Downloading addon (${name})`, false, null, { retries: 1 });
	// PHI-VENDOR: create the target only once the download succeeded, so an
	// offline first launch does not leave an empty addon dir behind.
	fs.mkdirSync(extractPath, { recursive: true });
	await unzip(buffer, extractPath, `Extracting addon (${name})`, false);
}

/** PHI-VENDOR: an addon dir is usable only once extracted (manifest.json present). */
function isExtractedAddon(addonPath: string): boolean {
	return fs.existsSync(join(addonPath, "manifest.json"));
}

/**
 * Returns a path to the addon
 */
function getAddonPath(addonName: string): string {
	return getPath(join("addons", addonName));
}

/**
 * Downloads and extracts addons from a given dictionary to a specified list
 * Skips downloading if the addon is already downloaded
 */
export async function maybeDownloadAddons(
	addons: Record<string, string>,
	addonsList: string[] = [],
): Promise<void> {
	if (getAsBooleanFromENV("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", false)) {
		console.log(
			"Skipping addon download due to PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set!",
		);
		return;
	}

	for (const addonName in addons) {
		const addonPath = getAddonPath(addonName);

		if (isExtractedAddon(addonPath)) {
			addonsList.push(addonPath);
			continue;
		}

		// PHI-VENDOR: a dir without manifest.json is the leftover of an earlier
		// failed download (e.g. offline first launch). Pushing it made every later
		// launch fail with InvalidAddonPath; drop it and retry the download, and
		// never keep a partial extraction, so the failure stays transient.
		// PHI-VENDOR: extract into a private staging dir and publish it with an
		// atomic rename, so concurrent launches never see (or delete) a half
		// extracted addon; the loser of the rename race reuses the winner's copy.
		const stagingPath = `${addonPath}.tmp-${process.pid}-${Date.now()}`;
		try {
			// Re-check right before removing: another launch may have just published it.
			if (!isExtractedAddon(addonPath)) fs.rmSync(addonPath, { recursive: true, force: true });
			await downloadAndExtract(addons[addonName], stagingPath, addonName);
			if (!isExtractedAddon(stagingPath)) {
				throw new Error("archive has no manifest.json");
			}
			try {
				fs.renameSync(stagingPath, addonPath);
			} catch (renameError) {
				if (!isExtractedAddon(addonPath)) throw renameError;
			}
			addonsList.push(addonPath);
		} catch (e) {
			console.error(`Failed to download and extract ${addonName}: ${e}`);
		} finally {
			fs.rmSync(stagingPath, { recursive: true, force: true });
		}
	}
}
