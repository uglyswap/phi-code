import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("synchronizes private dependencies without touching registry aliases or generated manifests, and tolerates independent versions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "phi-code-ai",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@phi-code-admin/phi-code",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/evals", {
			name: "phi-code-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@phi-code-admin/phi-code": "^1.0.0",
				"@mariozechner/pi-ai": "npm:phi-code-ai@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@phi-code-admin/phi-code": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["@phi-code-admin/phi-code"], "^2.0.0");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:phi-code-ai@1.0.0");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@phi-code-admin/phi-code"], "^1.0.0");

		// phi-code versions its packages INDEPENDENTLY (the CLI is on its own line,
		// the libraries track upstream), so divergence warns and keeps going instead
		// of aborting the release: inter-package ranges are rewritten to each
		// target's own current version, which is the correct behaviour here.
		await writeManifest(root, "packages/ai", {
			name: "phi-code-ai",
			version: "3.0.0",
		});
		const independentVersions = runSyncVersions(root);
		assert.equal(independentVersions.status, 0, independentVersions.stderr);
		assert.match(`${independentVersions.stdout}${independentVersions.stderr}`, /independent versioning/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
