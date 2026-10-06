#!/usr/bin/env node
// Usage (isolated env set by smoke.mjs): node check-browser.mjs <runDir>
// Drives the bundled browser extension of the INSTALLED phi (Camoufox through
// @phi-code-admin/camofox-browser): browser_navigate to https://example.com,
// then browser_extract on the same tab. The Camoufox binary must have been
// downloaded by the camoufox-js postinstall; if it was not, this check FAILS
// and says so (it is never silently skipped).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { layout, result } from "./common.mjs";

const l = layout(process.argv[2]);
const withTimeout = (promise, ms, label) =>
	Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms))]);
const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n");

// Where the camoufox-js postinstall extracts the binary (same rules as its cacheRoot()).
const cacheRoot =
	process.platform === "darwin"
		? join(homedir(), "Library", "Caches", "phi-code", "camoufox")
		: process.platform === "win32"
			? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "phi-code", "camoufox")
			: join(homedir(), ".cache", "phi-code", "camoufox");
const cached = existsSync(cacheRoot) ? readdirSync(cacheRoot, { recursive: true }).length : 0;
console.log(`Camoufox cache ${cacheRoot}: ${cached ? `${cached} entries` : "ABSENT"}`);
if (!cached) {
	result("FAIL", `Camoufox binary was not downloaded at install time (no ${cacheRoot}); see the camoufox-js postinstall output in the install step`);
	process.exit();
}

process.argv[1] = l.cli;
const phi = await import(pathToFileURL(join(l.pkgDir, "dist", "index.js")).href);
const { session } = await phi.createAgentSession({ cwd: l.work, sessionManager: phi.SessionManager.inMemory() });
await withTimeout(session.bindExtensions({ mode: "print" }), 120_000, "session_start");
const ctx = session.extensionRunner.createContext();
const signal = new AbortController().signal;
const call = (name, params) =>
	withTimeout(session.getToolDefinition(name).execute(`smoke-${name}`, params, signal, () => {}, ctx), 240_000, name);

const problems = [];
try {
	const nav = await call("browser_navigate", { url: "https://example.com" });
	const navText = textOf(nav);
	console.log(`browser_navigate: ${navText.slice(0, 300)}`);
	if (nav.isError) throw new Error(`browser_navigate error: ${navText.slice(0, 500)}`);
	const tabId = JSON.parse(navText).tabId;
	const ex = await call("browser_extract", { tabId, mode: "text" });
	const exText = textOf(ex);
	console.log(`browser_extract: ${exText.slice(0, 400)}`);
	if (ex.isError || !/Example Domain/.test(exText)) problems.push(`extract did not return the example.com text`);
} catch (error) {
	problems.push(String(error?.stack ?? error).split("\n").slice(0, 4).join(" | "));
} finally {
	await withTimeout(session.extensionRunner.emit({ type: "session_shutdown" }), 30_000, "session_shutdown").catch((e) =>
		console.log(e.message),
	);
	session.dispose();
}
result(problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : "navigated to example.com and extracted its text");
setTimeout(() => process.exit(), 1000).unref();
