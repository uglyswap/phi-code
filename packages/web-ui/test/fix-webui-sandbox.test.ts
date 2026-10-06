import { describe, expect, it, vi } from "vitest";
import { ArtifactsRuntimeProvider } from "../src/components/sandbox/ArtifactsRuntimeProvider.ts";
import { isSafeExternalUrl, isTrustedSandboxSource } from "../src/components/sandbox/sandbox-security.ts";

describe("isSafeExternalUrl", () => {
	it("allows http, https and mailto", () => {
		expect(isSafeExternalUrl("https://example.com/a?b=1")).toBe(true);
		expect(isSafeExternalUrl("http://example.com")).toBe(true);
		expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(true);
	});

	it("rejects script-capable and opaque schemes", () => {
		for (const url of [
			"javascript:alert(1)",
			" JavaScript:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"blob:https://example.com/uuid",
			"file:///etc/passwd",
			"vbscript:x",
		]) {
			expect(isSafeExternalUrl(url), url).toBe(false);
		}
	});

	it("rejects non-strings and unparsable values", () => {
		expect(isSafeExternalUrl(undefined)).toBe(false);
		expect(isSafeExternalUrl({ toString: () => "https://x" })).toBe(false);
		expect(isSafeExternalUrl("not a url")).toBe(false);
	});
});

describe("isTrustedSandboxSource", () => {
	const host = {} as Window;
	const sandbox = {} as Window;
	const other = {} as Window;

	it("accepts the sandbox iframe and the host window", () => {
		expect(isTrustedSandboxSource(sandbox, sandbox, host)).toBe(true);
		expect(isTrustedSandboxSource(host, sandbox, host)).toBe(true);
	});

	it("rejects any other sender, including before the iframe is attached", () => {
		expect(isTrustedSandboxSource(other, sandbox, host)).toBe(false);
		expect(isTrustedSandboxSource(other, null, host)).toBe(false);
		expect(isTrustedSandboxSource(null, sandbox, host)).toBe(false);
	});
});

describe("ArtifactsRuntimeProvider read-only mode", () => {
	const makePanel = () => ({
		artifacts: new Map([["a.txt", { content: "hello" }]]),
		tool: { execute: vi.fn(async () => ({})) },
	});

	it("refuses createOrUpdate and delete when read-only", async () => {
		const panel = makePanel();
		const provider = new ArtifactsRuntimeProvider(panel, undefined, false);
		const respond = vi.fn();

		await provider.handleMessage(
			{ type: "artifact-operation", action: "createOrUpdate", filename: "b.txt", content: "x" },
			respond,
		);
		await provider.handleMessage({ type: "artifact-operation", action: "delete", filename: "a.txt" }, respond);

		expect(panel.tool.execute).not.toHaveBeenCalled();
		expect(respond).toHaveBeenNthCalledWith(1, expect.objectContaining({ success: false }));
		expect(respond).toHaveBeenNthCalledWith(2, expect.objectContaining({ success: false }));
	});

	it("still allows reads when read-only", async () => {
		const provider = new ArtifactsRuntimeProvider(makePanel(), undefined, false);
		const respond = vi.fn();
		await provider.handleMessage({ type: "artifact-operation", action: "get", filename: "a.txt" }, respond);
		expect(respond).toHaveBeenCalledWith({ success: true, result: "hello" });
	});

	it("allows writes when read-write", async () => {
		const panel = makePanel();
		const provider = new ArtifactsRuntimeProvider(panel, undefined, true);
		const respond = vi.fn();
		await provider.handleMessage(
			{ type: "artifact-operation", action: "createOrUpdate", filename: "b.txt", content: "x" },
			respond,
		);
		expect(panel.tool.execute).toHaveBeenCalledTimes(1);
		expect(respond).toHaveBeenCalledWith({ success: true });
	});
});
