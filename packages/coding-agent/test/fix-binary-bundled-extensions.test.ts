import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulates the standalone Bun binary: isBunBinary is true and the package dir
// is the directory of the executable (dirname(process.execPath)), where
// scripts/build-binaries.sh stages extensions/phi, agents, skills and node_modules.
const state = vi.hoisted(() => ({ exeDir: "", agentDir: "" }));

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.ts")>();
	return {
		...actual,
		isBunBinary: true,
		VERSION: "9.9.9-test",
		getPackageDir: () => state.exeDir,
		getAgentDir: () => state.agentDir,
		getBundledExtensionsDir: () => join(state.exeDir, "extensions", "phi"),
	};
});

const { discoverAndLoadExtensions } = await import("../src/core/extensions/loader.ts");
const { BUNDLED_ASSETS_STAMP, readBundledAssetsStamp, syncBundledAssetsIfStale } = await import(
	"../src/core/bundled-assets.ts"
);

let root: string;
const savedEnv: Record<string, string | undefined> = {};

function stageArchive(): void {
	const extDir = join(state.exeDir, "extensions", "phi");
	mkdirSync(extDir, { recursive: true });
	writeFileSync(
		join(extDir, "binary-ext.ts"),
		[
			'import { marker } from "fake-ext-dep";',
			"export default function (pi: { registerCommand: (n: string, o: unknown) => void }) {",
			'\tpi.registerCommand(marker, { description: "x", handler: async () => {} });',
			"}",
		].join("\n"),
	);
	const depDir = join(state.exeDir, "node_modules", "fake-ext-dep");
	mkdirSync(depDir, { recursive: true });
	writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "fake-ext-dep", main: "index.js" }));
	writeFileSync(join(depDir, "index.js"), 'exports.marker = "from-exe-node-modules";');
	const zodDir = join(state.exeDir, "node_modules", "zod");
	mkdirSync(zodDir, { recursive: true });
	writeFileSync(join(zodDir, "package.json"), JSON.stringify({ name: "zod" }));
	mkdirSync(join(state.exeDir, "agents"), { recursive: true });
	writeFileSync(join(state.exeDir, "agents", "code.md"), "# code");
	mkdirSync(join(state.exeDir, "skills", "demo"), { recursive: true });
	writeFileSync(join(state.exeDir, "skills", "demo", "SKILL.md"), "# demo");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fix-binary-"));
	state.exeDir = join(root, "phi-windows-x64");
	state.agentDir = join(root, "agent");
	mkdirSync(state.agentDir, { recursive: true });
	for (const key of [
		"CI",
		"PHI_SKIP_POSTINSTALL",
		"PHI_DISABLE_BUNDLED_EXTENSIONS",
		"PHI_DISABLE_PROJECT_EXTENSIONS",
	]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	stageArchive();
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("fix-binary: bundled extensions in the Bun binary", () => {
	it("discovers extensions/phi next to the executable and resolves their deps from its node_modules", async () => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const result = await discoverAndLoadExtensions([], cwd, state.agentDir);
		expect(result.errors).toEqual([]);
		const ext = result.extensions.find((e) => e.path.endsWith("binary-ext.ts"));
		expect(ext?.resolvedPath.startsWith(join(state.exeDir, "extensions", "phi"))).toBe(true);
		expect(ext?.commands.has("from-exe-node-modules")).toBe(true);
	});

	it("copies extensions, agents and skills into the agent dir and links extension deps", () => {
		expect(readBundledAssetsStamp(state.agentDir)).toBeUndefined();
		syncBundledAssetsIfStale();

		expect(existsSync(join(state.agentDir, "extensions", "binary-ext.ts"))).toBe(true);
		expect(readFileSync(join(state.agentDir, "agents", "code.md"), "utf8")).toBe("# code");
		expect(existsSync(join(state.agentDir, "skills", "demo", "SKILL.md"))).toBe(true);
		const linkedZod = join(state.agentDir, "extensions", "node_modules", "zod");
		expect(existsSync(join(linkedZod, "package.json"))).toBe(true);
		expect(lstatSync(linkedZod).isSymbolicLink() || lstatSync(linkedZod).isDirectory()).toBe(true);
		expect(readFileSync(join(state.agentDir, BUNDLED_ASSETS_STAMP), "utf8")).toBe("9.9.9-test");
	});

	it("re-links over a dangling junction left by a previous binary version", () => {
		syncBundledAssetsIfStale();
		writeFileSync(join(state.agentDir, BUNDLED_ASSETS_STAMP), "0.0.1");
		// The new version is extracted elsewhere and the previous archive is
		// deleted: the junction in the agent dir now dangles.
		const previousExeDir = state.exeDir;
		state.exeDir = join(root, "phi-windows-x64-next");
		stageArchive();
		rmSync(previousExeDir, { recursive: true, force: true });
		const zodDir = join(state.exeDir, "node_modules", "zod");
		mkdirSync(zodDir, { recursive: true });
		writeFileSync(join(zodDir, "package.json"), JSON.stringify({ name: "zod", version: "new" }));

		syncBundledAssetsIfStale();
		const pkg = JSON.parse(
			readFileSync(join(state.agentDir, "extensions", "node_modules", "zod", "package.json"), "utf8"),
		) as { version?: string };
		expect(pkg.version).toBe("new");
		expect(readBundledAssetsStamp(state.agentDir)).toBe("9.9.9-test");
	});

	it("does nothing when the stamp already matches", () => {
		writeFileSync(join(state.agentDir, BUNDLED_ASSETS_STAMP), "9.9.9-test");
		syncBundledAssetsIfStale();
		expect(existsSync(join(state.agentDir, "extensions"))).toBe(false);
	});
});
