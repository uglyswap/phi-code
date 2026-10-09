/**
 * The memory extension initializes the vector store once at load. When that attempt
 * fails (e.g. vectors.db locked by another phi process for longer than the lock wait),
 * the memory tools retry VectorStore.init() before using the vectors, instead of
 * answering "NOT indexed" for the whole run.
 */
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ initAttempts: 0, ready: false, indexed: [] as string[] }));

vi.mock("sigma-memory", () => {
	class FakeVectorStore {
		async init(): Promise<void> {
			state.initAttempts++;
			if (state.initAttempts === 1) {
				throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
			}
			state.ready = true;
		}
		async addDocument(file: string): Promise<void> {
			if (!state.ready) throw new Error("VectorStore not initialized. Call init() first.");
			state.indexed.push(file);
		}
	}
	class FakeNotes {
		write(_content: string, filename: string): string {
			return filename;
		}
	}
	class SigmaMemory {
		readonly vectors = new FakeVectorStore();
		readonly notes = new FakeNotes();
		async init(): Promise<void> {
			await this.vectors.init();
		}
	}
	return { SigmaMemory, default: SigmaMemory };
});

import memoryExtension from "../extensions/phi/memory.ts";

type Execute = (
	id: string,
	params: unknown,
	signal: undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;

describe("memory tools after a failed vector store init", () => {
	it("memory_write retries the init and indexes the note", async () => {
		const tools = new Map<string, Execute>();
		memoryExtension({
			registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as never);
		const write = tools.get("memory_write");
		if (!write) throw new Error("memory_write is not registered");

		const result = await write("call-1", { content: "Retry works", file: "retry.md" }, undefined, undefined, {});
		expect(result.content[0]?.text).toBe("Content written to retry.md (indexed for vector search)");
		expect(state.initAttempts).toBe(2);
		expect(state.indexed).toEqual(["retry.md"]);
	});
});
