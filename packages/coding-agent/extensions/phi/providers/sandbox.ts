/**
 * Sandbox — the thin IO shell over the pure planner (sandbox-plan.ts). It turns
 * a project directory into a runnable environment and executes commands in it,
 * returning the same CommandResult the oracle cores already consume. Three
 * backends: `docker` (the guaranteed environment), `local` (real runs, but not
 * dependency-guaranteed), and `unavailable` (honest — every exec reports it
 * could not run, so /debug and /build emit BLOCKED instead of a fabricated pass).
 *
 * The fs reads and spawns are injectable so the routing/interpretation is
 * unit-tested without a Docker daemon; a separate docker-gated smoke test does
 * one real container run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CommandResult,
	passed,
	type RunOptions,
	runArgv as realRunArgv,
	runArgvAsync as realRunArgvAsync,
	runCommand as realRunCommand,
	runCommandAsync as realRunCommandAsync,
} from "./execution.ts";
import {
	applyConfig,
	type Backend,
	buildDockerRunArgs,
	decideBackend,
	defaultRecipe,
	detectToolchain,
	imageTagFor,
	type SandboxConfig,
	type SandboxRecipe,
} from "./sandbox-plan.ts";

export interface PrepareResult {
	ok: boolean;
	backend: Backend;
	detail: string;
	result?: CommandResult;
}

export interface Sandbox {
	readonly backend: Backend;
	readonly recipe: SandboxRecipe;
	readonly reason: string;
	describe(): string;
	available(): boolean;
	/** Run a command in the environment. Never throws (see execution.js). */
	exec(command: string, options?: RunOptions): CommandResult;
	/**
	 * ASYNC twin of exec — non-blocking (the drift fix): the event loop stays
	 * alive during the run, so session/phase timers fire on time and the run's
	 * own timeout kills the process tree. Agent-facing paths (sandbox_run) MUST
	 * use this; sync exec remains for bounded driver-internal steps.
	 */
	execAsync(command: string, options?: RunOptions): Promise<CommandResult>;
	/** Build the image / install deps. Idempotent, best-effort. */
	prepare(): PrepareResult;
}

type RunCommandFn = (command: string, options?: RunOptions) => CommandResult;
type RunArgvFn = (file: string, args: string[], options?: RunOptions & { label?: string }) => CommandResult;
type RunCommandAsyncFn = (command: string, options?: RunOptions) => Promise<CommandResult>;
type RunArgvAsyncFn = (
	file: string,
	args: string[],
	options?: RunOptions & { label?: string },
) => Promise<CommandResult>;

/** Injectable seams — real fs/spawn by default, fakes in tests. */
export interface SandboxDeps {
	runCommand?: RunCommandFn;
	runArgv?: RunArgvFn;
	runCommandAsync?: RunCommandAsyncFn;
	runArgvAsync?: RunArgvAsyncFn;
	listFiles?: (cwd: string) => string[];
	readConfig?: (cwd: string) => SandboxConfig | undefined;
	/** Force docker availability in tests; otherwise probed via `docker version`. */
	dockerAvailable?: boolean;
}

export interface ResolveOptions {
	cwd: string;
	requested?: "docker" | "local" | "auto";
	deps?: SandboxDeps;
}

/** List a project's top-level entries (best-effort; empty on error). */
export function listProjectFiles(cwd: string): string[] {
	try {
		return readdirSync(cwd);
	} catch {
		return [];
	}
}

/** Read and parse `.phi/sandbox.json` if present. */
export function readSandboxConfig(cwd: string): SandboxConfig | undefined {
	try {
		const raw = readFileSync(join(cwd, ".phi", "sandbox.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as SandboxConfig) : undefined;
	} catch {
		return undefined;
	}
}

/** Probe the Docker daemon (server version reachable). Cheap, capped timeout. */
export function probeDocker(ra: RunArgvFn): boolean {
	const r = ra("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000, label: "docker version" });
	return passed(r) && r.stdout.trim().length > 0;
}

const UNAVAILABLE_MESSAGE = "SANDBOX UNAVAILABLE — no executable environment; do not fabricate a result, emit BLOCKED.";

function unavailableResult(command: string): CommandResult {
	return { command, exitCode: null, stdout: "", stderr: UNAVAILABLE_MESSAGE, durationMs: 0, timedOut: false };
}

/**
 * Resolve the sandbox for a project directory: detect toolchain, merge config,
 * decide the backend honestly, and return an executor. Docker exec runs
 * `docker run --rm -v <cwd>:/work …`; edits land on the host mount, so /debug's
 * fix-then-rerun works and the container stays ephemeral.
 */
export function resolveSandbox(opts: ResolveOptions): Sandbox {
	const deps = opts.deps ?? {};
	const rc = deps.runCommand ?? realRunCommand;
	const ra = deps.runArgv ?? realRunArgv;
	const rcAsync = deps.runCommandAsync ?? realRunCommandAsync;
	const raAsync = deps.runArgvAsync ?? realRunArgvAsync;
	const files = (deps.listFiles ?? listProjectFiles)(opts.cwd);
	const config = (deps.readConfig ?? readSandboxConfig)(opts.cwd);
	const tc = detectToolchain(files);
	const recipe = applyConfig(defaultRecipe(tc, files), config);
	const requested = opts.requested ?? config?.backend ?? "auto";
	const dockerAvailable = deps.dockerAvailable ?? probeDocker(ra);
	const decision = decideBackend({
		dockerAvailable,
		requested,
		toolchainKnown: tc.kind !== "unknown",
		hasDockerfile: tc.hasDockerfile,
	});

	// Effective image can change after prepare() builds a project Dockerfile.
	const state = { image: recipe.image };

	const dockerArgsFor = (command: string) =>
		buildDockerRunArgs({
			image: state.image,
			command,
			mountSource: opts.cwd,
			workdir: recipe.workdir,
			env: recipe.env,
			network: recipe.network,
			memory: recipe.memory,
			cpus: recipe.cpus,
		});
	const dockerExec = (command: string, options?: RunOptions): CommandResult =>
		ra("docker", dockerArgsFor(command), {
			cwd: opts.cwd,
			timeoutMs: options?.timeoutMs,
			label: `docker[${state.image}] ${command}`,
		});
	const dockerExecAsync = (command: string, options?: RunOptions): Promise<CommandResult> =>
		raAsync("docker", dockerArgsFor(command), {
			cwd: opts.cwd,
			timeoutMs: options?.timeoutMs,
			label: `docker[${state.image}] ${command}`,
		});

	const base = { backend: decision.backend, recipe, reason: decision.reason };

	if (decision.backend === "unavailable") {
		return {
			...base,
			describe: () => `unavailable — ${decision.reason}`,
			available: () => false,
			exec: (command) => unavailableResult(command),
			execAsync: async (command) => unavailableResult(command),
			prepare: () => ({ ok: false, backend: "unavailable", detail: decision.reason }),
		};
	}

	if (decision.backend === "local") {
		return {
			...base,
			describe: () => `local host (${opts.cwd})`,
			available: () => true,
			exec: (command, options) => rc(command, { cwd: opts.cwd, ...options }),
			execAsync: (command, options) => rcAsync(command, { cwd: opts.cwd, ...options }),
			// Deliberately no host-side dependency install — running `npm install`
			// etc. on the user's host is intrusive; local is best-effort as-is.
			prepare: () => ({ ok: true, backend: "local", detail: "local host — no preparation performed" }),
		};
	}

	// docker
	return {
		...base,
		describe: () => `docker (${state.image})`,
		available: () => true,
		exec: dockerExec,
		execAsync: dockerExecAsync,
		prepare: () => {
			if (recipe.source === "dockerfile") {
				const tag = imageTagFor(recipe);
				const built = ra("docker", ["build", "-t", tag, "-f", "Dockerfile", "."], {
					cwd: opts.cwd,
					label: `docker build ${tag}`,
				});
				if (passed(built)) state.image = tag;
				return {
					ok: passed(built),
					backend: "docker",
					detail: passed(built) ? `built image ${tag} from Dockerfile` : "docker build failed",
					result: built,
				};
			}
			// Base image: pull it, then run the dependency setup against the mount.
			const pulled = ra("docker", ["pull", state.image], { cwd: opts.cwd, label: `docker pull ${state.image}` });
			if (!recipe.setup) {
				return {
					ok: passed(pulled),
					backend: "docker",
					detail: `pulled ${state.image} (no setup step)`,
					result: pulled,
				};
			}
			const setup = dockerExec(recipe.setup);
			return {
				ok: passed(setup),
				backend: "docker",
				detail: passed(setup)
					? `pulled ${state.image}; ran setup \`${recipe.setup}\``
					: `setup failed: \`${recipe.setup}\``,
				result: setup,
			};
		},
	};
}
