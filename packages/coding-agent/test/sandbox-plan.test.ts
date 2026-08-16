import { describe, expect, it } from "vitest";
import {
	applyConfig,
	buildDockerRunArgs,
	decideBackend,
	defaultRecipe,
	detectToolchain,
	generatedDockerfile,
	imageTagFor,
	type SandboxRecipe,
	toBindSource,
} from "../extensions/phi/providers/sandbox-plan.ts";

describe("detectToolchain", () => {
	it("detects node from package.json", () => {
		const tc = detectToolchain(["package.json", "src", "README.md"]);
		expect(tc.kind).toBe("node");
		expect(tc.marker).toBe("package.json");
	});
	it("detects python from any of pyproject/requirements/setup", () => {
		expect(detectToolchain(["requirements.txt"]).kind).toBe("python");
		expect(detectToolchain(["pyproject.toml"]).marker).toBe("pyproject.toml");
		expect(detectToolchain(["setup.py"]).kind).toBe("python");
	});
	it("detects go, rust, ruby", () => {
		expect(detectToolchain(["go.mod"]).kind).toBe("go");
		expect(detectToolchain(["Cargo.toml"]).kind).toBe("rust");
		expect(detectToolchain(["Gemfile"]).kind).toBe("ruby");
	});
	it("flags a Dockerfile and compose file", () => {
		const tc = detectToolchain(["package.json", "Dockerfile", "docker-compose.yml"]);
		expect(tc.hasDockerfile).toBe(true);
		expect(tc.hasCompose).toBe(true);
	});
	it("is unknown when nothing matches", () => {
		expect(detectToolchain(["notes.txt"]).kind).toBe("unknown");
	});
	it("prefers node over python when both present (priority order)", () => {
		expect(detectToolchain(["package.json", "requirements.txt"]).kind).toBe("node");
	});
});

describe("defaultRecipe", () => {
	it("picks a base image, setup and test per toolchain", () => {
		const r = defaultRecipe(detectToolchain(["package.json", "package-lock.json"]), [
			"package.json",
			"package-lock.json",
		]);
		expect(r.image).toContain("node");
		expect(r.setup).toContain("npm ci");
		expect(r.test).toBe("npm test");
		expect(r.workdir).toBe("/work");
	});
	it("sets PYTHONSAFEPATH for python (stops stdlib shadowing)", () => {
		const r = defaultRecipe(detectToolchain(["requirements.txt"]), ["requirements.txt"]);
		expect(r.env.PYTHONSAFEPATH).toBe("1");
		expect(r.setup).toContain("requirements.txt");
	});
	it("marks source=dockerfile when the project has one", () => {
		const r = defaultRecipe(detectToolchain(["go.mod", "Dockerfile"]), ["go.mod", "Dockerfile"]);
		expect(r.source).toBe("dockerfile");
	});
	it("falls back to a debian base for unknown toolchains", () => {
		const r = defaultRecipe(detectToolchain(["notes.txt"]));
		expect(r.image).toContain("debian");
		expect(r.setup).toBeUndefined();
	});
});

describe("applyConfig (explicit override wins)", () => {
	const base = defaultRecipe(detectToolchain(["package.json"]), ["package.json"]);
	it("overrides image/setup/test and merges env", () => {
		const r = applyConfig(base, { image: "node:22", setup: "pnpm i", env: { EXTRA: "1" } });
		expect(r.image).toBe("node:22");
		expect(r.setup).toBe("pnpm i");
		expect(r.env.EXTRA).toBe("1");
		expect(r.env.CI).toBe("1"); // preserved from base
		expect(r.source).toBe("config");
	});
	it("returns the recipe unchanged when no config", () => {
		expect(applyConfig(base, undefined)).toEqual(base);
	});
	it("keeps detected source when config only tweaks resources", () => {
		expect(applyConfig(base, { memory: "2g" }).source).toBe("detected");
	});
});

describe("decideBackend (honest)", () => {
	it("uses docker when available and containerizable (auto)", () => {
		expect(decideBackend({ dockerAvailable: true, toolchainKnown: true, hasDockerfile: false }).backend).toBe(
			"docker",
		);
	});
	it("falls back to local when docker is unavailable (auto)", () => {
		const d = decideBackend({ dockerAvailable: false, toolchainKnown: true, hasDockerfile: false });
		expect(d.backend).toBe("local");
		expect(d.reason).toMatch(/not dependency-guaranteed/);
	});
	it("stays local when toolchain is unknown and no Dockerfile (nothing to containerize)", () => {
		expect(decideBackend({ dockerAvailable: true, toolchainKnown: false, hasDockerfile: false }).backend).toBe(
			"local",
		);
	});
	it("containerizes an unknown toolchain if it has a Dockerfile", () => {
		expect(decideBackend({ dockerAvailable: true, toolchainKnown: false, hasDockerfile: true }).backend).toBe(
			"docker",
		);
	});
	it("respects an explicit local request", () => {
		expect(
			decideBackend({ dockerAvailable: true, requested: "local", toolchainKnown: true, hasDockerfile: false })
				.backend,
		).toBe("local");
	});
	it("returns UNAVAILABLE (never silent local) when docker is demanded but absent", () => {
		const d = decideBackend({
			dockerAvailable: false,
			requested: "docker",
			toolchainKnown: true,
			hasDockerfile: false,
		});
		expect(d.backend).toBe("unavailable");
		expect(d.reason).toContain("not available");
	});
});

describe("toBindSource", () => {
	it("forward-slashes a Windows path but keeps the drive colon", () => {
		expect(toBindSource("C:\\Users\\A\\proj", "win32")).toBe("C:/Users/A/proj");
	});
	it("leaves a POSIX path untouched", () => {
		expect(toBindSource("/home/a/proj", "linux")).toBe("/home/a/proj");
	});
});

describe("buildDockerRunArgs", () => {
	const spec = {
		image: "python:3.12-slim",
		command: "pytest -q",
		mountSource: "/home/a/repo",
		workdir: "/work",
		env: { PYTHONSAFEPATH: "1" },
		network: true,
		platform: "linux" as NodeJS.Platform,
	};

	it("mounts the project at the workdir and runs via sh -c", () => {
		const a = buildDockerRunArgs(spec);
		expect(a.slice(0, 6)).toEqual(["run", "--rm", "-v", "/home/a/repo:/work", "-w", "/work"]);
		expect(a.slice(-4)).toEqual(["python:3.12-slim", "sh", "-c", "pytest -q"]);
	});
	it("passes env as -e KEY=VALUE", () => {
		expect(buildDockerRunArgs(spec)).toEqual(expect.arrayContaining(["-e", "PYTHONSAFEPATH=1"]));
	});
	it("isolates the network only when network:false", () => {
		expect(buildDockerRunArgs(spec)).not.toContain("--network");
		expect(buildDockerRunArgs({ ...spec, network: false })).toEqual(expect.arrayContaining(["--network", "none"]));
	});
	it("adds resource caps when set", () => {
		const a = buildDockerRunArgs({ ...spec, memory: "2g", cpus: "2" });
		expect(a).toEqual(expect.arrayContaining(["--memory", "2g", "--cpus", "2"]));
	});
	it("uses the Windows bind form for win32 specs", () => {
		const a = buildDockerRunArgs({ ...spec, mountSource: "C:\\r", platform: "win32" });
		expect(a).toContain("C:/r:/work");
	});
});

describe("imageTagFor / generatedDockerfile", () => {
	const r: SandboxRecipe = defaultRecipe(detectToolchain(["go.mod"]), ["go.mod"]);
	it("is deterministic and namespaced", () => {
		expect(imageTagFor(r)).toBe(imageTagFor(r));
		expect(imageTagFor(r)).toMatch(/^phi-sandbox:[0-9a-f]{8}$/);
	});
	it("changes when the recipe changes", () => {
		expect(imageTagFor(r)).not.toBe(imageTagFor({ ...r, image: "golang:1.21" }));
	});
	it("generates a minimal Dockerfile with FROM/WORKDIR/ENV", () => {
		const df = generatedDockerfile(defaultRecipe(detectToolchain(["requirements.txt"]), ["requirements.txt"]));
		expect(df).toMatch(/^FROM python/m);
		expect(df).toMatch(/^WORKDIR \/work/m);
		expect(df).toMatch(/^ENV PYTHONSAFEPATH=1/m);
	});
});
