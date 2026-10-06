/**
 * FIX4-BINBROWSER: the browser extension configures the first-use runtime
 * install dir (<agentDir>/runtime/browser), boots the server before the call
 * and reports install progress as partial tool results; the standalone binary
 * archive ships @phi-code-admin/browser (scripts/build-binaries.sh).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { BUNDLED_EXTENSION_DEPS } from "../src/core/bundled-assets.ts";

const api = vi.hoisted(() => ({
	navigate: vi.fn(),
	extract: vi.fn(),
	screenshot: vi.fn(),
	search: vi.fn(),
	click: vi.fn(),
	type: vi.fn(),
	scroll: vi.fn(),
	snapshot: vi.fn(),
	closeTab: vi.fn(),
	listTabs: vi.fn(),
	closeAll: vi.fn(),
	ensureServer: vi.fn(),
	configureServerRuntime: vi.fn(),
}));

vi.mock("@phi-code-admin/browser", () => api);

const { default: browserExtension, browserRuntimeDir } = await import("../extensions/phi/browser.ts");

interface RegisteredTool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: { content: Array<{ type: string; text?: string }> }) => void,
		ctx?: { hasUI: boolean },
	) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function loadTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	browserExtension({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool), on: () => {} } as never);
	return tools;
}

const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("browser extension: first-use runtime install", () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset();
	});

	it("installs under <agentDir>/runtime/browser", () => {
		expect(browserRuntimeDir()).toBe(join(getAgentDir(), "runtime", "browser"));
	});

	it("configures the install dir and boots the server with the call's signal before the call", async () => {
		const order: string[] = [];
		api.ensureServer.mockImplementation(async () => {
			order.push("ensureServer");
			return { baseUrl: "http://127.0.0.1:1" };
		});
		api.extract.mockImplementation(async () => {
			order.push("extract");
			return { title: "t" };
		});
		const controller = new AbortController();
		await loadTools()
			.get("browser_extract")!
			.execute("c1", { url: "https://example.com" }, controller.signal, undefined, {
				hasUI: true,
			});
		expect(api.configureServerRuntime).toHaveBeenCalledWith({ installDir: browserRuntimeDir() });
		expect(api.ensureServer).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
		expect(order).toEqual(["ensureServer", "extract"]);
	});

	it("reports install progress as partial results, and on stderr without UI", async () => {
		api.ensureServer.mockImplementation(async (options: { onProgress?: (message: string) => void }) => {
			options.onProgress?.("Installing the browser runtime...");
			return { baseUrl: "http://127.0.0.1:1" };
		});
		api.listTabs.mockResolvedValue([]);
		const updates: string[] = [];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await loadTools()
				.get("browser_list_tabs")!
				.execute("c1", {}, undefined, (partial) => updates.push(partial.content[0].text ?? ""), { hasUI: false });
			expect(updates).toEqual(["Installing the browser runtime..."]);
			expect(stderr).toHaveBeenCalledWith("[phi browser] Installing the browser runtime...\n");
		} finally {
			stderr.mockRestore();
		}
	});

	it("surfaces a failed install as the tool error", async () => {
		api.ensureServer.mockRejectedValue(new Error("no npm was found"));
		await expect(loadTools().get("browser_navigate")!.execute("c1", { url: "https://example.com" })).rejects.toThrow(
			"no npm was found",
		);
		expect(api.navigate).not.toHaveBeenCalled();
	});
});

describe("standalone binary archive (scripts/build-binaries.sh)", () => {
	const script = readFileSync(join(repoRoot, "scripts", "build-binaries.sh"), "utf8");

	it("ships the same extension dependencies the npm install links, browser included", () => {
		const match = /^EXTENSION_DEPS=\(([^)]*)\)/m.exec(script);
		expect(match).not.toBeNull();
		const shipped = match![1].trim().split(/\s+/);
		expect([...shipped].sort()).toEqual([...BUNDLED_EXTENSION_DEPS].sort());
		expect(shipped).toContain("@phi-code-admin/browser");
	});

	it("packs @phi-code-admin/browser from the local build and drops the server it installs on first use", () => {
		expect(/^EXTENSION_WORKSPACE_DIRS=\(([^)]*)\)/m.exec(script)?.[1].split(/\s+/)).toContain("browser");
		expect(script).toMatch(
			/"@phi-code-admin\/browser": new Set\(\["@phi-code-admin\/camofox-browser", "@phi-code-admin\/camoufox-js"\]\)/,
		);
	});
});
