/**
 * FIX-BROWSER regression tests for the browser_* tools (extensions/phi/browser.ts):
 * screenshots reach the model as image blocks, every tool has a label and
 * forwards the abort signal, and the schemas only expose parameters the
 * camofox-browser server actually honours.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 1x1 transparent PNG.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
}));

vi.mock("@phi-code-admin/browser", () => api);

const { default: browserExtension } = await import("../extensions/phi/browser.ts");

interface RegisteredTool {
	name: string;
	label?: string;
	parameters: { properties: Record<string, unknown> };
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
}

function loadTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		on: () => {},
	};
	browserExtension(pi as never);
	return tools;
}

describe("browser_* tools", () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset();
	});

	it("registers 10 tools, each with a label", () => {
		const tools = loadTools();
		expect(tools.size).toBe(10);
		for (const tool of tools.values()) expect(tool.label, tool.name).toBeTruthy();
	});

	it("browser_screenshot returns an image block, not base64 text", async () => {
		api.screenshot.mockResolvedValue({ tabId: "t1", mimeType: "image/png", bytesBase64: PNG_1X1 });
		const result = await loadTools().get("browser_screenshot")!.execute("c1", { tabId: "t1" });
		const image = result.content.find((c) => c.type === "image");
		expect(image?.mimeType).toBe("image/png");
		expect(image?.data).toBeTruthy();
		for (const block of result.content.filter((c) => c.type === "text")) {
			expect(block.text).not.toContain(PNG_1X1);
		}
	});

	it("forwards the abort signal to the browser API", async () => {
		api.listTabs.mockResolvedValue([]);
		const controller = new AbortController();
		await loadTools().get("browser_list_tabs")!.execute("c1", {}, controller.signal);
		expect(api.listTabs).toHaveBeenCalledWith({ signal: controller.signal });
	});

	it("browser_snapshot exposes offset and tells the model how to continue", async () => {
		const tools = loadTools();
		expect(tools.get("browser_snapshot")!.parameters.properties).toHaveProperty("offset");
		api.snapshot.mockResolvedValue({
			url: "https://a.test/",
			snapshot: '- button "Go" [e1]',
			refsCount: 1,
			totalChars: 120000,
			hasMore: true,
			nextOffset: 80000,
		});
		const result = await tools.get("browser_snapshot")!.execute("c1", { tabId: "t1", offset: 0 });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("offset=80000");
		expect(text).toContain('- button "Go" [e1]');
		expect(api.snapshot).toHaveBeenCalledWith(expect.objectContaining({ tabId: "t1", offset: 0 }));
	});

	it("schemas only expose parameters the server honours", () => {
		const tools = loadTools();
		expect(tools.get("browser_scroll")!.parameters.properties).toHaveProperty("amount");
		expect(tools.get("browser_scroll")!.parameters.properties).not.toHaveProperty("pixels");
		expect(tools.get("browser_scroll")!.parameters.properties).not.toHaveProperty("ref");
		expect(tools.get("browser_click")!.parameters.properties).not.toHaveProperty("button");
	});

	it("browser_extract no longer claims to be Mozilla Readability", () => {
		const description = (loadTools().get("browser_extract") as unknown as { description: string }).description;
		expect(description).not.toMatch(/Mozilla Readability/);
	});
});
