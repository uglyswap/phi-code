import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isBenchmarkable } from "../extensions/phi/benchmark.ts";
import { parseAgentMarkdown } from "../extensions/phi/providers/agent-def.ts";
import { catalogEnvKey, getProviderCatalog } from "../extensions/phi/providers/catalog.ts";
import { passed, runCommand, runCommandAsync } from "../extensions/phi/providers/execution.ts";
import {
	READONLY_EXPLORER_TOOLS,
	readOnlyToolArgs,
	WRITE_CAPABLE_TOOLS,
} from "../extensions/phi/providers/explore-fanout.ts";
import { toPersistedModel, withOpenAICapabilities } from "../extensions/phi/providers/live-models.ts";
import { composePhaseSystemPrompt, resolveModelRef } from "../extensions/phi/providers/orchestrator-helpers.ts";
import { defaultLocalShell, resolveSandbox } from "../extensions/phi/providers/sandbox.ts";
import { isGreenOutcome, type RunRecord, summarizeRuns } from "../extensions/phi/providers/telemetry.ts";

describe("FIX-ORCH: telemetry green metric", () => {
	it("counts only real green outcomes", () => {
		expect(isGreenOutcome("✅ /fix finished GREEN at single-shot cost — oracle evidence: repro exit 0")).toBe(true);
		expect(isGreenOutcome("✅ /debug FIXED by candidate arbitration")).toBe(true);
		expect(isGreenOutcome("✅ /debug finished.")).toBe(true);
		expect(isGreenOutcome("⚠️ /fix finished UNVERIFIED — no executable environment for the oracle.")).toBe(false);
		expect(isGreenOutcome("❌ /debug finished with FAIL at ✅ Phase 4 — VERIFY")).toBe(false);
		expect(isGreenOutcome("⏸️ /debug stopped: BLOCKED at VERIFY")).toBe(false);
		expect(isGreenOutcome("🛑 Cancelled.")).toBe(false);
	});

	it("/runs no longer reports 'finished UNVERIFIED' as green", () => {
		const rec = (outcome: string): RunRecord => ({
			mode: "fix",
			startedAt: "2026-10-06T00:00:00.000Z",
			durationMs: 1000,
			phases: [],
			completedPhases: 1,
			skippedPhases: 0,
			sandboxExecs: 0,
			outcome,
		});
		const md = summarizeRuns([
			rec("⚠️ /fix finished UNVERIFIED — x"),
			rec("✅ /fix finished GREEN at single-shot cost"),
		]);
		// | fix | 2 | green 50% | blocked 0% | unverified 50% | ...
		expect(md).toMatch(/\| fix \| 2 \| 50% \| 0% \| 50% \|/);
	});
});

describe("FIX-ORCH: agent-def CRLF", () => {
	it("parses a CRLF agent file exactly like an LF one", () => {
		const lf = "---\nname: a\ndescription: Does things\ntools: read, grep\n---\n\nBody line 1\nBody line 2";
		const crlf = lf.replace(/\n/g, "\r\n");
		const fromLf = parseAgentMarkdown(lf, "/x/a.md", "project");
		const fromCrlf = parseAgentMarkdown(crlf, "/x/a.md", "project");
		expect(fromCrlf).not.toBeNull();
		expect(fromCrlf!.tools).toEqual(["read", "grep"]);
		expect(fromCrlf!.description).toBe("Does things");
		expect(fromCrlf!.systemPrompt).toBe(fromLf!.systemPrompt);
		expect(fromCrlf!.systemPrompt).not.toContain("\r");
	});
});

describe("FIX-ORCH: read-only sub-explorers", () => {
	it("never lists a nonexistent 'glob' tool", () => {
		expect(READONLY_EXPLORER_TOOLS).not.toContain("glob");
	});

	it("strips write-capable tools from the allowlist and excludes them explicitly", () => {
		const args = readOnlyToolArgs(["read", "write", "bash", "grep", "edit", "memory_write"]);
		const tools = args[args.indexOf("--tools") + 1].split(",");
		expect(tools).toEqual(["read", "grep"]);
		const excluded = args[args.indexOf("--exclude-tools") + 1].split(",");
		for (const t of ["write", "edit", "bash", "sandbox_run", "memory_write"]) expect(excluded).toContain(t);
		for (const t of tools) expect(WRITE_CAPABLE_TOOLS).not.toContain(t);
	});

	it("falls back to the read-only default when everything requested was write-capable", () => {
		const args = readOnlyToolArgs(["write", "bash"]);
		expect(args[args.indexOf("--tools") + 1]).toBe(READONLY_EXPLORER_TOOLS.join(","));
	});
});

describe("FIX-ORCH: model refs and phase prompts", () => {
	const available = [
		{ provider: "a", id: "m1" },
		{ provider: "b", id: "m1" },
		{ provider: "openrouter", id: "anthropic/claude-x" },
	];
	it("resolves provider/id refs (as written by /setup), bare ids and slashed ids", () => {
		expect(resolveModelRef(available, "b/m1")).toBe(available[1]);
		expect(resolveModelRef(available, "m1")).toBe(available[0]);
		expect(resolveModelRef(available, "openrouter/anthropic/claude-x")).toBe(available[2]);
		expect(resolveModelRef(available, "zz/none")).toBeUndefined();
	});
	it("composes the persona after the base prompt instead of replacing it", () => {
		const out = composePhaseSystemPrompt("BASE\n", "You are the EXPLORE agent.");
		expect(out.startsWith("BASE")).toBe(true);
		expect(out).toContain("You are the EXPLORE agent.");
		expect(composePhaseSystemPrompt(undefined, "P")).toContain("P");
	});
});

describe("FIX-ORCH: live model persistence", () => {
	it("keeps OpenAI reasoning and vision instead of persisting reasoning:false text-only", () => {
		const gpt5 = toPersistedModel(withOpenAICapabilities({ id: "gpt-5.4" }));
		expect(gpt5.reasoning).toBe(true);
		expect(gpt5.input).toEqual(["text", "image"]);
		const gpt4o = toPersistedModel(withOpenAICapabilities({ id: "gpt-4o" }));
		expect(gpt4o.reasoning).toBe(false);
		expect(gpt4o.input).toEqual(["text", "image"]);
		const o3mini = toPersistedModel(withOpenAICapabilities({ id: "o3-mini" }));
		expect(o3mini.reasoning).toBe(true);
		expect(o3mini.input).toEqual(["text"]);
	});
	it("defaults unknown models to text-only input", () => {
		expect(toPersistedModel({ id: "x" }).input).toEqual(["text"]);
	});
});

describe("FIX-ORCH: OpenCode Go env var", () => {
	const entry = getProviderCatalog().find((p) => p.id === "opencode-go")!;
	it("reads the variable the built-in provider uses (OPENCODE_API_KEY) first", () => {
		expect(catalogEnvKey(entry, { OPENCODE_API_KEY: "k1", OPENCODE_GO_API_KEY: "k2" })).toEqual({
			name: "OPENCODE_API_KEY",
			value: "k1",
		});
	});
	it("still accepts the legacy OPENCODE_GO_API_KEY", () => {
		expect(catalogEnvKey(entry, { OPENCODE_GO_API_KEY: "k2" })?.name).toBe("OPENCODE_GO_API_KEY");
		expect(catalogEnvKey(entry, {})).toBeUndefined();
	});
});

describe("FIX-ORCH: /benchmark only calls models through an API they speak", () => {
	const target = (api: string) => ({ id: "m", provider: "p", baseUrl: "https://x", apiKey: "k", api });
	it("keeps unregistered openai-completions endpoints (raw chat/completions is correct for them)", () => {
		expect(isBenchmarkable(target("openai-completions"), undefined)).toBe(true);
	});
	it("drops an unregistered Anthropic-API model instead of sending it chat/completions", () => {
		expect(isBenchmarkable(target("anthropic-messages"), undefined)).toBe(false);
	});
	it("keeps any API when the registry knows the model (called through the registry)", () => {
		const registry = { find: () => ({ id: "m" }) as never, getApiKeyAndHeaders: async () => ({ ok: true as const }) };
		expect(isBenchmarkable(target("anthropic-messages"), registry)).toBe(true);
	});
});

describe("FIX-ORCH: execution shell and process tree", () => {
	it("runs a command through an explicit shell, argv and stdin transports (sync and async)", async () => {
		const viaStdin = { shell: process.execPath, args: ["-"], commandTransport: "stdin" as const };
		const viaArgv = { shell: process.execPath, args: ["-e"] };
		const code = "process.stdout.write('shell-ok')";
		expect(runCommand(code, { shell: viaStdin }).stdout).toBe("shell-ok");
		expect(runCommand(code, { shell: viaArgv }).stdout).toBe("shell-ok");
		expect((await runCommandAsync(code, { shell: viaStdin })).stdout).toBe("shell-ok");
		expect((await runCommandAsync(code, { shell: viaArgv })).stdout).toBe("shell-ok");
	});

	const bash = defaultLocalShell();
	it.skipIf(!bash || !existsSync(bash.shell) || bash.commandTransport === "stdin")(
		"the local sandbox backend runs commands with bash (not cmd.exe), like the bash tool",
		async () => {
			const sb = resolveSandbox({
				cwd: process.cwd(),
				deps: { dockerAvailable: false, listFiles: () => ["package.json"], readConfig: () => undefined },
			});
			expect(sb.backend).toBe("local");
			// Bash arithmetic expansion: cmd.exe would echo the text verbatim.
			const r = await sb.execAsync("echo $((20+22))");
			expect(passed(r)).toBe(true);
			expect(r.stdout.trim()).toBe("42");
			expect(sb.exec("echo $((1+1))").stdout.trim()).toBe("2");
		},
	);

	it.skipIf(process.platform === "win32")(
		"a POSIX timeout kills the whole tree (detached process group)",
		{ timeout: 30_000 },
		async () => {
			// The grandchild keeps the pipes open: without a process-group kill the
			// run only ends when it exits on its own (60 s).
			const r = await runCommandAsync(`node -e "setTimeout(()=>{},60000)" ; true`, { timeoutMs: 800 });
			expect(r.timedOut).toBe(true);
			expect(r.durationMs).toBeLessThan(15_000);
		},
	);
});
