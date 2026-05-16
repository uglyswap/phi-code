import { execSync } from "node:child_process";
import type { PathLike } from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import cliProgress, { Options } from "cli-progress";
import prettyBytes from "pretty-bytes";
import { CONSTRAINTS } from "./__version__.js";
import {
	CamoufoxNotInstalled,
	FileNotFoundError,
	MissingRelease,
	UnsupportedArchitecture,
	UnsupportedOS,
	UnsupportedVersion,
} from "./exceptions.js";

const ARCH_MAP: { [key: string]: string } = {
	x64: "x86_64",
	ia32: "i686",
	arm64: "arm64",
	arm: "arm64",
};

const OS_MAP: { [key: string]: "mac" | "win" | "lin" } = {
	darwin: "mac",
	linux: "lin",
	win32: "win",
};

/**
 * PHI-VENDOR: When `true`, allow the upstream `daijro/camoufox` releases
 * API fallback path. When `false` (default), only the phi-code re-hosted
 * binary cache (`~/.cache/phi-code/camoufox/v1.0.0/`) is used. Set
 * `CAMOUFOX_ALLOW_GITHUB_FETCH=1` to opt back into the upstream-fetch
 * behaviour preserved from apify/camoufox-js@562117321.
 */
const ALLOW_GITHUB_FETCH =
	process.env.CAMOUFOX_ALLOW_GITHUB_FETCH === "1" ||
	process.env.CAMOUFOX_ALLOW_GITHUB_FETCH === "true";

/**
 * PHI-VENDOR: Versioned cache directory written by
 * `scripts/postinstall.mjs`. The directory holds, per host platform,
 * an extracted Camoufox tree under `camoufox-bin/`. Survives
 * `rm -rf node_modules` because it lives under the user's cache dir
 * (XDG / Library / LOCALAPPDATA depending on OS).
 *
 * Keep this layout in lockstep with `scripts/postinstall.mjs#cacheRoot`.
 */
function phiCodeCacheRoot(): string {
	const home = os.homedir();
	if (process.platform === "darwin") {
		return path.join(home, "Library", "Caches", "phi-code", "camoufox", "v1.0.0");
	}
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
		return path.join(local, "phi-code", "camoufox", "v1.0.0");
	}
	const xdg = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
	return path.join(xdg, "phi-code", "camoufox", "v1.0.0");
}

function getAuthorizationHeaders(url: string): HeadersInit {
	const githubToken = process.env.GITHUB_TOKEN;
	if (!githubToken) return {};
	const host = new URL(url).hostname;
	if (host === "api.github.com" || host === "github.com") {
		return { Authorization: `Bearer ${githubToken}` };
	}
	return {};
}

if (!(process.platform in OS_MAP)) {
	throw new UnsupportedOS(`OS ${process.platform} is not supported`);
}

export const OS_NAME: "mac" | "win" | "lin" = OS_MAP[process.platform];

const currentDir =
	import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export const INSTALL_DIR: PathLike = userCacheDir("camoufox");

const formatBytes = (v: number, _: Options, type: string) =>
	type === "total" || type === "value" ? prettyBytes(v) : String(v);
export const LOCAL_DATA: PathLike = path.join(currentDir, "data-files");

export const OS_ARCH_MATRIX: { [key: string]: string[] } = {
	win: ["x86_64", "i686"],
	mac: ["x86_64", "arm64"],
	lin: ["x86_64", "arm64", "i686"],
};

const LAUNCH_FILE: { [key: string]: string } = {
	win: "camoufox.exe",
	mac: "../MacOS/camoufox",
	lin: "camoufox-bin",
};

class Version {
	release: string;
	version?: string;
	sorted_rel: number[];

	constructor(release: string, version?: string) {
		this.release = release;
		this.version = version;
		this.sorted_rel = this.buildSortedRel();
	}

	private buildSortedRel(): number[] {
		const parts = this.release
			.split(".")
			.map((x) =>
				Number.isNaN(Number(x)) ? x.charCodeAt(0) - 1024 : Number(x),
			);
		while (parts.length < 5) {
			parts.push(0);
		}
		return parts;
	}

	get fullString(): string {
		return `${this.version}-${this.release}`;
	}

	equals(other: Version): boolean {
		return this.sorted_rel.join(".") === other.sorted_rel.join(".");
	}

	lessThan(other: Version): boolean {
		for (let i = 0; i < this.sorted_rel.length; i++) {
			if (this.sorted_rel[i] < other.sorted_rel[i]) return true;
			if (this.sorted_rel[i] > other.sorted_rel[i]) return false;
		}
		return false;
	}

	isSupported(): boolean {
		return VERSION_MIN.lessThan(this) && this.lessThan(VERSION_MAX);
	}

	static fromPath(filePath: PathLike = INSTALL_DIR): Version {
		const versionPath = path.join(filePath.toString(), "version.json");
		if (!fs.existsSync(versionPath)) {
			throw new FileNotFoundError(
				`Version information not found at ${versionPath}. Please run \`camoufox fetch\` to install.`,
			);
		}
		const versionData = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
		return new Version(versionData.release, versionData.version);
	}

	static isSupportedPath(path: PathLike): boolean {
		return Version.fromPath(path).isSupported();
	}

	static buildMinMax(): [Version, Version] {
		return [
			new Version(CONSTRAINTS.MIN_VERSION),
			new Version(CONSTRAINTS.MAX_VERSION),
		];
	}
}

const [VERSION_MIN, VERSION_MAX] = Version.buildMinMax();

export class GitHubDownloader {
	githubRepo: string;
	apiUrl: string;

	constructor(githubRepo: string) {
		this.githubRepo = githubRepo;
		this.apiUrl = `https://api.github.com/repos/${githubRepo}/releases`;
	}

	checkAsset(asset: any): any {
		return asset.browser_download_url;
	}

	missingAssetError(): void {
		throw new MissingRelease(
			`Could not find a release asset in ${this.githubRepo}.`,
		);
	}

	async getAsset(
		{ retries }: { retries: number } = { retries: 5 },
	): Promise<any> {
		let attempts = 0;
		let response: Response | undefined;

		while (attempts < retries) {
			try {
				response = await fetch(this.apiUrl, {
					headers: getAuthorizationHeaders(this.apiUrl),
				});
				if (response.ok) break;
			} catch (e) {
				console.error(e, `retrying (${attempts + 1}/${retries})...`);
				await setTimeout(5e3);
			}
			attempts++;
		}
		if (!response || !response.ok) {
			throw new Error(
				`Failed to fetch releases from ${this.apiUrl} after ${retries} attempts`,
			);
		}

		const releases = await response.json();

		for (const release of releases) {
			for (const asset of release.assets) {
				const data = this.checkAsset(asset);
				if (data) {
					return data;
				}
			}
		}

		this.missingAssetError();
	}
}

export class CamoufoxFetcher extends GitHubDownloader {
	arch: string;
	_version_obj?: Version;
	pattern: RegExp;
	_url?: string;

	constructor() {
		// PHI-VENDOR: target the re-hosted release on uglyswap/phi-code by
		// default. The upstream daijro/camoufox repo can still be queried
		// when CAMOUFOX_ALLOW_GITHUB_FETCH=1 — see the override above the
		// camoufoxPath() call sites.
		super(ALLOW_GITHUB_FETCH ? "daijro/camoufox" : "uglyswap/phi-code");
		this.arch = CamoufoxFetcher.getPlatformArch();
		this.pattern = new RegExp(
			`camoufox-(.+)-(.+)-${OS_NAME}\\.${this.arch}\\.zip`,
		);
	}

	async init() {
		await this.fetchLatest();
	}

	checkAsset(asset: any): [Version, string] | null {
		const match = asset.name.match(this.pattern);
		if (!match) return null;

		const version = new Version(match[2], match[1]);
		if (!version.isSupported()) return null;

		return [version, asset.browser_download_url];
	}

	missingAssetError(): void {
		throw new MissingRelease(
			`No matching release found for ${OS_NAME} ${this.arch} in the supported range: (${CONSTRAINTS.asRange()}). Please update the library.`,
		);
	}

	static getPlatformArch(): string {
		const platArch = os.arch().toLowerCase();
		if (!(platArch in ARCH_MAP)) {
			throw new UnsupportedArchitecture(
				`Architecture ${platArch} is not supported`,
			);
		}

		const arch = ARCH_MAP[platArch];
		if (!OS_ARCH_MATRIX[OS_NAME].includes(arch)) {
			throw new UnsupportedArchitecture(
				`Architecture ${arch} is not supported for ${OS_NAME}`,
			);
		}

		return arch;
	}

	async fetchLatest(): Promise<void> {
		if (this._version_obj) return;
		const releaseData = await this.getAsset();
		this._version_obj = releaseData[0];
		this._url = releaseData[1];
	}

	static async downloadFile(url: string): Promise<Buffer> {
		const response = await fetch(url, {
			headers: getAuthorizationHeaders(url),
		});

		return Buffer.from(await response.arrayBuffer());
	}

	async extractZip(zipFile: string | Buffer): Promise<void> {
		const zip = new AdmZip(zipFile);
		zip.extractAllTo(INSTALL_DIR.toString(), true);
	}

	static cleanup(): boolean {
		if (fs.existsSync(INSTALL_DIR)) {
			fs.rmSync(INSTALL_DIR, { recursive: true });
			return true;
		}
		return false;
	}

	setVersion(): void {
		fs.writeFileSync(
			path.join(INSTALL_DIR.toString(), "version.json"),
			JSON.stringify({ version: this.version, release: this.release }),
		);
	}

	async install(): Promise<void> {
		await this.init();
		await CamoufoxFetcher.cleanup();
		try {
			fs.mkdirSync(INSTALL_DIR, { recursive: true });

			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-"));
			const tempFilePath = path.join(tempDir, "camoufox.zip");
			const tempFileStream = fs.createWriteStream(tempFilePath);

			await webdl(this.url, "Downloading Camoufox...", true, tempFileStream);
			await new Promise((r) => tempFileStream.close(r));

			await this.extractZip(tempFilePath);
			this.setVersion();

			if (OS_NAME !== "win") {
				execSync(`chmod -R 755 ${INSTALL_DIR}`);
			}

			console.log("Camoufox successfully installed.");
		} catch (e) {
			console.error(`Error installing Camoufox: ${e}`);
			await CamoufoxFetcher.cleanup();
			throw e;
		}
	}

	get url(): string {
		if (!this._url) {
			throw new Error(
				"Url is not available. Make sure to run fetchLatest first.",
			);
		}
		return this._url;
	}

	get version(): string {
		if (!this._version_obj || !this._version_obj.version) {
			throw new Error(
				"Version is not available. Make sure to run fetchLatest first.",
			);
		}
		return this._version_obj.version;
	}

	get release(): string {
		if (!this._version_obj) {
			throw new Error(
				"Release information is not available. Make sure to run the installation first.",
			);
		}
		return this._version_obj.release;
	}

	get verstr(): string {
		if (!this._version_obj) {
			throw new Error(
				"Version is not available. Make sure to run the installation first.",
			);
		}
		return this._version_obj.fullString;
	}
}

function userCacheDir(appName: string): string {
	if (OS_NAME === "win") {
		return path.join(
			os.homedir(),
			"AppData",
			"Local",
			appName,
			appName,
			"Cache",
		);
	} else if (OS_NAME === "mac") {
		return path.join(os.homedir(), "Library", "Caches", appName);
	} else {
		return path.join(os.homedir(), ".cache", appName);
	}
}

export function installedVerStr(): string {
	// PHI-VENDOR: route through camoufoxPath() so the version probe reads
	// the phi-code-managed cache (or CAMOUFOX_BIN_DIR override) first, and
	// only falls back to the legacy INSTALL_DIR when nothing else is set.
	// Without this, utils.ts:600 -> Version.fromPath() always hit the old
	// `~/.cache/camoufox` location and threw "Version information not
	// found" even when the binary was correctly installed in
	// `~/.cache/phi-code/camoufox/v1.0.0/<platform>-<arch>/camoufox-bin`.
	try {
		const candidate = camoufoxPath(false);
		return Version.fromPath(candidate).fullString;
	} catch {
		return Version.fromPath().fullString;
	}
}

/**
 * PHI-VENDOR: Look up the Camoufox binary placed by the camoufox-js
 * postinstall script (`scripts/postinstall.mjs`) into the versioned cache
 * directory under the user's standard cache root. Returns the absolute
 * path to the extracted Camoufox tree (the directory containing
 * `version.json` and the launch binary) or `undefined` when the cache is
 * empty for the host platform — typically because the user ran
 * `npm install --ignore-scripts` or the postinstall network call failed.
 *
 * The cache layout matches the one written by the postinstall script;
 * keep them in lockstep when changing either.
 */
function findBundledBinary(): string | undefined {
	const root = phiCodeCacheRoot();
	const platformKey = `${process.platform}-${process.arch}`;
	const binDir = path.join(root, platformKey, "camoufox-bin");

	if (!fs.existsSync(binDir)) return undefined;
	const versionFile = path.join(binDir, "version.json");
	if (!fs.existsSync(versionFile)) return undefined;

	try {
		if (!Version.isSupportedPath(binDir)) return undefined;
	} catch {
		return undefined;
	}

	return binDir;
}

/**
 * PHI-VENDOR: Allow an air-gapped operator to bypass the cache entirely
 * by pointing at a pre-extracted Camoufox tree on disk. Useful for CI
 * images that bake the binary in, or for users whose firewall blocks the
 * release URL.
 */
function findEnvBinary(): string | undefined {
	const explicit = process.env.CAMOUFOX_BIN_DIR;
	if (!explicit) return undefined;
	if (!fs.existsSync(explicit)) return undefined;
	const versionFile = path.join(explicit, "version.json");
	if (!fs.existsSync(versionFile)) return undefined;
	try {
		if (!Version.isSupportedPath(explicit)) return undefined;
	} catch {
		return undefined;
	}
	return explicit;
}

export function camoufoxPath(downloadIfMissing: boolean = true): PathLike {
	// PHI-VENDOR: priority 0 — CAMOUFOX_BIN_DIR env var, for air-gapped CI.
	const fromEnv = findEnvBinary();
	if (fromEnv) return fromEnv;

	// PHI-VENDOR: priority 1 — phi-code's versioned cache directory, written
	// by the camoufox-js postinstall script from the uglyswap/phi-code
	// release. This is the default path on a clean `npm install`.
	const bundled = findBundledBinary();
	if (bundled) return bundled;

	// PHI-VENDOR: priority 2 — legacy `~/.cache/camoufox` install (used by
	// `npx camoufox-js fetch` and by upstream apify/camoufox-js).
	if (fs.existsSync(INSTALL_DIR) && fs.readdirSync(INSTALL_DIR).length > 0) {
		if (Version.isSupportedPath(INSTALL_DIR)) return INSTALL_DIR;
		if (!downloadIfMissing) {
			throw new UnsupportedVersion("Camoufox executable is outdated.");
		}
	} else if (!downloadIfMissing) {
		throw new Error(
			`Camoufox binary not found for ${process.platform}-${process.arch}.\n` +
				`Expected the postinstall to have populated ${phiCodeCacheRoot()}.\n` +
				`Retry with: npx @phi-code-admin/camoufox-js fetch  (downloads ~hundreds of MB).`,
		);
	}

	// PHI-VENDOR: priority 3 — opt-in upstream fetch (preserved for users
	// who deliberately want the legacy behaviour, e.g. fork developers
	// testing against a newer daijro/camoufox release before vendoring it).
	if (!ALLOW_GITHUB_FETCH) {
		throw new CamoufoxNotInstalled(
			`Camoufox binary not found for ${process.platform}-${process.arch}.\n` +
				`The postinstall script should have downloaded it from\n` +
				`  https://github.com/uglyswap/phi-code/releases/tag/binaries-v1.0.0\n` +
				`into ${phiCodeCacheRoot()}/${process.platform}-${process.arch}/.\n` +
				`Retry with: npx @phi-code-admin/camoufox-js fetch\n` +
				`Or set CAMOUFOX_ALLOW_GITHUB_FETCH=1 to fetch from the daijro upstream instead.`,
		);
	}

	const fetcher = new CamoufoxFetcher();
	fetcher.install().then(() => camoufoxPath());
	return INSTALL_DIR;
}

export function getPath(file: string): string {
	if (OS_NAME === "mac") {
		return path.resolve(
			camoufoxPath().toString(),
			"Camoufox.app",
			"Contents",
			"Resources",
			file,
		);
	}
	return path.join(camoufoxPath().toString(), file);
}

export function launchPath(): string {
	const launchPath = getPath(LAUNCH_FILE[OS_NAME]);
	if (!fs.existsSync(launchPath)) {
		throw new CamoufoxNotInstalled(
			`Camoufox is not installed at ${camoufoxPath()}. Please run \`camoufox fetch\` to install.`,
		);
	}
	return launchPath;
}

export async function webdl(
	url: string,
	desc: string = "",
	bar: boolean = true,
	buffer: Writable | null = null,
	{ retries }: { retries: number } = { retries: 5 },
): Promise<Buffer> {
	let attempts = 0;
	let response: Response | undefined;

	while (attempts < retries) {
		try {
			response = await fetch(url, { headers: getAuthorizationHeaders(url) });
			if (response.ok) break;
		} catch (e) {
			console.error(e, `retrying (${attempts + 1}/${retries})...`);
			await setTimeout(5e3);
		}
		attempts++;
	}

	if (!response || !response.ok) {
		throw new Error(`Failed to download from ${url} after ${retries} attempts`);
	}

	const totalSize = parseInt(response.headers.get("content-length") || "0", 10);
	let progressBar: cliProgress.SingleBar | null = null;
	if (bar && totalSize > 0) {
		progressBar = new cliProgress.SingleBar(
			{
				format: `${desc} [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total}`,
				formatValue: formatBytes,
				noTTYOutput: true,
			},
			cliProgress.Presets.shades_classic,
		);
		progressBar.start(totalSize, 0);
	}

	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of response.body!) {
			if (buffer) {
				buffer.write(chunk);
			} else {
				chunks.push(chunk);
			}
			if (progressBar) {
				progressBar.increment(chunk.length);
			}
		}
	} finally {
		progressBar?.stop();
	}

	return Buffer.concat(chunks);
}

export async function unzip(
	zipFile: Buffer,
	extractPath: string,
	desc?: string,
	bar: boolean = true,
): Promise<void> {
	const zip = new AdmZip(zipFile);
	const zipEntries = zip.getEntries();

	if (bar) {
		console.log(desc || "Extracting files...");
	}

	for (const entry of zipEntries) {
		if (bar) {
			console.log(`Extracting ${entry.entryName}`);
		}
		zip.extractEntryTo(entry, extractPath, false, true);
	}

	if (bar) {
		console.log("Extraction complete.");
	}
}
