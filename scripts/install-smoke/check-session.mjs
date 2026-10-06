#!/usr/bin/env node
// Usage (isolated env set by smoke.mjs): node check-session.mjs <runDir>
// Creates a real phi session from the INSTALLED package through its public SDK
// (same resource loader as the CLI: extensions, skills and mcp.json are read
// from PHI_CODING_AGENT_DIR), fires session_start, then drives the bundled
// tools directly: extensions load, ast_grep, memory (real embeddings + vector
// search), MCP (stdio test server), LSP (typescript-language-server), skills.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { layout, result } from "./common.mjs";

const l = layout(process.argv[2]);
if (process.env.PHI_CODING_AGENT_DIR !== l.agentDir) throw new Error("run through smoke.mjs (isolated env)");
const here = dirname(fileURLToPath(import.meta.url));
const checks = [];
const record = (name, ok, detail) => {
	checks.push({ name, ok });
	console.log(`CHECK ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};
const withTimeout = (promise, ms, label) =>
	Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms))]);
const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n");

// Workspace + global MCP config, before the session reads them.
writeFileSync(join(l.work, "sample.ts"), "export function hello(name: string) {\n\treturn `hi ${name}`;\n}\n");
writeFileSync(join(l.work, "broken.ts"), 'const count: number = "not a number";\nexport { count };\n');
writeFileSync(
	join(l.work, "tsconfig.json"),
	JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "nodenext" } }),
);
writeFileSync(
	join(l.agentDir, "mcp.json"),
	JSON.stringify(
		{
			mcpServers: {
				smoke: { command: process.execPath, args: [join(here, "mcp-test-server.mjs"), l.pkgDir], lifecycle: "eager" },
			},
		},
		null,
		2,
	),
);

// argv[1] = cli.js, as the bin shim runs it (some code locates assets from it).
process.argv[1] = l.cli;
const phi = await import(pathToFileURL(join(l.pkgDir, "dist", "index.js")).href);

const bundledExtDir = join(l.pkgDir, "extensions", "phi");
const expectedExtensions = readdirSync(bundledExtDir).filter((name) => {
	const full = join(bundledExtDir, name);
	return name.endsWith(".ts") || (statSync(full).isDirectory() && existsSync(join(full, "index.ts")));
});

const extensionErrors = [];
const { session, extensionsResult, modelFallbackMessage } = await phi.createAgentSession({
	cwd: l.work,
	sessionManager: phi.SessionManager.inMemory(),
});
if (modelFallbackMessage) console.log(`model: ${modelFallbackMessage}`);

// 1. Every bundled extension loads from the installed agent dir.
const loadedFromAgent = extensionsResult.extensions
	.map((e) => e.path)
	.filter((p) => p.startsWith(join(l.agentDir, "extensions")));
const loadedNames = new Set(loadedFromAgent.map((p) => (basename(p) === "index.ts" ? basename(dirname(p)) : basename(p))));
const missing = expectedExtensions.filter((n) => !loadedNames.has(n));
for (const e of extensionsResult.errors) console.log(`  extension error ${e.path}: ${e.error}`);
record(
	"extensions",
	extensionsResult.errors.length === 0 && missing.length === 0,
	`${loadedFromAgent.length}/${expectedExtensions.length} bundled extensions loaded from the agent dir, errors=${extensionsResult.errors.length}${missing.length ? `, missing=${missing.join(",")}` : ""}`,
);

await withTimeout(
	session.bindExtensions({ mode: "print", onError: (err) => extensionErrors.push(err) }),
	120_000,
	"session_start",
);
record(
	"session_start",
	extensionErrors.length === 0,
	extensionErrors.length ? extensionErrors.map((e) => `${e.extensionPath}: ${e.error}`).join(" | ") : "all handlers ran",
);

const toolNames = session.getAllTools().map((t) => t.name);
console.log(`tools (${toolNames.length}): ${toolNames.join(", ")}`);
const ctx = session.extensionRunner.createContext();
const signal = new AbortController().signal;
async function callTool(name, params, timeoutMs = 60_000) {
	const def = session.getToolDefinition(name);
	if (!def) throw new Error(`tool ${name} is not registered`);
	return withTimeout(def.execute(`smoke-${name}`, params, signal, () => {}, ctx), timeoutMs, name);
}
async function step(name, fn) {
	try {
		const [ok, detail] = await fn();
		record(name, ok, detail);
	} catch (error) {
		record(name, false, String(error?.stack ?? error).split("\n").slice(0, 4).join(" | "));
	}
}

// 2. ast_grep (native @ast-grep/napi through the extension).
await step("ast_grep", async () => {
	const text = textOf(await callTool("ast_grep", { pattern: "function $NAME($$$) { $$$ }", path: l.work, lang: "ts" }));
	return [/sample\.ts/.test(text) && /hello/.test(text), text.slice(0, 300).replace(/\s+/g, " ")];
});

// 3. Memory: write a note (embedded with the real model) then find it by vector search.
await step("memory_write (embedding)", async () => {
	const res = await callTool(
		"memory_write",
		{ content: "The deployment pipeline promotes builds with blue green releases.", file: "smoke-note.md" },
		10 * 60_000,
	);
	return [res.details?.vectorIndexed === true, textOf(res).slice(0, 300)];
});
await step("memory_search (vector)", async () => {
	const res = await callTool("memory_search", { query: "zero downtime rollout strategy" }, 5 * 60_000);
	const text = textOf(res);
	const vectorHit = /## VECTORS[\s\S]*smoke-note/.test(text);
	return [vectorHit, `sources=${JSON.stringify(res.details?.sources)} ${text.slice(0, 300).replace(/\s+/g, " ")}`];
});

// 4. MCP: the eager stdio test server connects at session_start and its tool is bridged.
await step("mcp (stdio server tool call)", async () => {
	const deadline = Date.now() + 90_000;
	while (!session.getToolDefinition("mcp_smoke_echo") && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
	}
	const text = textOf(await callTool("mcp_smoke_echo", { text: "hello-phi" }));
	return [text.includes("echo:hello-phi"), text.slice(0, 200)];
});

// 5. LSP: diagnostics from typescript-language-server (installed on PATH by the workflow).
await step("lsp (typescript diagnostics)", async () => {
	const res = await callTool("lsp", { action: "diagnostics", path: "broken.ts" }, 120_000);
	const text = textOf(res);
	return [/not assignable|2322/i.test(text), text.slice(0, 300).replace(/\s+/g, " ")];
});

// 6. Bundled skills are discovered from the agent dir.
await step("skills", async () => {
	const expected = readdirSync(join(l.pkgDir, "skills")).filter((n) => statSync(join(l.pkgDir, "skills", n)).isDirectory());
	const loaded = session.resourceLoader.getSkills().skills.map((s) => s.name);
	const missingSkills = expected.filter((n) => !loaded.includes(n));
	return [missingSkills.length === 0, `${loaded.length} skills: ${loaded.join(", ")}${missingSkills.length ? ` | missing: ${missingSkills.join(", ")}` : ""}`];
});

try {
	await withTimeout(session.extensionRunner.emit({ type: "session_shutdown" }), 15_000, "session_shutdown");
} catch (error) {
	console.log(`session_shutdown: ${error.message}`);
}
session.dispose();
const failed = checks.filter((c) => !c.ok).map((c) => c.name);
result(failed.length ? "FAIL" : "PASS", failed.length ? `failed: ${failed.join(", ")}` : `${checks.length} checks passed`);
setTimeout(() => process.exit(), 500).unref();
