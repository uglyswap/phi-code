import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
	type Browser,
	type BrowserContext,
	type BrowserType,
	firefox,
} from "playwright-core";

import { type LaunchOptions, launchOptions, syncAttachVD } from "./utils.ts";
import { VirtualDisplay } from "./virtdisplay.ts";

/**
 * playwright-core range the vendored Camoufox build speaks.
 *
 * Camoufox is a Firefox fork, so playwright drives it over juggler — a protocol
 * versioned with playwright itself, not negotiated at runtime. From 1.61.0
 * playwright sends `Browser.setDefaultViewport` with an `isMobile` field that
 * this Firefox 135 build rejects, and the failure surfaces on the first
 * `newPage()` as `Found property "<root>.viewport.isMobile"` — a message that
 * says nothing about versions. Verified: 1.58.1, 1.59.1 and 1.60.0 work;
 * 1.61.0, 1.61.1, 1.62.0 and 1.62.1 all fail.
 *
 * package.json states the same range so a normal install cannot land outside it;
 * this check exists for the installs that already did.
 */
const SUPPORTED_PLAYWRIGHT = { min: [1, 58, 0], maxExclusive: [1, 61, 0] } as const;

function comparePlaywrightVersion(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
	}
	return 0;
}

/** Report an unusable playwright-core before the launch produces a cryptic protocol error. */
export function assertSupportedPlaywright(version: string | undefined): void {
	// An unreadable version is not a reason to refuse to start.
	const parsed = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!parsed) return;
	const parts = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
	const supported =
		comparePlaywrightVersion(parts, SUPPORTED_PLAYWRIGHT.min) >= 0 &&
		comparePlaywrightVersion(parts, SUPPORTED_PLAYWRIGHT.maxExclusive) < 0;
	if (supported) return;
	throw new Error(
		`playwright-core ${version} cannot drive this Camoufox build: the juggler protocol it speaks ` +
			`does not match Firefox 135. Install playwright-core >=1.58.0 <1.61.0 ` +
			`(the range this package declares), then retry.`,
	);
}

function installedPlaywrightVersion(): string | undefined {
	const require = createRequire(import.meta.url);
	try {
		return require("playwright-core/package.json").version;
	} catch {
		// A package may keep "./package.json" out of its exports map. Falling back
		// to the manifest beside the resolved entry point matters here: without it
		// the check would go quiet on exactly the newer playwright it exists to
		// catch. Walking up covers an entry nested in lib/ or dist/.
		try {
			let dir = dirname(require.resolve("playwright-core"));
			for (let depth = 0; depth < 5; depth++) {
				const manifest = join(dir, "package.json");
				if (existsSync(manifest)) {
					const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as { name?: string; version?: string };
					if (parsed.name === "playwright-core") return parsed.version;
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		} catch {
			// Nothing readable: let the launch proceed and fail on its own terms.
		}
		return undefined;
	}
}

export async function Camoufox<
	UserDataDir extends string | undefined = undefined,
	ReturnType = UserDataDir extends string ? BrowserContext : Browser,
>(
	launch_options: LaunchOptions & { user_data_dir?: UserDataDir } = {},
): Promise<ReturnType> {
	const { headless, user_data_dir, ...launchOptions } = launch_options;
	return NewBrowser(
		firefox,
		headless,
		{},
		user_data_dir ?? false,
		false,
		launchOptions,
	);
}

export async function NewBrowser<
	UserDataDir extends string | false = false,
	ReturnType = UserDataDir extends string ? BrowserContext : Browser,
>(
	playwright: BrowserType<Browser>,
	headless: boolean | "virtual" = false,
	fromOptions: Record<string, any> = {},
	userDataDir: UserDataDir = false as UserDataDir,
	debug: boolean = false,
	launch_options: LaunchOptions = {},
): Promise<ReturnType> {
	assertSupportedPlaywright(installedPlaywrightVersion());

	let virtualDisplay: VirtualDisplay | null = null;

	// Normalize headless to boolean and prepare options for launchOptions function
	const normalizedHeadless: boolean =
		headless === "virtual" ? false : headless || false;

	if (headless === "virtual") {
		virtualDisplay = new VirtualDisplay(debug);
		launch_options.virtual_display = await virtualDisplay.get();
	}

	if (!fromOptions || Object.keys(fromOptions).length === 0) {
		fromOptions = await launchOptions({
			debug,
			...launch_options,
			headless: normalizedHeadless,
		});
	}

	if (typeof userDataDir === "string") {
		const context = await playwright.launchPersistentContext(
			userDataDir,
			fromOptions,
		);
		return syncAttachVD(context, virtualDisplay);
	}

	const browser = await playwright.launch(fromOptions);
	return syncAttachVD(browser, virtualDisplay);
}
