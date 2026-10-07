/**
 * Content-addressed audit ledger (plan §C2.1).
 *
 * Entries NEVER inline content: every file is stored as a blob addressed by
 * its sha256, and the entry references `{path, sha256}` pairs. Rotation trims
 * to the newest lines when the file exceeds `ledger.maxBytes`, and blobs are
 * garbage-collected ONLY after a trim actually removed lines (that is the only
 * way a blob becomes orphaned). Recent blobs (< 1 h) are never collected, and
 * unreadable blobs are kept — an entry we cannot read may still reference them.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { withLocks } from "./lock.ts";
import { blobsDir, stateDir } from "./paths.ts";
import { atomicWriteFile, listFilesRelative, readTextFile } from "./store.ts";

export type LedgerActor = "foreground" | "background_review" | "curator" | "user";

export interface LedgerRef {
	path: string;
	sha256: string;
}

export interface LedgerEntry {
	id: string;
	ts: string;
	actor: LedgerActor;
	session_id?: string;
	action: string;
	name: string;
	before: LedgerRef[];
	after: LedgerRef[];
	evidence?: Record<string, unknown>;
}

export function ledgerPath(): string {
	return join(stateDir(), "ledger.jsonl");
}

export function newEntryId(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeBlob(content: string): string {
	const digest = hashContent(content);
	const path = join(blobsDir(), digest);
	if (!existsSync(path)) {
		mkdirSync(blobsDir(), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return digest;
}

/** Capture the given relative files of a skill directory as blob references. */
export function captureFiles(skillDir: string, relFiles?: readonly string[]): LedgerRef[] {
	const files = relFiles ?? listFilesRelative(skillDir);
	const refs: LedgerRef[] = [];
	for (const rel of files) {
		try {
			const content = readTextFile(join(skillDir, rel));
			refs.push({ path: rel, sha256: writeBlob(content) });
		} catch {
			// File vanished between listing and read — skip; the ledger is best-effort.
		}
	}
	return refs;
}

function tryReadBlobText(digest: string): string | undefined {
	try {
		return readFileSync(join(blobsDir(), digest), "utf8");
	} catch {
		return undefined;
	}
}

/** Read ledger entries; truncated/garbled lines are skipped, never fatal. */
export function readEntries(limit = 200): LedgerEntry[] {
	let raw: string;
	try {
		raw = readTextFile(ledgerPath());
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	const entries: LedgerEntry[] = [];
	for (const line of lines) {
		try {
			entries.push(JSON.parse(line) as LedgerEntry);
		} catch {
			// Truncated line (torn write / crash) — ignore, the rest stays readable.
		}
	}
	return entries.slice(-limit);
}

function rotateAndGc(): void {
	const config = loadConfig();
	const path = ledgerPath();
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return;
	}
	if (size <= config.ledger.maxBytes) return;
	const raw = readTextFile(path);
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	const keep = lines.slice(-2000);
	if (keep.length === lines.length) return; // Nothing trimmed: no orphan possible, no GC.
	writeFileSync(path, `${keep.join("\n")}\n`, "utf8");
	const referenced = new Set<string>();
	for (const line of keep) {
		try {
			const entry = JSON.parse(line) as LedgerEntry;
			for (const ref of [...(entry.before ?? []), ...(entry.after ?? [])]) referenced.add(ref.sha256);
		} catch {
			// Unreadable remaining line: keep going — its blobs stay out of reach.
		}
	}
	const graceMs = config.ledger.blobGraceSeconds * 1000;
	let blobs: string[];
	try {
		blobs = readdirSync(blobsDir());
	} catch {
		return;
	}
	for (const blob of blobs) {
		if (referenced.has(blob)) continue;
		try {
			if (Date.now() - statSync(join(blobsDir(), blob)).mtimeMs < graceMs) continue; // Capture in flight.
			unlinkSync(join(blobsDir(), blob));
		} catch {
			// Unreadable blob is KEPT: an entry we cannot read may still reference it.
		}
	}
}

export async function appendEntry(entry: LedgerEntry): Promise<void> {
	const config = loadConfig();
	if (!config.ledger.enabled) return;
	await withLocks(["ledger"], async () => {
		mkdirSync(stateDir(), { recursive: true });
		appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`, "utf8");
		rotateAndGc();
	});
}

/** Restore the `before` state of an entry (undo of one isolated mutation). */
export async function rollbackEntry(
	entryId: string,
	resolveSkillDir: (name: string) => string,
): Promise<{ ok: true; restored: number; removed: number } | { ok: false; error: string }> {
	const entry = readEntries(10_000).find((candidate) => candidate.id === entryId);
	if (!entry) return { ok: false, error: `ledger entry "${entryId}" not found` };
	const skillDir = resolveSkillDir(entry.name);
	let restored = 0;
	let removed = 0;
	const beforePaths = new Set(entry.before.map((ref) => ref.path));
	for (const ref of entry.after) {
		if (beforePaths.has(ref.path)) continue;
		try {
			unlinkSync(join(skillDir, ref.path));
			removed++;
		} catch {
			// Already gone — nothing to remove.
		}
	}
	for (const ref of entry.before) {
		const content = tryReadBlobText(ref.sha256);
		if (content === undefined)
			return { ok: false, error: `blob ${ref.sha256} unreadable — cannot restore ${ref.path}` };
		await atomicWriteFile(join(skillDir, ref.path), content);
		restored++;
	}
	return { ok: true, restored, removed };
}
