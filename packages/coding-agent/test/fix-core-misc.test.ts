import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ConfigWatcher } from "../src/core/config-watcher.ts";
import { loadPromptTemplates, loadPromptTemplatesWithDiagnostics } from "../src/core/prompt-templates.ts";
import { renderHighlightedHtml } from "../src/utils/syntax-highlight.ts";
import { checkForNewVersion } from "../src/utils/version-check.ts";

describe("fix-core config watcher agent dir", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "phi-fix-core-watcher-"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("watches the configured agent dir instead of a hard-coded ~/.phi/agent", () => {
		vi.stubEnv(ENV_AGENT_DIR, testDir);
		const watcher = new ConfigWatcher();
		const files = (watcher as unknown as { files: Array<{ path: string }> }).files.map((file) => file.path);
		expect(files).toEqual([join(testDir, "models.json"), join(testDir, "routing.json")]);
	});
});

describe("fix-core version check opt-out", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("honors PHI_SKIP_VERSION_CHECK without querying the registry", async () => {
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PHI_SKIP_VERSION_CHECK", "1");
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ version: "999.0.0" })));
		vi.stubGlobal("fetch", fetchSpy);
		expect(await checkForNewVersion("0.0.1")).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("fix-core #9354 invalid prompt template frontmatter", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "phi-fix-core-prompts-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reports a template whose YAML frontmatter is invalid instead of dropping it silently", () => {
		const promptsDir = join(testDir, "prompts");
		mkdirSync(promptsDir, { recursive: true });
		const invalid = join(promptsDir, "broken.md");
		writeFileSync(invalid, "---\ndescription: [unterminated\n---\nBody");
		writeFileSync(join(promptsDir, "ok.md"), "---\ndescription: Fine\nargument-hint: 42\n---\nBody");

		const options = { cwd: testDir, agentDir: testDir, promptPaths: [promptsDir], includeDefaults: false };
		const result = loadPromptTemplatesWithDiagnostics(options);
		expect(result.templates.map((template) => template.name)).toEqual(["ok"]);
		// A non-string argument-hint is ignored rather than leaking a number into the UI.
		expect(result.templates[0]?.argumentHint).toBeUndefined();
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ type: "warning", path: invalid });
		expect(loadPromptTemplates(options).map((template) => template.name)).toEqual(["ok"]);
	});
});

describe("fix-core #10143 multiline syntax tokens", () => {
	it("colors every line of a multiline token independently", () => {
		const html =
			'<span class="hljs-string">&quot;&quot;&quot;\nline one\n\nline two\n&quot;&quot;&quot;</span>\nafter';
		const output = renderHighlightedHtml(html, { string: (text) => `<${text}>` });
		expect(output.split("\n")).toEqual(['<""">', "<line one>", "", "<line two>", '<""">', "after"]);
	});
});
