import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "playwright-core";
import { describe, expect, test } from "vitest";
import { Camoufox, launchServer } from "../src";
import { existsSync } from "node:fs";
import { getPath, LAUNCH_FILE, OS_NAME } from "../src/pkgman";

let camoufoxInstalled = false;
try {
	camoufoxInstalled = existsSync(getPath(LAUNCH_FILE[OS_NAME]));
} catch {
	camoufoxInstalled = false;
}

const TEST_CASES = [
	{ os: "linux" as const, userAgentRegex: /Linux/i },
	{ os: "windows" as const, userAgentRegex: /Windows/i },
	{ os: "macos" as const, userAgentRegex: /Mac OS/i },
];

/**
 * Timeouts.
 *
 * Measured on a Windows host: launching Camoufox (a Firefox fork) takes ~4 s and
 * opening the first page ~5 s more — 9 s before any navigation happens. The
 * original 10 s budget therefore expired during setup on every case, which read
 * as "Camoufox is broken" when it launches and drives pages perfectly.
 *
 * Budgets are named after what the test actually does so a slower machine (or a
 * cold binary cache) does not turn the suite flaky again.
 */
const ONE_BROWSER_MS = 45_000;
const TWO_BROWSERS_MS = 90_000;


describe.skipIf(process.platform !== "linux" || !camoufoxInstalled)("virtual display", () => {
	test("should launch", async () => {
		const browser = await Camoufox({
			os: "linux",
			headless: "virtual",
		});

		const page = await browser.newPage();
		await page.goto("https://api.apify.com/v2/browser-info");
		const userAgent = await page.evaluate(() => navigator.userAgent.toString());
		expect(userAgent).toMatch(/Linux/i);
		await browser.close();
	}, ONE_BROWSER_MS);

	test("multiple browsers spawn own virtual displays", async () => {
		const browser1 = await Camoufox({
			os: "linux",
			headless: "virtual",
		});

		const browser2 = await Camoufox({
			os: "linux",
			headless: "virtual",
		});

		expect(browser1).not.toBe(browser2);

		await browser1.close();

		const page = await browser2.newPage();
		await page.goto("https://api.apify.com/v2/browser-info");
		await browser2.close();
	}, ONE_BROWSER_MS);

	test("should support combining headless virtual with other launch options", async () => {
		// This test validates the fix for the type signature issue
		// Previously, TypeScript would error when combining headless: "virtual" with other options
		const browser = await Camoufox({
			os: "linux",
			headless: "virtual",
			// These options were not accessible with the old type signature
			block_images: true,
			humanize: true,
		});

		const page = await browser.newPage();
		await page.goto("https://api.apify.com/v2/browser-info");
		const userAgent = await page.evaluate(() => navigator.userAgent.toString());
		expect(userAgent).toMatch(/Linux/i);
		await browser.close();
	}, ONE_BROWSER_MS);
});

describe.skipIf(!camoufoxInstalled)("Fingerprint consistency", () => {
	test.each(TEST_CASES)("User-Agent matches set OS ($os)", async ({
		os,
		userAgentRegex,
	}) => {
		const browser = await Camoufox({
			os,
			headless: true,
		});

		const page = await browser.newPage();

		await page.goto("https://api.apify.com/v2/browser-info");

		const data = await page.evaluate(() =>
			JSON.parse(document.querySelector("pre")?.textContent ?? ""),
		);
		const httpAgent = data.headers["user-agent"];
		const jsAgent = await page.evaluate(() => navigator.userAgent.toString());

		expect(httpAgent).toEqual(jsAgent);
		expect(httpAgent).toMatch(userAgentRegex);

		TEST_CASES.forEach(({ os: testOs, userAgentRegex }) => {
			if (testOs !== os) {
				expect(httpAgent).not.toMatch(userAgentRegex);
			}
		});

		await browser.close();
	}, ONE_BROWSER_MS);
});

test("Playwright connects to Camoufox server", async () => {
	const server = await launchServer({
		headless: true,
	});

	const browser = await firefox.connect(server.wsEndpoint());
	const page = await browser.newPage();
	await page.goto("https://api.apify.com/v2/browser-info");

	const userAgent = await page.evaluate(() => navigator.userAgent.toString());
	expect(userAgent).toMatch(/Firefox/);
	await browser.close();

	await server.close();
}, TWO_BROWSERS_MS);

test("Persistent context works", async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), "user_data_"));

	{
		const context = await Camoufox({
			user_data_dir: userDataDir,
			headless: true,
		});

		const page = await context.newPage();
		await page.goto("https://example.com");

		await page.evaluate(() => {
			document.cookie =
				"name=value; path=/; domain=example.com; expires=Fri, 31 Dec 9999 23:59:59 GMT";
		});
		await page.close();
		await context.close();
	}

	let readCookies: any = null;

	{
		const context = await Camoufox({
			user_data_dir: userDataDir,
			headless: true,
		});

		const page = await context.newPage();
		await page.goto("https://example.com");

		readCookies = await page.evaluate(() => {
			const cookies = document.cookie
				.split("; ")
				.reduce<Record<string, string>>((acc, cookie) => {
					const [name, value] = cookie.split("=");
					acc[name] = value;
					return acc;
				}, {});
			return cookies;
		});

		await page.close();
		await context.close();
	}

	expect(readCookies).toEqual({ name: "value" });
}, TWO_BROWSERS_MS);

describe.skipIf(!camoufoxInstalled)("Fingerprint injection", () => {
	test("custom window size is applied", async () => {
		const browser = await Camoufox({
			headless: true,
			window: [1280, 720],
		});

		const page = await browser.newPage();

		const dimensions = await page.evaluate(() => ({
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
		}));

		expect(dimensions.outerWidth).toBe(1280);
		expect(dimensions.outerHeight).toBe(720);

		await browser.close();
	}, ONE_BROWSER_MS);

	test("fingerprint differs between launches", async () => {
		const getFingerprint = async () => {
			const browser = await Camoufox({ headless: true });
			const page = await browser.newPage();
			const fp = await page.evaluate(() => ({
				ua: navigator.userAgent,
				cores: navigator.hardwareConcurrency,
				screenW: screen.width,
				screenH: screen.height,
				outerW: window.outerWidth,
				outerH: window.outerHeight,
			}));
			await browser.close();
			return fp;
		};

		const fp1 = await getFingerprint();
		const fp2 = await getFingerprint();

		// With this many properties, a full collision is virtually impossible
		const identical = Object.keys(fp1).every(
			(k) => fp1[k as keyof typeof fp1] === fp2[k as keyof typeof fp2],
		);
		expect(identical).toBe(false);
	}, TWO_BROWSERS_MS);

	test("screen dimensions are spoofed", async () => {
		const browser = await Camoufox({
			headless: true,
			screen: { maxWidth: 1920, maxHeight: 1080 },
		});

		const page = await browser.newPage();

		const screen = await page.evaluate(() => ({
			width: window.screen.width,
			height: window.screen.height,
		}));

		expect(screen.width).toBeGreaterThan(0);
		expect(screen.width).toBeLessThanOrEqual(1920);
		expect(screen.height).toBeGreaterThan(0);
		expect(screen.height).toBeLessThanOrEqual(1080);

		await browser.close();
	}, ONE_BROWSER_MS);

	test("hardwareConcurrency is spoofed", async () => {
		const browser = await Camoufox({
			headless: true,
		});

		const page = await browser.newPage();
		const cores = await page.evaluate(() => navigator.hardwareConcurrency);
		expect(cores).toBeGreaterThan(0);
		expect(Number.isInteger(cores)).toBe(true);

		await browser.close();
	}, ONE_BROWSER_MS);

	test("locale option overrides Intl locale", async () => {
		const browser = await Camoufox({
			headless: true,
			locale: "fr-FR",
			i_know_what_im_doing: true,
		});

		const page = await browser.newPage();

		const locale = await page.evaluate(
			() => Intl.DateTimeFormat().resolvedOptions().locale,
		);
		expect(locale).toBe("fr-FR");

		const language = await page.evaluate(() => navigator.language);
		expect(language).toMatch(/^fr/);

		await browser.close();
	}, ONE_BROWSER_MS);

	test("WebGL is blocked when block_webgl is true", async () => {
		const browser = await Camoufox({
			headless: true,
			block_webgl: true,
			i_know_what_im_doing: true,
		});

		const page = await browser.newPage();

		const hasWebGL = await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			return !!(canvas.getContext("webgl") || canvas.getContext("webgl2"));
		});

		expect(hasWebGL).toBe(false);

		await browser.close();
	}, ONE_BROWSER_MS);

	test("WebRTC is blocked when block_webrtc is true", async () => {
		const browser = await Camoufox({
			headless: true,
			block_webrtc: true,
		});

		const page = await browser.newPage();

		const hasWebRTC = await page.evaluate(
			() => typeof window.RTCPeerConnection,
		);
		expect(hasWebRTC).toBe("undefined");

		await browser.close();
	}, ONE_BROWSER_MS);
});
