import fs from "node:fs";
import { join } from "node:path";
import { InvalidAddonPath } from "./exceptions.js";
import { getPath, unzip, webdl } from "./pkgman.js";
import { getAsBooleanFromENV } from "./utils.js";

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
			addons[name] = url;
		}
	}
	await maybeDownloadAddons(addons, addonsList);
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
	const buffer = await webdl(url, `Downloading addon (${name})`, false);
	await unzip(buffer, extractPath, `Extracting addon (${name})`, false);
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

		if (fs.existsSync(addonPath)) {
			addonsList.push(addonPath);
			continue;
		}

		try {
			fs.mkdirSync(addonPath, { recursive: true });
			await downloadAndExtract(addons[addonName], addonPath, addonName);
			addonsList.push(addonPath);
		} catch (e) {
			console.error(`Failed to download and extract ${addonName}: ${e}`);
		}
	}
}
