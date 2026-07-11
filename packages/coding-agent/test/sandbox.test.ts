import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CommandResult, passed, runArgv } from "../extensions/phi/providers/execution.js";
import { probeDocker, resolveSandbox, type SandboxDeps } from "../extensions/phi/providers/sandbox.js";

const ok = (over: Partial<CommandResult> = {}): CommandResult => ({
	command: "x",
	exitCode: 0,
	stdout: "",
	stderr: "",
	durationMs: 1,
	timedOut: false,
	...over,
});

// A recording fake for runArgv: captures every docker invocation, returns scripted results.
function recorder(script: (file: string, args: string[]) => CommandResult) {
	const calls: { file: string; args: string[] }[] = [];
	const fn = (file: string, args: string[]) => {
		calls.push({ file, args });
		return script(file, args);
	};
	return { fn, calls };
}

describe("resolveSandbox — docker backend (injected, no daemon)", () => {
	const rec = recorder(() => ok({ stdout: "container-ran" }));
	const deps: SandboxDeps = {
		dockerAvailable: true,
		runArgv: rec.fn,
		listFiles: () => ["package.json", "package-lock.json"],
		readConfig: () => undefined,
	};
	const sb = resolveSandbox({ cwd: "/repo", deps });

	it("chooses docker for a known toolchain and describes the image", () => {
		expect(sb.backend).toBe("docker");
		expect(sb.describe()).toContain("node:20-slim");
		expect(sb.available()).toBe(true);
	});

	it("exec runs the command inside a container via docker run", () => {
		const r = sb.exec("pytest -q");
		expect(passed(r)).toBe(true);
		const call = rec.calls.at(-1)!;
		expect(call.file).toBe("docker");
		expect(call.args.slice(0, 2)).toEqual(["run", "--rm"]);
		expect(call.args).toEqual(expect.arrayContaining(["-v", "/repo:/work"]));
		expect(call.args.slice(-3)).toEqual(["sh", "-c", "pytest -q"]);
	});
});

describe("resolveSandbox — local backend when docker is unavailable", () => {
	const calls: string[] = [];
	const deps: SandboxDeps = {
		dockerAvailable: false,
		runCommand: (command) => {
			calls.push(command);
			return ok({ stdout: "host-ran" });
		},
		listFiles: () => ["package.json"],
		readConfig: () => undefined,
	};
	const sb = resolveSandbox({ cwd: "/repo", deps });

	it("runs on the host and does not use docker", () => {
		expect(sb.backend).toBe("local");
		const r = sb.exec("npm test");
		expect(r.stdout).toContain("host-ran");
		expect(calls).toContain("npm test");
	});
});

describe("resolveSandbox — honest UNAVAILABLE when docker demanded but absent", () => {
	const sb = resolveSandbox({
		cwd: "/repo",
		requested: "docker",
		deps: { dockerAvailable: false, listFiles: () => ["package.json"], readConfig: () => undefined },
	});

	it("reports unavailable and never fabricates a pass", () => {
		expect(sb.backend).toBe("unavailable");
		expect(sb.available()).toBe(false);
		const r = sb.exec("pytest");
		expect(r.exitCode).toBeNull();
		expect(passed(r)).toBe(false);
		expect(r.stderr).toContain("SANDBOX UNAVAILABLE");
	});
});

describe("resolveSandbox — config override + prepare", () => {
	it("honors an explicit image and backend from .phi/sandbox.json", () => {
		const rec = recorder(() => ok());
		const sb = resolveSandbox({
			cwd: "/repo",
			deps: {
				dockerAvailable: true,
				runArgv: rec.fn,
				listFiles: () => ["main.py", "requirements.txt"],
				readConfig: () => ({ backend: "docker", image: "python:3.11", env: { X: "1" } }),
			},
		});
		expect(sb.describe()).toContain("python:3.11");
		sb.exec("pytest");
		expect(rec.calls.at(-1)!.args).toEqual(expect.arrayContaining(["-e", "X=1", "python:3.11"]));
	});

	it("prepare() pulls the base image and runs the setup step", () => {
		const rec = recorder((_f, args) => (args[0] === "pull" ? ok({ stdout: "pulled" }) : ok({ stdout: "installed" })));
		const sb = resolveSandbox({
			cwd: "/repo",
			deps: {
				dockerAvailable: true,
				runArgv: rec.fn,
				listFiles: () => ["package.json", "package-lock.json"],
				readConfig: () => undefined,
			},
		});
		const p = sb.prepare();
		expect(p.ok).toBe(true);
		expect(rec.calls.some((c) => c.args[0] === "pull")).toBe(true);
		// setup ran inside a container (docker run … npm ci)
		expect(rec.calls.some((c) => c.args.includes("npm ci || npm install"))).toBe(true);
	});

	it("prepare() builds a project Dockerfile and switches the effective image", () => {
		const rec = recorder((_f, args) => (args[0] === "build" ? ok() : ok()));
		const sb = resolveSandbox({
			cwd: "/repo",
			deps: {
				dockerAvailable: true,
				runArgv: rec.fn,
				listFiles: () => ["go.mod", "Dockerfile"],
				readConfig: () => undefined,
			},
		});
		const p = sb.prepare();
		expect(p.ok).toBe(true);
		expect(p.detail).toContain("Dockerfile");
		// subsequent exec uses the built tag, not the base image
		sb.exec("go test ./...");
		const runCall = rec.calls.find((c) => c.args[0] === "run")!;
		expect(runCall.args.some((a) => a.startsWith("phi-sandbox:"))).toBe(true);
	});
});

// ─── Docker-gated smoke: one real container run (skipped when no daemon) ──
const dockerUp = probeDocker(runArgv);
describe.runIf(dockerUp)("resolveSandbox — real docker smoke", () => {
	const tmp = mkdtempSync(join(tmpdir(), "sb-smoke-"));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	it("runs a real command inside a container and reports the true exit code", () => {
		const sb = resolveSandbox({
			cwd: tmp,
			requested: "docker",
			// tiny image, forced via config so the smoke does not pull a large base
			deps: { readConfig: () => ({ image: "alpine", backend: "docker" }), listFiles: () => [] },
		});
		expect(sb.backend).toBe("docker");
		const good = sb.exec("echo sandbox-smoke-ok");
		expect(passed(good)).toBe(true);
		expect(good.stdout).toContain("sandbox-smoke-ok");

		// The exit code is the container's real one — the guarantee the design needs.
		const bad = sb.exec("exit 7");
		expect(bad.exitCode).toBe(7);
		expect(passed(bad)).toBe(false);
	}, 120000);
});
