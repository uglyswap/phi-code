/**
 * Backups — hand-written tar.gz (plan §C8). No `tar` binary, no `tar` package:
 * a minimal POSIX ustar writer paired with node:zlib.
 *
 * Snapshots contain the LIVE skill tree only: `.state/`, `.archive/`, `.locks/`
 * are excluded, so a restore can never lose the ledger, the archives or itself.
 * `restoreSnapshot` takes an automatic `pre-rollback` snapshot first, which
 * makes a rollback reversible.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { backupsDir, skillsRoot } from "./paths.ts";
import { listFilesRelative, readTextFile } from "./store.ts";

export interface SnapshotInfo {
	id: string;
	created_at: string;
	reason: string;
	bytes: number;
	file_count: number;
	skill_count: number;
}

const BLOCK = 512;

function octal(value: number, length: number): Buffer {
	const text = value.toString(8).padStart(length - 1, "0");
	return Buffer.from(`${text}\0`, "utf8");
}

function checksum(header: Buffer): number {
	let sum = 0;
	for (const byte of header) sum += byte;
	return sum;
}

function tarHeader(name: string, size: number, mtime: number): Buffer {
	const header = Buffer.alloc(BLOCK, 0);
	let fileName = name;
	let prefix = "";
	if (Buffer.byteLength(fileName, "utf8") > 100) {
		const split = fileName.lastIndexOf("/");
		prefix = fileName.slice(0, split);
		fileName = fileName.slice(split + 1);
	}
	header.write(fileName, 0, 100, "utf8");
	octal(0o644, 8).copy(header, 100); // mode
	octal(0, 8).copy(header, 108); // uid
	octal(0, 8).copy(header, 116); // gid
	octal(size, 12).copy(header, 124);
	octal(Math.floor(mtime / 1000), 12).copy(header, 136);
	header.write("        ", 148, 8, "utf8"); // checksum placeholder (spaces)
	header.write("0", 156, 1, "utf8"); // typeflag: regular file
	header.write("ustar\0", 257, 6, "utf8");
	header.write("00", 263, 2, "utf8");
	header.write(prefix, 345, 155, "utf8");
	const sum = checksum(header);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
	return header;
}

function buildTar(root: string, files: readonly string[]): Buffer {
	const chunks: Buffer[] = [];
	for (const rel of files) {
		const full = join(root, rel);
		let content: Buffer;
		let mtime: number;
		try {
			content = Buffer.from(readTextFile(full), "utf8");
			mtime = statSync(full).mtimeMs;
		} catch {
			continue;
		}
		chunks.push(tarHeader(rel, content.length, mtime));
		chunks.push(content);
		const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
		if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
	}
	chunks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
	return Buffer.concat(chunks);
}

function parseTar(tar: Buffer): Array<{ name: string; content: Buffer }> {
	const entries: Array<{ name: string; content: Buffer }> = [];
	let offset = 0;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break;
		const nameField = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
		const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
		const size = Number.parseInt(sizeText || "0", 8) || 0;
		const name = prefix ? `${prefix}/${nameField}` : nameField;
		offset += BLOCK;
		const content = Buffer.from(tar.subarray(offset, offset + size));
		offset += Math.ceil(size / BLOCK) * BLOCK;
		if (name) entries.push({ name, content });
	}
	return entries;
}

function snapshotId(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createSnapshot(reason: string, keep = 2): SnapshotInfo {
	const id = snapshotId();
	const root = skillsRoot();
	const files = listFilesRelative(root);
	const tar = buildTar(root, files);
	const gz = gzipSync(tar);
	const dir = join(backupsDir(), id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "skills.tar.gz"), gz);
	const info: SnapshotInfo = {
		id,
		created_at: new Date().toISOString(),
		reason,
		bytes: gz.length,
		file_count: files.length,
		skill_count: files.filter((file) => file === "SKILL.md" || file.endsWith("/SKILL.md")).length,
	};
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
	purgeOldSnapshots(keep);
	return info;
}

export function listSnapshots(): SnapshotInfo[] {
	let entries: string[];
	try {
		entries = readdirSync(backupsDir());
	} catch {
		return [];
	}
	const infos: SnapshotInfo[] = [];
	for (const entry of entries) {
		try {
			infos.push(JSON.parse(readTextFile(join(backupsDir(), entry, "manifest.json"))) as SnapshotInfo);
		} catch {
			// Incomplete snapshot directory — ignore it.
		}
	}
	infos.sort((a, b) => a.created_at.localeCompare(b.created_at));
	return infos;
}

function purgeOldSnapshots(keep: number): void {
	if (keep < 0) return;
	const infos = listSnapshots();
	const excess = infos.length - keep;
	for (let index = 0; index < excess; index++) {
		try {
			rmSync(join(backupsDir(), infos[index].id), { recursive: true, force: true });
		} catch {
			// Snapshot already gone — nothing to purge.
		}
	}
}

/**
 * Restore a snapshot. A `pre-rollback` snapshot is taken FIRST, so the restore
 * itself is reversible. Live skill folders are replaced; dot-directories
 * (.state/.archive/.locks) are untouched.
 */
export function restoreSnapshot(id: string): { ok: true; pre: string } | { ok: false; error: string } {
	let gz: Buffer;
	try {
		gz = readFileSync(join(backupsDir(), id, "skills.tar.gz"));
	} catch (error) {
		return { ok: false, error: `snapshot "${id}" unreadable: ${String(error)}` };
	}
	const pre = createSnapshot(`pre-rollback to ${id}`).id;
	const root = skillsRoot();
	let entries: string[] = [];
	try {
		entries = readdirSync(root);
	} catch {
		return { ok: false, error: `skills root ${root} is missing` };
	}
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 3 });
	}
	const tar = gunzipSync(gz);
	for (const { name, content } of parseTar(tar)) {
		const target = join(root, ...name.split(posix.sep));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return { ok: true, pre };
}
