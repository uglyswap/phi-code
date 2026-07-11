/**
 * Sandbox planning — the pure core that turns "what project is this?" into "how
 * do I run its code in a guaranteed environment?" (docs/design/plan-debug-build.md,
 * §Execution grounding).
 *
 * The SWE-bench measurement was defeated because the host Python was too new to
 * run the target library, so the model reconstructed a mock and graded itself.
 * A per-project container fixes that: run the real reproduction/suite with the
 * project's real toolchain. Everything here is pure (no fs, no spawn) so the
 * toolchain detection, the recipe, the backend decision, and — critically — the
 * `docker run` argv (where the Windows path/quoting bugs live) are all unit-tested.
 */

export type ToolchainKind = "node" | "python" | "go" | "rust" | "ruby" | "unknown";

export interface Toolchain {
	kind: ToolchainKind;
	/** The marker file that determined it (e.g. "package.json"). */
	marker: string | null;
	hasDockerfile: boolean;
	hasCompose: boolean;
}

/** `.phi/sandbox.json` — explicit project override, always wins over detection. */
export interface SandboxConfig {
	backend?: "docker" | "local" | "auto";
	image?: string;
	setup?: string;
	test?: string;
	workdir?: string;
	env?: Record<string, string>;
	/** Allow network inside the container (default true — deps often need it). */
	network?: boolean;
	memory?: string;
	cpus?: string;
}

export type RecipeSource = "detected" | "dockerfile" | "config";

export interface SandboxRecipe {
	image: string;
	/** One-off dependency install, run against the mounted project. */
	setup?: string;
	/** Best-guess suite command (a floor; the caller may override). */
	test?: string;
	workdir: string;
	env: Record<string, string>;
	network: boolean;
	memory?: string;
	cpus?: string;
	source: RecipeSource;
}

const MOUNT_WORKDIR = "/work";

const BASE_IMAGES: Record<Exclude<ToolchainKind, "unknown">, string> = {
	node: "node:20-slim",
	python: "python:3.12-slim",
	go: "golang:1.22-bookworm",
	rust: "rust:1-slim",
	ruby: "ruby:3-slim",
};

const DEFAULT_ENV: Record<ToolchainKind, Record<string, string>> = {
	node: { CI: "1" },
	// PYTHONSAFEPATH stops a stray local module from shadowing the stdlib (the
	// `select.py`/`resource` class of failures seen in the SWE-bench harness).
	python: { PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1" },
	go: {},
	rust: {},
	ruby: {},
	unknown: {},
};

/** Detect the toolchain from a project's top-level file names. Order = priority. */
export function detectToolchain(files: string[]): Toolchain {
	const set = new Set(files.map((f) => f.trim()).filter(Boolean));
	const has = (name: string) => set.has(name);
	const hasDockerfile = has("Dockerfile");
	const hasCompose = has("docker-compose.yml") || has("compose.yml") || has("docker-compose.yaml");

	let kind: ToolchainKind = "unknown";
	let marker: string | null = null;
	if (has("package.json")) {
		kind = "node";
		marker = "package.json";
	} else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
		kind = "python";
		marker = has("pyproject.toml") ? "pyproject.toml" : has("requirements.txt") ? "requirements.txt" : "setup.py";
	} else if (has("go.mod")) {
		kind = "go";
		marker = "go.mod";
	} else if (has("Cargo.toml")) {
		kind = "rust";
		marker = "Cargo.toml";
	} else if (has("Gemfile")) {
		kind = "ruby";
		marker = "Gemfile";
	}
	return { kind, marker, hasDockerfile, hasCompose };
}

function detectedSetup(tc: Toolchain, files: Set<string>): string | undefined {
	switch (tc.kind) {
		case "node":
			return files.has("package-lock.json") ? "npm ci || npm install" : "npm install";
		case "python":
			if (files.has("pyproject.toml") || files.has("setup.py")) return "pip install -e . || pip install .";
			if (files.has("requirements.txt")) return "pip install -r requirements.txt";
			return undefined;
		case "go":
			return "go mod download";
		case "rust":
			return "cargo fetch";
		case "ruby":
			return "bundle install";
		default:
			return undefined;
	}
}

function detectedTest(tc: Toolchain): string | undefined {
	switch (tc.kind) {
		case "node":
			return "npm test";
		case "python":
			return "pytest";
		case "go":
			return "go test ./...";
		case "rust":
			return "cargo test";
		case "ruby":
			return "bundle exec rake test";
		default:
			return undefined;
	}
}

/**
 * Build the environment recipe from detected toolchain + files. A project
 * Dockerfile is honored (source "dockerfile"); otherwise a base image is chosen.
 */
export function defaultRecipe(tc: Toolchain, files: string[] = []): SandboxRecipe {
	const set = new Set(files);
	const base: SandboxRecipe = {
		image: tc.kind === "unknown" ? "debian:bookworm-slim" : BASE_IMAGES[tc.kind],
		setup: detectedSetup(tc, set),
		test: detectedTest(tc),
		workdir: MOUNT_WORKDIR,
		env: { ...DEFAULT_ENV[tc.kind] },
		network: true,
		source: tc.hasDockerfile ? "dockerfile" : "detected",
	};
	return base;
}

/** Merge an explicit `.phi/sandbox.json` over a detected recipe (config wins). */
export function applyConfig(recipe: SandboxRecipe, config?: SandboxConfig): SandboxRecipe {
	if (!config) return recipe;
	return {
		image: config.image ?? recipe.image,
		setup: config.setup ?? recipe.setup,
		test: config.test ?? recipe.test,
		workdir: config.workdir ?? recipe.workdir,
		env: { ...recipe.env, ...(config.env ?? {}) },
		network: config.network ?? recipe.network,
		memory: config.memory ?? recipe.memory,
		cpus: config.cpus ?? recipe.cpus,
		source: config.image || config.setup ? "config" : recipe.source,
	};
}

export type Backend = "docker" | "local" | "unavailable";

export interface BackendSignals {
	dockerAvailable: boolean;
	requested?: "docker" | "local" | "auto";
	toolchainKnown: boolean;
	hasDockerfile: boolean;
}

export interface BackendDecision {
	backend: Backend;
	reason: string;
}

/**
 * Choose the execution backend, honestly. Docker is the guaranteed oracle but
 * only helps when we can containerize (a known toolchain or a Dockerfile). When
 * the caller explicitly demanded docker and it is absent, the answer is
 * `unavailable` — NOT a silent downgrade to a non-guaranteed local run.
 */
export function decideBackend(s: BackendSignals): BackendDecision {
	const req = s.requested ?? "auto";
	if (req === "local") return { backend: "local", reason: "backend: local (requested)" };
	if (req === "docker") {
		return s.dockerAvailable
			? { backend: "docker", reason: "backend: docker (requested, available)" }
			: { backend: "unavailable", reason: "docker requested but the daemon is not available" };
	}
	// auto
	if (s.dockerAvailable && (s.toolchainKnown || s.hasDockerfile)) {
		return { backend: "docker", reason: "backend: docker (guaranteed environment)" };
	}
	if (!s.dockerAvailable)
		return {
			backend: "local",
			reason: "backend: local (docker unavailable — runs are real but not dependency-guaranteed)",
		};
	return { backend: "local", reason: "backend: local (unknown toolchain, no Dockerfile — nothing to containerize)" };
}

/**
 * Normalize a host path into a Docker bind source. On Windows, forward-slash the
 * path but keep the drive colon (`C:/Users/…`) — the form Docker Desktop accepts
 * and, crucially, one that survives argv passing without MSYS mangling.
 */
export function toBindSource(hostPath: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return hostPath.replace(/\\/g, "/");
	return hostPath;
}

export interface DockerRunSpec {
	image: string;
	/** The command run inside the container via `sh -c`. */
	command: string;
	/** Host path to bind-mount as the workdir. */
	mountSource: string;
	workdir: string;
	env: Record<string, string>;
	network: boolean;
	memory?: string;
	cpus?: string;
	platform?: NodeJS.Platform;
}

/**
 * Build the argv passed to `docker` (after the program name). Pure and total, so
 * the exact invocation — mount, workdir, env, network isolation, resource caps —
 * is asserted in tests instead of discovered in production.
 */
export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
	const bind = `${toBindSource(spec.mountSource, spec.platform)}:${spec.workdir}`;
	const args: string[] = ["run", "--rm", "-v", bind, "-w", spec.workdir];
	for (const [k, v] of Object.entries(spec.env)) {
		args.push("-e", `${k}=${v}`);
	}
	if (!spec.network) args.push("--network", "none");
	if (spec.memory) args.push("--memory", spec.memory);
	if (spec.cpus) args.push("--cpus", spec.cpus);
	args.push(spec.image, "sh", "-c", spec.command);
	return args;
}

/** A small, dependency-free deterministic hash (djb2) for cache tags. */
function djb2(input: string): string {
	let h = 5381;
	for (let i = 0; i < input.length; i++) {
		h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** Deterministic image tag for a built recipe (project Dockerfile / config). */
export function imageTagFor(recipe: SandboxRecipe): string {
	return `phi-sandbox:${djb2(`${recipe.image}|${recipe.setup ?? ""}|${recipe.workdir}`)}`;
}

/** Generate a minimal Dockerfile for a detected recipe (utility / persistence). */
export function generatedDockerfile(recipe: SandboxRecipe): string {
	const envLines = Object.entries(recipe.env).map(([k, v]) => `ENV ${k}=${v}`);
	return [`FROM ${recipe.image}`, `WORKDIR ${recipe.workdir}`, ...envLines, ""].join("\n");
}
