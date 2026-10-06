/**
 * FIX5-TYPES regression: memory.ts is now typechecked (tsconfig.ext.json). The
 * ontology tools must turn runtime "missing value" cases into explicit tool errors
 * (isError + details) instead of persisting undefined/empty fields or crashing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeEntity {
	id: string;
	type: string;
	name: string;
	properties: Record<string, string>;
}
interface FakeRelation {
	id: string;
	from: string;
	to: string;
	type: string;
	properties: Record<string, string>;
}

const store = vi.hoisted(() => ({
	entities: [] as Array<{ id: string; type: string; name: string; properties: Record<string, string> }>,
	relations: [] as Array<{ id: string; from: string; to: string; type: string; properties: Record<string, string> }>,
	nextId: 0,
}));

vi.mock("sigma-memory", () => {
	class FakeOntology {
		addEntity(entity: Omit<FakeEntity, "id">): string {
			const id = `e${store.nextId++}`;
			store.entities.push({ ...entity, id });
			return id;
		}
		addRelation(relation: Omit<FakeRelation, "id">): string {
			const id = `r${store.nextId++}`;
			store.relations.push({ ...relation, id });
			return id;
		}
		findEntity(query: { id?: string; name?: string }): FakeEntity[] {
			if (query.id) return store.entities.filter((e) => e.id === query.id);
			const name = query.name?.toLowerCase();
			return store.entities.filter((e) => !name || e.name.toLowerCase().includes(name));
		}
		findRelations(entityId: string): FakeRelation[] {
			return store.relations.filter((r) => r.from === entityId || r.to === entityId);
		}
	}
	class SigmaMemory {
		readonly ontology = new FakeOntology();
		async init(): Promise<void> {}
	}
	return { SigmaMemory, default: SigmaMemory };
});

import memoryExtension from "../extensions/phi/memory.ts";

type Execute = (
	id: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;

function loadTools(): Map<string, Execute> {
	const tools = new Map<string, Execute>();
	const pi = {
		registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
		registerCommand: vi.fn(),
		on: vi.fn(),
	};
	memoryExtension(pi as never);
	return tools;
}

function tool(name: string): Execute {
	const execute = loadTools().get(name);
	if (!execute) throw new Error(`tool ${name} not registered`);
	return execute;
}

describe("fix5-types: ontology tools handle absent values explicitly", () => {
	beforeEach(() => {
		store.entities.length = 0;
		store.relations.length = 0;
		store.nextId = 0;
	});

	it("ontology_add relation reports an unknown source entity as a tool error with details", async () => {
		const add = tool("ontology_add");
		await add("1", { type: "entity", entityType: "Service", name: "api" }, undefined, undefined, {});
		const result = await add(
			"2",
			{ type: "relation", from: "ghost", to: "api", relationType: "uses" },
			undefined,
			undefined,
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Source entity not found: ghost");
		expect(result.details).toMatchObject({ error: "source-not-found", from: "ghost" });
		expect(store.relations).toHaveLength(0);
	});

	it("ontology_add relation reports an unknown target entity as a tool error with details", async () => {
		const add = tool("ontology_add");
		await add("1", { type: "entity", entityType: "Service", name: "api" }, undefined, undefined, {});
		const result = await add(
			"2",
			{ type: "relation", from: "api", to: "nowhere", relationType: "uses" },
			undefined,
			undefined,
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ error: "target-not-found", to: "nowhere" });
		expect(store.relations).toHaveLength(0);
	});

	it("ontology_add resolves endpoints by ID and by case-insensitive name", async () => {
		const add = tool("ontology_add");
		const api = await add("1", { type: "entity", entityType: "Service", name: "Api" }, undefined, undefined, {});
		await add("2", { type: "entity", entityType: "Database", name: "postgres-db" }, undefined, undefined, {});
		const result = await add(
			"3",
			{ type: "relation", from: api.details.id, to: "POSTGRES-DB", relationType: "uses" },
			undefined,
			undefined,
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(store.relations).toEqual([expect.objectContaining({ from: "e0", to: "e1", type: "uses" })]);
		// free-form entity types outside the declared union are still persisted verbatim
		expect(store.entities[1]?.type).toBe("Database");
	});

	it("ontology_add entity with missing fields returns isError and details", async () => {
		const result = await tool("ontology_add")("1", { type: "entity", name: "x" }, undefined, undefined, {});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ error: "missing-fields" });
		expect(store.entities).toHaveLength(0);
	});

	it("ontology_batch_add skips an empty entityType and an empty relationType instead of persisting them", async () => {
		const result = await tool("ontology_batch_add")(
			"1",
			{
				entities: [
					{ entityType: "Service", name: "api" },
					{ entityType: "", name: "typeless" },
					{ entityType: "Database", name: "db" },
				],
				relations: [
					{ fromName: "api", toName: "db", relationType: "" },
					{ fromName: "api", toName: "db", relationType: "uses" },
				],
			},
			undefined,
			undefined,
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(store.entities.map((e) => e.name)).toEqual(["api", "db"]);
		expect(store.entities.every((e) => typeof e.type === "string" && e.type.length > 0)).toBe(true);
		expect(store.relations).toEqual([expect.objectContaining({ type: "uses" })]);
		const errors = result.details.errors as string[];
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("typeless");
		expect(errors[1]).toContain("'relationType' is required");
		expect(result.content[0]?.text).toContain("Batch added: 2 entities, 1 relations.");
	});

	it("ontology_query returns details on every path, errors included", async () => {
		const query = tool("ontology_query");
		const missing = await query("1", { action: "relations" }, undefined, undefined, {});
		expect(missing.isError).toBe(true);
		expect(missing.details).toEqual({ action: "relations" });
		const empty = await query("2", { action: "find", name: "nothing" }, undefined, undefined, {});
		expect(empty.isError).toBeUndefined();
		expect(empty.details).toEqual({ action: "find" });
	});

	it("ontology_query relations/path accept an entity name and report unknown entities as errors", async () => {
		const pong = await tool("ontology_add")(
			"1",
			{ type: "entity", entityType: "Project", name: "cyberpunk-pong" },
			undefined,
			undefined,
			{},
		);
		expect(pong.isError).toBeUndefined();
		await tool("ontology_add")(
			"2",
			{ type: "entity", entityType: "Project", name: "cyberpunk-pacman" },
			undefined,
			undefined,
			{},
		);
		await tool("ontology_add")(
			"3",
			{ type: "relation", from: "cyberpunk-pong", to: "cyberpunk-pacman", relationType: "references" },
			undefined,
			undefined,
			{},
		);
		const query = tool("ontology_query");
		const byName = await query("4", { action: "relations", entityId: "Cyberpunk-Pong" }, undefined, undefined, {});
		expect(byName.isError).toBeUndefined();
		expect(byName.content[0]?.text).toContain("Found 1 relations");
		expect(byName.content[0]?.text).toContain("**cyberpunk-pacman**");
		const unknown = await query("5", { action: "relations", entityId: "no-such-entity" }, undefined, undefined, {});
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0]?.text).toContain("Entity not found");
		const badPath = await query(
			"6",
			{ action: "path", fromId: "cyberpunk-pong", toId: "nope" },
			undefined,
			undefined,
			{},
		);
		expect(badPath.isError).toBe(true);
	});
});
