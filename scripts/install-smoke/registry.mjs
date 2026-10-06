#!/usr/bin/env node
// Local npm registry for the install smoke test.
//
//   node scripts/install-smoke/registry.mjs start <workDir> <packages.json>
//     Installs verdaccio into <workDir>/verdaccio-tool, starts it on 127.0.0.1:4873
//     (detached, logs in <workDir>/verdaccio.log), creates a throwaway user and
//     writes <workDir>/npmrc. The phi packages are served ONLY from local storage
//     (never proxied: the versions under test are not on npmjs yet); every other
//     package is proxied from registry.npmjs.org.
//   node scripts/install-smoke/registry.mjs publish <workDir> <packages.json>
//     Publishes the packed tarballs (in dependency order) to the local registry.
//   node scripts/install-smoke/registry.mjs stop <workDir>
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnNpmSync } from "../npm-command.mjs";

const VERDACCIO = "verdaccio@6.10.5";
const PORT = 4873;
const REGISTRY = `http://127.0.0.1:${PORT}/`;

const [command, workArg, packagesArg] = process.argv.slice(2);
if (!command || !workArg) {
	console.error("Usage: registry.mjs <start|publish|stop> <workDir> [packages.json]");
	process.exit(2);
}
const workDir = resolve(workArg);
mkdirSync(workDir, { recursive: true });
const npmrcPath = join(workDir, "npmrc");

function readPackages() {
	if (!packagesArg) throw new Error("packages.json path is required");
	return JSON.parse(readFileSync(resolve(packagesArg), "utf8"));
}

function npm(args, options = {}) {
	const res = spawnNpmSync(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
	if (res.status !== 0) {
		throw new Error(`npm ${args.join(" ")} failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
	}
	return res.stdout;
}

function writeConfig(packages) {
	const storage = join(workDir, "storage").replace(/\\/g, "/");
	const htpasswd = join(workDir, "htpasswd").replace(/\\/g, "/");
	const local = packages
		.map((p) => `  '${p.name}':\n    access: $all\n    publish: $authenticated\n`)
		.join("");
	const config = `storage: '${storage}'
auth:
  htpasswd:
    file: '${htpasswd}'
    max_users: 10
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    timeout: 120s
    max_fails: 10
packages:
${local}  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs
server:
  keepAliveTimeout: 60
max_body_size: 500mb
listen: 127.0.0.1:${PORT}
log: { type: stdout, format: pretty, level: warn }
`;
	const path = join(workDir, "verdaccio.yaml");
	writeFileSync(path, config);
	return path;
}

async function waitForPing(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`${REGISTRY}-/ping`);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error(`verdaccio did not answer on ${REGISTRY} within ${timeoutMs} ms`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

async function start() {
	const packages = readPackages();
	const toolDir = join(workDir, "verdaccio-tool");
	mkdirSync(toolDir, { recursive: true });
	writeFileSync(join(toolDir, "package.json"), '{ "name": "verdaccio-tool", "private": true }\n');
	console.log(`installing ${VERDACCIO}...`);
	npm(["install", VERDACCIO, "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"], {
		cwd: toolDir,
	});
	const config = writeConfig(packages);
	const bin = join(toolDir, "node_modules", "verdaccio", "bin", "verdaccio");
	const logFd = openSync(join(workDir, "verdaccio.log"), "a");
	const child = spawn(process.execPath, [bin, "--config", config], {
		cwd: workDir,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		windowsHide: true,
	});
	child.unref();
	closeSync(logFd);
	writeFileSync(join(workDir, "verdaccio.pid"), String(child.pid));
	await waitForPing(60_000);
	console.log(`verdaccio up on ${REGISTRY} (pid ${child.pid})`);

	// Throwaway local user: the token only authorizes publishing to this local registry.
	const password = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const res = await fetch(`${REGISTRY}-/user/org.couchdb.user:smoke`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "smoke", password, type: "user", roles: [], date: new Date().toISOString() }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || typeof body.token !== "string") {
		throw new Error(`could not create the local registry user (HTTP ${res.status})`);
	}
	writeFileSync(npmrcPath, `registry=${REGISTRY}\n//127.0.0.1:${PORT}/:_authToken=${body.token}\n`);
	console.log(`npmrc written to ${npmrcPath}`);
}

function publish() {
	if (!existsSync(npmrcPath)) throw new Error(`${npmrcPath} missing: run 'start' first`);
	for (const pkg of readPackages()) {
		npm(["publish", pkg.tarball, "--userconfig", npmrcPath, "--registry", REGISTRY, "--ignore-scripts", "--tag", "latest"], {
			cwd: workDir,
		});
		console.log(`published ${pkg.name}@${pkg.version}`);
	}
}

function stop() {
	const pidFile = join(workDir, "verdaccio.pid");
	if (!existsSync(pidFile)) return;
	try {
		process.kill(Number(readFileSync(pidFile, "utf8")));
		console.log("verdaccio stopped");
	} catch (error) {
		console.log(`verdaccio stop: ${error.message}`);
	}
}

try {
	if (command === "start") await start();
	else if (command === "publish") publish();
	else if (command === "stop") stop();
	else throw new Error(`unknown command ${command}`);
} catch (error) {
	console.error(`registry ${command} failed: ${error.message}`);
	process.exit(1);
}
