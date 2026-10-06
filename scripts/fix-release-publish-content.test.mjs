import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { resolveNpmInvocation } from "./npm-command.mjs";
import {
	diffPackEntries,
	hashLocalPackFiles,
	hashTarballEntries,
	isEmptyDiff,
	parsePackJson,
} from "./publish-content.mjs";

function tarHeader(name, size, type = "0") {
	const header = Buffer.alloc(512);
	header.write(name, 0, "utf8");
	header.write(size.toString(8).padStart(11, "0"), 124, "ascii");
	header.write(type, 156, "ascii");
	header.write("ustar", 257, "ascii");
	return header;
}

function tarEntry(name, content, type = "0") {
	const data = Buffer.from(content);
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return [tarHeader(name, data.length, type), data, padding];
}

function paxRecord(key, value) {
	const body = ` ${key}=${value}\n`;
	let length = body.length + 1;
	while (`${length}${body}`.length !== length) length++;
	return `${length}${body}`;
}

function makeTgz(blocks) {
	return gzipSync(Buffer.concat([...blocks.flat(), Buffer.alloc(1024)]));
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("hashTarballEntries strips the package/ prefix, skips directories and honours PAX paths", () => {
	const longPath = `package/dist/${"deep/".repeat(30)}file.js`;
	const tgz = makeTgz([
		tarEntry("package/", "", "5"),
		tarEntry("package/package.json", '{"name":"x"}'),
		tarEntry("package/dist/index.js", "export {};\n"),
		tarEntry("PaxHeader", paxRecord("path", longPath), "x"),
		tarEntry("package/dist/truncated-name.js", "long();\n"),
	]);

	const entries = hashTarballEntries(tgz);

	assert.deepEqual([...entries.keys()].sort(), ["dist/deep/".concat("deep/".repeat(29), "file.js"), "dist/index.js", "package.json"].sort());
	assert.equal(entries.get("package.json"), sha256('{"name":"x"}'));
	assert.equal(entries.get("dist/index.js"), sha256("export {};\n"));
});

test("a locally changed file is reported even when the version is the same (sigma-memory 0.2.9 case)", () => {
	const dir = mkdtempSync(join(tmpdir(), "fix-release-publish-"));
	try {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "package.json"), '{"name":"x"}');
		writeFileSync(join(dir, "dist", "index.js"), "export function addBatch() {}\n");
		const local = hashLocalPackFiles(dir, [{ path: "package.json" }, { path: "dist/index.js" }]);

		const published = hashTarballEntries(
			makeTgz([tarEntry("package/package.json", '{"name":"x"}'), tarEntry("package/dist/index.js", "export {};\n"), tarEntry("package/dist/old.js", "")]),
		);
		const diff = diffPackEntries(local, published);
		assert.deepEqual(diff, { changed: ["dist/index.js"], added: [], removed: ["dist/old.js"] });
		assert.equal(isEmptyDiff(diff), false);

		const same = hashTarballEntries(
			makeTgz([tarEntry("package/package.json", '{"name":"x"}'), tarEntry("package/dist/index.js", "export function addBatch() {}\n")]),
		);
		assert.equal(isEmptyDiff(diffPackEntries(local, same)), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parsePackJson accepts the array and the keyed-object output shapes", () => {
	const packed = { filename: "x-1.0.0.tgz", shasum: "abc", files: [{ path: "a" }] };
	assert.equal(parsePackJson(JSON.stringify([packed])).shasum, "abc");
	assert.equal(parsePackJson(JSON.stringify({ x: packed })).shasum, "abc");
	assert.throws(() => parsePackJson("[]"), /no files list/);
});

test("resolveNpmInvocation never spawns npm.cmd on Windows (EINVAL without a shell)", () => {
	assert.deepEqual(resolveNpmInvocation({}, "linux", "/usr/bin/node"), { command: "npm", prefixArgs: [] });

	const dir = mkdtempSync(join(tmpdir(), "fix-release-npm-"));
	try {
		const cli = join(dir, "npm-cli.js");
		writeFileSync(cli, "");
		assert.deepEqual(resolveNpmInvocation({ npm_execpath: cli }, "win32", "C:\\node\\node.exe"), {
			command: "C:\\node\\node.exe",
			prefixArgs: [cli],
		});
		assert.throws(() => resolveNpmInvocation({}, "win32", join(dir, "missing", "node.exe")), /npm-cli\.js/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
