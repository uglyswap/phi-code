// Regression tests for the extension dependency pruning of the standalone
// binary archives (build-binaries.sh --prune-extension-deps). The fixture
// mimics the real staged tree: sigma-memory -> @huggingface/transformers ->
// onnxruntime-node (binaries for every OS), onnxruntime-web, sharp.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "build-binaries.sh");
const HAS_BASH = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

function write(file, content = "x") {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function pkg(root, name, manifest = {}, files = {}) {
	const dir = join(root, "node_modules", name);
	write(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
	for (const [file, content] of Object.entries(files)) write(join(dir, file), content);
	return dir;
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "fix3-prune-"));
	write(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "sigma-memory": "1", "@ast-grep/napi": "1" } }));
	pkg(root, "sigma-memory", { dependencies: { "@huggingface/transformers": "3", "sql.js": "1" } }, {
		"dist/index.js": "",
		"dist/index.d.ts": "",
	});
	pkg(
		root,
		"@huggingface/transformers",
		{
			exports: {
				node: {
					import: { types: "./types/t.d.ts", default: "./dist/transformers.node.mjs" },
					require: { types: "./types/t.d.ts", default: "./dist/transformers.node.cjs" },
				},
				default: { default: "./dist/transformers.web.js" },
			},
			dependencies: { "onnxruntime-node": "1", "onnxruntime-web": "1", sharp: "0" },
		},
		{
			"dist/transformers.node.mjs": 'import * as ort from "onnxruntime-node";\nimport * as c from "onnxruntime-common";\n/* onnxruntime-web (ignored) */',
			"dist/transformers.node.cjs": 'require("onnxruntime-node");',
			"dist/transformers.node.mjs.map": "",
			"dist/transformers.web.js": 'import "onnxruntime-web";',
			"dist/ort-wasm-simd-threaded.jsep.wasm": "",
			"types/t.d.ts": "",
		},
	);
	const napi = {};
	for (const target of ["win32/x64", "win32/arm64", "darwin/arm64", "linux/x64"]) {
		napi[`bin/napi-v3/${target}/onnxruntime_binding.node`] = "bin";
	}
	napi["bin/napi-v3/linux/x64/libonnxruntime.so.1.21.0"] = "same-bytes";
	napi["bin/napi-v3/linux/x64/libonnxruntime.so.1"] = "same-bytes";
	pkg(root, "onnxruntime-node", { dependencies: { "onnxruntime-common": "1", tar: "7", "global-agent": "3" } }, {
		...napi,
		"dist/binding.js": 'require("onnxruntime-common"); require(`../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`);',
		"script/install.js": 'require("tar"); require("global-agent");',
	});
	pkg(root, "onnxruntime-common", {}, { "dist/index.js": "" });
	pkg(root, "onnxruntime-web", { dependencies: { protobufjs: "7", "onnxruntime-common": "1.22" } });
	write(join(root, "node_modules/onnxruntime-web/node_modules/onnxruntime-common/package.json"), '{"name":"onnxruntime-common"}');
	pkg(root, "protobufjs");
	pkg(root, "tar", { dependencies: { minipass: "7" } });
	pkg(root, "minipass");
	pkg(root, "global-agent", { dependencies: { semver: "7" } });
	pkg(root, "semver");
	pkg(root, "sharp", {
		dependencies: { semver: "7" },
		optionalDependencies: {
			"@img/sharp-win32-x64": "0",
			"@img/sharp-linux-x64": "0",
			"@img/sharp-libvips-linux-x64": "0",
			"@img/sharp-linuxmusl-x64": "0",
		},
	});
	pkg(root, "@img/sharp-win32-x64", { os: ["win32"], cpu: ["x64"] }, { "lib/sharp-win32-x64.node": "", "lib/libvips-42.dll": "" });
	pkg(root, "@img/sharp-linux-x64", { os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, { "lib/sharp-linux-x64.node": "" });
	pkg(root, "@img/sharp-libvips-linux-x64", { os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, { "lib/libvips-cpp.so.42": "" });
	pkg(root, "@img/sharp-linuxmusl-x64", { os: ["linux"], cpu: ["x64"], libc: ["musl"] }, { "lib/sharp-linuxmusl-x64.node": "" });
	pkg(root, "sql.js", { exports: { ".": { browser: "./dist/sql-wasm-browser.js", default: "./dist/sql-wasm.js" } } }, {
		"dist/sql-wasm.js": "",
		"dist/sql-wasm.wasm": "",
		"dist/sql-asm-debug.js": "",
		"dist/sqljs-all.zip": "",
	});
	pkg(
		root,
		"@ast-grep/napi",
		{ optionalDependencies: { "@ast-grep/napi-win32-x64-msvc": "1", "@ast-grep/napi-linux-x64-gnu": "1" } },
		{ "index.js": "", "index.d.ts": "" },
	);
	pkg(root, "@ast-grep/napi-win32-x64-msvc", { os: ["win32"], cpu: ["x64"] }, { "ast-grep-napi.win32-x64-msvc.node": "" });
	pkg(root, "@ast-grep/napi-linux-x64-gnu", { os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, {
		"ast-grep-napi.linux-x64-gnu.node": "",
	});
	return root;
}

function prune(platform, root) {
	return spawnSync("bash", [SCRIPT, "--platform", platform, "--prune-extension-deps", root], { encoding: "utf8" });
}

const nm = (root, rel) => join(root, "node_modules", rel);

test("windows-x64: keeps the target natives and runtime entries, drops the rest", { skip: !HAS_BASH }, () => {
	const root = createFixture();
	try {
		const result = prune("windows-x64", root);
		assert.equal(result.status, 0, result.stderr);
		for (const kept of [
			"onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node",
			"onnxruntime-node/dist/binding.js",
			"onnxruntime-common/package.json",
			"@huggingface/transformers/dist/transformers.node.mjs",
			"@huggingface/transformers/dist/transformers.node.cjs",
			"sql.js/dist/sql-wasm.js",
			"sql.js/dist/sql-wasm.wasm",
			"semver/package.json",
			"@img/sharp-win32-x64/lib/sharp-win32-x64.node",
			"@ast-grep/napi-win32-x64-msvc/ast-grep-napi.win32-x64-msvc.node",
			"sigma-memory/dist/index.d.ts",
		]) {
			assert.ok(existsSync(nm(root, kept)), `${kept} must be kept`);
		}
		for (const removed of [
			"onnxruntime-node/bin/napi-v3/win32/arm64",
			"onnxruntime-node/bin/napi-v3/darwin",
			"onnxruntime-node/bin/napi-v3/linux",
			"onnxruntime-web",
			"protobufjs",
			"tar",
			"minipass",
			"global-agent",
			"@huggingface/transformers/dist/transformers.web.js",
			"@huggingface/transformers/dist/transformers.node.mjs.map",
			"@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm",
			"@huggingface/transformers/types/t.d.ts",
			"@ast-grep/napi/index.d.ts",
			"sql.js/dist/sql-asm-debug.js",
			"sql.js/dist/sqljs-all.zip",
		]) {
			assert.ok(!existsSync(nm(root, removed)), `${removed} must be removed`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("linux-x64: glibc packages only, deduplicated libonnxruntime", { skip: !HAS_BASH }, () => {
	const root = createFixture();
	try {
		const result = prune("linux-x64", root);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(existsSync(nm(root, "@img/sharp-linux-x64/lib/sharp-linux-x64.node")));
		assert.ok(existsSync(nm(root, "@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.42")));
		assert.ok(!existsSync(nm(root, "@img/sharp-linuxmusl-x64")));
		assert.ok(!existsSync(nm(root, "@img/sharp-win32-x64")));
		assert.ok(!existsSync(nm(root, "onnxruntime-node/bin/napi-v3/win32")));
		const soname = nm(root, "onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1");
		// A symlink where the host supports it (the Linux release runner), a copy otherwise.
		if (process.platform !== "win32") assert.ok(lstatSync(soname).isSymbolicLink());
		assert.equal(readFileSync(soname, "utf8"), "same-bytes");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when an expected native package is missing", { skip: !HAS_BASH }, () => {
	const root = createFixture();
	try {
		rmSync(nm(root, "@ast-grep/napi-win32-x64-msvc"), { recursive: true });
		const result = prune("windows-x64", root);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /native package @ast-grep\/napi-win32-x64-msvc is missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when onnxruntime-node has no binding for the target", { skip: !HAS_BASH }, () => {
	const root = createFixture();
	try {
		const result = prune("darwin-x64", root);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /onnxruntime-node has no binding for darwin\/x64/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refuses to drop onnxruntime-web once the Node build imports it", { skip: !HAS_BASH }, () => {
	const root = createFixture();
	try {
		write(nm(root, "@huggingface/transformers/dist/transformers.node.mjs"), 'import * as web from "onnxruntime-web";');
		const result = prune("windows-x64", root);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /now imports onnxruntime-web/);
		assert.ok(existsSync(nm(root, "onnxruntime-web")), "nothing is removed when a check fails");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("binaries are compiled with package.json autoload for on-disk node_modules", () => {
	const script = readFileSync(SCRIPT, "utf8");
	const builds = script.split("\n").filter((line) => /^\s*bun build --compile/.test(line));
	assert.ok(builds.length >= 2);
	for (const line of builds) assert.match(line, /--compile-autoload-package-json/);
});
