/**
 * Approval gate / staging (plan §C6).
 *
 * When `writeApproval` is on, a whole batch becomes ONE pending record
 * (`action: "batch"`) under `<skillsRoot>/.state/pending/<id>.json`. Staging is
 * best-effort: on a disk failure the caller still receives a record but nothing
 * was committed — the only safe failure mode for a gate. Unreadable records are
 * skipped with a warning, never fatal. The gate only DEFERS writes, it never
 * silently refuses them.
 */

import { randomBytes } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { generateUnifiedPatch } from "phi-code";
import { locateSkillDir, pendingDir } from "./paths.ts";
import { atomicWriteFile, fileExists, readTextFile } from "./store.ts";
import type { BatchOutcome, ExecuteBatchOptions, SkillOp } from "./tool.ts";

export interface PendingRecord {
	id: string;
	subsystem: "skills";
	action: "batch";
	summary: string;
	origin: string;
	created_at: number;
	payload: { operations: SkillOp[] };
}

export function newPendingId(): string {
	return randomBytes(4).toString("hex");
}

function batchSummary(ops: SkillOp[]): string {
	const actions = [...new Set(ops.map((op) => op.action))].join(", ");
	const names = [...new Set(ops.map((op) => String(op.name ?? "?")))].join(", ");
	return `batch(${ops.length} ops: ${actions}) on ${names}`;
}

/** Best-effort staging. Returns a record id even when the disk write failed. */
export async function stageBatch(ops: SkillOp[], origin: string): Promise<BatchOutcome> {
	const id = newPendingId();
	const record: PendingRecord = {
		id,
		subsystem: "skills",
		action: "batch",
		summary: batchSummary(ops),
		origin,
		created_at: Date.now(),
		payload: { operations: ops },
	};
	try {
		await atomicWriteFile(join(pendingDir(), `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
	} catch (error) {
		logGate(`failed to stage batch ${id}: ${String(error)}`);
	}
	return {
		success: true,
		operations_applied: 0,
		staged: true,
		staged_id: id,
		results: [],
	};
}

function logGate(message: string): void {
	try {
		// Journal only — never fatal, never blocking.
		process.stderr.write(`[skill-system] ${message}\n`);
	} catch {
		// Even logging must not take the extension down.
	}
}

export function listPending(): { records: PendingRecord[]; skipped: number } {
	let files: string[];
	try {
		files = readdirSync(pendingDir()).filter((file) => file.endsWith(".json"));
	} catch {
		return { records: [], skipped: 0 };
	}
	const records: PendingRecord[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const parsed = JSON.parse(readTextFile(join(pendingDir(), file))) as PendingRecord;
			if (!parsed || typeof parsed.id !== "string" || typeof parsed.created_at !== "number")
				throw new Error("bad shape");
			records.push(parsed);
		} catch {
			// Unreadable record: skip with a warning, never fatal.
			skipped++;
		}
	}
	records.sort((a, b) => a.created_at - b.created_at);
	return { records, skipped };
}

export function readPending(id: string): PendingRecord | undefined {
	try {
		return JSON.parse(readTextFile(join(pendingDir(), `${id}.json`))) as PendingRecord;
	} catch {
		return undefined;
	}
}

export function deletePending(id: string): void {
	try {
		unlinkSync(join(pendingDir(), `${id}.json`));
	} catch {
		// Already applied or manually removed — nothing to do.
	}
}

/**
 * Replay a staged batch through the given executor (with the gate bypassed).
 * On success the record is deleted; on failure it is KEPT and the error
 * explains the most common cause (the target changed since staging).
 */
export async function applyPending(
	id: string,
	apply: (ops: SkillOp[], options: ExecuteBatchOptions) => Promise<BatchOutcome>,
): Promise<BatchOutcome> {
	const record = readPending(id);
	if (!record)
		return { success: false, operations_applied: 0, results: [], error: `pending record "${id}" not found` };
	const outcome = await apply(record.payload.operations, { origin: "foreground", bypassGate: true, actor: "user" });
	if (outcome.success) {
		deletePending(id);
		return outcome;
	}
	return {
		...outcome,
		error:
			`${outcome.error ?? "replay failed"} — the record was KEPT. ` +
			"A frequent cause: the target changed since staging; re-read it and re-stage.",
	};
}

/** Commands don't exist in headless surfaces — name the directory instead. */
export function pendingSurfaceHint(hasUI: boolean): string {
	return hasUI
		? "Review with /skill-system pending, then /skill-system diff <id> and /skill-system approve <id>."
		: `Nobody can run a command here — review the pending records under ${pendingDir()}.`;
}

/** Best-effort unified diff for a pending batch. */
export function buildPendingDiff(record: PendingRecord): string {
	const chunks: string[] = [];
	for (const op of record.payload.operations) {
		const name = String(op.name ?? "?");
		const rel = typeof op.file_path === "string" && op.file_path !== "" ? op.file_path : "SKILL.md";
		try {
			if (op.action === "create") {
				chunks.push(generateUnifiedPatch(join(name, "SKILL.md"), "", String(op.content ?? "")));
				continue;
			}
			if (op.action === "delete") {
				chunks.push(`# delete ${name} (archived, reversible)\n`);
				continue;
			}
			const skillDir = locateSkillDir(name);
			if (!skillDir) {
				chunks.push(`# ${op.action} ${name}/${rel}: skill not found on disk\n`);
				continue;
			}
			const filePath = join(skillDir, rel);
			const before = fileExists(filePath) ? readTextFile(filePath) : "";
			let after = before;
			if (op.action === "write_file") after = String(op.file_content ?? "");
			else if (op.action === "remove_file") after = "";
			else if (op.action === "patch" && typeof op.content === "string") after = op.content;
			else if (op.action === "patch" && typeof op.old_string === "string") {
				const index = before.indexOf(op.old_string);
				after =
					index < 0
						? before
						: before.slice(0, index) + String(op.new_string ?? "") + before.slice(index + op.old_string.length);
			}
			chunks.push(generateUnifiedPatch(join(name, rel), before, after));
		} catch (error) {
			chunks.push(`# cannot diff ${name}: ${String(error)}\n`);
		}
	}
	return chunks.join("\n");
}
