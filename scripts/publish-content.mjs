import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Helpers that decide whether a version already on npm has the same content as
 * the local package. publish.mjs used to skip any already-published version
 * without looking: sigma-memory 0.2.9 was changed locally (addBatch) without a
 * version bump, so the release silently kept the old tarball on npm.
 */

const BLOCK_SIZE = 512;

function readString(block, offset, length) {
	const slice = block.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readSize(block) {
	const raw = readString(block, 124, 12).trim();
	return raw === "" ? 0 : Number.parseInt(raw, 8);
}

/** Parse the `path` record of a PAX extended header ("<len> key=value\n" records). */
function readPaxPath(data) {
	const text = data.toString("utf8");
	let offset = 0;
	while (offset < text.length) {
		const space = text.indexOf(" ", offset);
		if (space === -1) break;
		const length = Number.parseInt(text.slice(offset, space), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = text.slice(space + 1, offset + length - 1);
		const equals = record.indexOf("=");
		if (equals !== -1 && record.slice(0, equals) === "path") {
			return record.slice(equals + 1);
		}
		offset += length;
	}
	return undefined;
}

/**
 * Read the regular files of an npm tarball (.tgz) and return a map of
 * package-relative path (without the leading `package/`) to sha256 hex digest.
 */
export function hashTarballEntries(tgz) {
	const tar = gunzipSync(tgz);
	const entries = new Map();
	let offset = 0;
	let pendingPath;

	while (offset + BLOCK_SIZE <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) break;

		const size = readSize(header);
		const type = String.fromCharCode(header[156] || 48);
		const dataStart = offset + BLOCK_SIZE;
		const data = tar.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

		if (type === "x") {
			pendingPath = readPaxPath(data);
			continue;
		}
		if (type === "L") {
			pendingPath = readString(data, 0, data.length);
			continue;
		}
		if (type === "g") continue;

		const prefix = readString(header, 345, 155);
		const name = readString(header, 0, 100);
		const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
		pendingPath = undefined;

		if (type !== "0" && type !== "\0") continue;
		const relative = path.replace(/^[^/]+\//, "");
		entries.set(relative, createHash("sha256").update(data).digest("hex"));
	}

	return entries;
}

/** Hash the files `npm pack --dry-run --json` lists for a local package directory. */
export function hashLocalPackFiles(directory, files) {
	const entries = new Map();
	for (const file of files) {
		const content = readFileSync(join(directory, file.path));
		entries.set(file.path.replaceAll("\\", "/"), createHash("sha256").update(content).digest("hex"));
	}
	return entries;
}

/** Compare two path -> hash maps. */
export function diffPackEntries(local, published) {
	const changed = [];
	const added = [];
	const removed = [];
	for (const [path, hash] of local) {
		if (!published.has(path)) added.push(path);
		else if (published.get(path) !== hash) changed.push(path);
	}
	for (const path of published.keys()) {
		if (!local.has(path)) removed.push(path);
	}
	return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

export function isEmptyDiff(diff) {
	return diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0;
}

/** npm <11.6 prints an array for `npm pack --json`; some versions print an object keyed by package name. */
export function parsePackJson(stdout) {
	const parsed = JSON.parse(stdout);
	const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (!packed || !Array.isArray(packed.files)) {
		throw new Error("Unexpected `npm pack --json` output: no files list");
	}
	return packed;
}

export function formatDiff(diff, limit = 10) {
	const lines = [];
	for (const [label, paths] of [
		["changed", diff.changed],
		["only local", diff.added],
		["only published", diff.removed],
	]) {
		if (paths.length === 0) continue;
		const shown = paths.slice(0, limit).join(", ");
		lines.push(`    ${label} (${paths.length}): ${shown}${paths.length > limit ? ", ..." : ""}`);
	}
	return lines.join("\n");
}
