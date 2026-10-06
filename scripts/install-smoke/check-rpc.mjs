#!/usr/bin/env node
// Usage (isolated env set by smoke.mjs): node check-rpc.mjs <runDir>
// Starts the installed CLI in RPC mode (--offline, a fake key so a model can be
// selected, nothing is ever sent), declines every extension prompt, then:
// get_commands / get_state, and the extension commands /agents, /skills, /mcp,
// whose notify output proves the bundled agents, skills and the MCP server are listed.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { layout, result } from "./common.mjs";

const l = layout(process.argv[2]);
const env = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-install-smoke-not-a-real-key" };
const child = spawn(process.execPath, [l.cli, "--offline", "--mode", "rpc", "--provider", "anthropic"], {
	cwd: l.work,
	env,
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => {
	stderr += d;
});
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const pending = new Map();
const request = (msg, timeoutMs = 60_000) =>
	new Promise((resolve, reject) => {
		pending.set(msg.id, resolve);
		send(msg);
		setTimeout(() => reject(new Error(`no response to ${msg.type} ${msg.id} within ${timeoutMs} ms`)), timeoutMs).unref();
	});
const notifications = [];
const nonJson = [];
let lastActivity = Date.now();
createInterface({ input: child.stdout }).on("line", (line) => {
	lastActivity = Date.now();
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		nonJson.push(line);
		return;
	}
	if (msg.type === "extension_ui_request") {
		if (msg.method === "confirm") send({ type: "extension_ui_response", id: msg.id, confirmed: false });
		else if (["select", "input", "editor"].includes(msg.method)) send({ type: "extension_ui_response", id: msg.id, cancelled: true });
		else if (msg.method === "notify") notifications.push(String(msg.message ?? ""));
		return;
	}
	if (msg.type === "response" && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
});
let exited = null;
child.on("exit", (code, signal) => {
	exited = { code, signal };
});

const problems = [];
try {
	// Let startup prompts (first-run wizard, trust) settle before querying.
	const startDeadline = Date.now() + 30_000;
	await new Promise((r) => setTimeout(r, 3000));
	while (Date.now() - lastActivity < 1500 && Date.now() < startDeadline) await new Promise((r) => setTimeout(r, 300));
	if (exited) throw new Error(`phi exited during startup: ${JSON.stringify(exited)}`);

	const cmds = await request({ id: "cmds", type: "get_commands" });
	const state = await request({ id: "state", type: "get_state" });
	const commands = cmds.data?.commands ?? [];
	const bySource = {};
	for (const c of commands) (bySource[c.source] ??= []).push(c.name);
	console.log(`commands: ${commands.length}`);
	for (const [source, names] of Object.entries(bySource)) console.log(`  ${source}: ${names.join(", ")}`);
	console.log(`model: ${state.data?.model?.provider}/${state.data?.model?.id}`);
	if (!cmds.success || commands.length === 0) problems.push("get_commands failed");
	if (!state.success) problems.push("get_state failed");
	for (const needed of ["agents", "skills", "mcp", "plan", "setup"]) {
		if (!commands.some((c) => c.name === needed)) problems.push(`command /${needed} missing`);
	}
	const skillDirs = readdirSync(join(l.pkgDir, "skills"));
	const skillCommands = (bySource.skill ?? []).map((n) => n.replace(/^skill:/, ""));
	const missingSkills = skillDirs.filter((s) => !skillCommands.includes(s));
	if (missingSkills.length) problems.push(`skill commands missing: ${missingSkills.join(", ")}`);

	for (const command of ["/agents", "/skills", "/mcp"]) {
		const before = notifications.length;
		const res = await request({ id: command, type: "prompt", message: command });
		const deadline = Date.now() + 15_000;
		while (notifications.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		const text = notifications.slice(before).join("\n");
		console.log(`--- ${command} (success=${res.success}) ---\n${text.slice(0, 1500)}`);
		if (!res.success) problems.push(`${command} failed: ${JSON.stringify(res.error ?? res)}`);
		if (command === "/agents") {
			const agentNames = readdirSync(join(l.pkgDir, "agents")).map((f) => f.replace(/\.md$/, ""));
			const missingAgents = agentNames.filter((a) => !text.toLowerCase().includes(a));
			if (missingAgents.length) problems.push(`/agents does not list: ${missingAgents.join(", ")}`);
		}
		if (command === "/skills" && !text.trim()) problems.push("/skills printed nothing");
		if (command === "/mcp" && !/smoke/.test(text)) problems.push("/mcp does not list the smoke server");
	}
} catch (error) {
	problems.push(error.message);
}
if (nonJson.length) problems.push(`non-JSON lines on stdout (RPC protocol corruption): ${nonJson.slice(0, 3).join(" | ")}`);
console.log(`stderr:\n${stderr.trim() || "(empty)"}`);
child.kill();
result(problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : "RPC answers, agents/skills/mcp listed");
setTimeout(() => process.exit(), 1000).unref();
