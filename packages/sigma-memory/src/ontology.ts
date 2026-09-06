import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname } from "path";
import { lockSync } from "proper-lockfile";
import type {
	MemoryConfig,
	OntologyDeleteEntry,
	OntologyEntity,
	OntologyEntityEntry,
	OntologyJSONLEntry,
	OntologyRelation,
	OntologyRelationEntry,
} from "./types.ts";

export class OntologyManager {
	private graphPath: string;
	private entities: Map<string, OntologyEntity> = new Map();
	private relations: Map<string, OntologyRelation> = new Map();
	private loaded = false;
	// mtime (ms) of graph.jsonl at the last load; used to detect external
	// writes (another instance/process) and reload instead of serving stale data.
	private lastMtimeMs = 0;

	constructor(config: MemoryConfig) {
		this.graphPath = config.ontologyPath;
		this.ensureDirectories();
	}

	private ensureDirectories(): void {
		const dir = dirname(this.graphPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private generateId(): string {
		return randomBytes(16).toString("hex");
	}

	private loadGraph(): void {
		// Invalidate the cache when the on-disk file is newer than our last
		// load (another instance/process appended), so reads do not serve
		// stale in-memory state across instances.
		if (this.loaded && existsSync(this.graphPath)) {
			try {
				if (statSync(this.graphPath).mtimeMs > this.lastMtimeMs) {
					this.loaded = false;
				}
			} catch {
				// stat failed (race on removal); keep current cache
			}
		}

		if (this.loaded) return;

		this.entities.clear();
		this.relations.clear();

		if (!existsSync(this.graphPath)) {
			this.loaded = true;
			this.lastMtimeMs = 0;
			return;
		}

		try {
			this.lastMtimeMs = statSync(this.graphPath).mtimeMs;
		} catch {
			this.lastMtimeMs = 0;
		}

		const content = readFileSync(this.graphPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((line) => line.trim());

		for (const line of lines) {
			try {
				const entry: OntologyJSONLEntry = JSON.parse(line);

				switch (entry.kind) {
					case "entity":
						this.entities.set(entry.id, {
							id: entry.id,
							type: entry.type,
							name: entry.name,
							properties: entry.properties,
							createdAt: entry.createdAt,
							updatedAt: entry.updatedAt,
						});
						break;

					case "relation":
						this.relations.set(entry.id, {
							id: entry.id,
							from: entry.from,
							to: entry.to,
							type: entry.type,
							properties: entry.properties,
							createdAt: entry.createdAt,
						});
						break;

					case "delete":
						// Delete entity or relation
						this.entities.delete(entry.targetId);
						this.relations.delete(entry.targetId);
						// Also delete all relations linked to this entity
						for (const [relationId, relation] of this.relations) {
							if (relation.from === entry.targetId || relation.to === entry.targetId) {
								this.relations.delete(relationId);
							}
						}
						break;
				}
			} catch (_error) {
				// Skip malformed JSONL line
			}
		}

		this.loaded = true;
	}

	/**
	 * Run fn while holding an exclusive lock on the graph file so concurrent
	 * processes (two phi instances writing memory at once) cannot interleave
	 * partial JSONL lines. proper-lockfile has no sync retry support, so
	 * contention is handled with a short bounded spin; appends take
	 * microseconds and contention is rare, and a lock left by a crashed
	 * process goes stale after 5s and is taken over.
	 */
	private withGraphLock<T>(fn: () => T): T {
		const deadline = Date.now() + 2_000;
		for (;;) {
			let release: (() => void) | undefined;
			try {
				// realpath:false — the graph file may not exist before the first append.
				release = lockSync(this.graphPath, { realpath: false, stale: 5_000 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ELOCKED" && Date.now() < deadline) {
					const until = Date.now() + 15;
					while (Date.now() < until) {
						// bounded spin-wait between lock attempts (sync context, no timers)
					}
					continue;
				}
				throw error;
			}
			try {
				return fn();
			} finally {
				release();
			}
		}
	}

	private appendToFile(entry: OntologyJSONLEntry): void {
		this.ensureDirectories();
		const line = `${JSON.stringify(entry)}\n`;
		this.withGraphLock(() => {
			appendFileSync(this.graphPath, line, "utf8");
		});
		// Record the new mtime so our own write does not look like an external
		// change and force a needless reload on the next read.
		try {
			this.lastMtimeMs = statSync(this.graphPath).mtimeMs;
		} catch {
			// best-effort; a failed stat just means the next read may reload
		}
	}

	/**
	 * Ajoute une entité
	 */
	addEntity(entity: Omit<OntologyEntity, "id" | "createdAt" | "updatedAt">): string {
		this.loadGraph();

		const id = this.generateId();
		const now = new Date().toISOString();

		const newEntity: OntologyEntity = {
			...entity,
			id,
			createdAt: now,
			updatedAt: now,
		};

		this.entities.set(id, newEntity);

		const entry: OntologyEntityEntry = {
			kind: "entity",
			...newEntity,
		};

		this.appendToFile(entry);
		return id;
	}

	/**
	 * Ajoute un lot d'entités et de relations en une seule écriture verrouillée.
	 * Les relations peuvent référencer les entités par nom (existantes ou du lot).
	 * Validation complète avant écriture : si une relation ne résout pas, rien n'est persisté.
	 */
	addBatch(input: {
		entities: Array<Omit<OntologyEntity, "id" | "createdAt" | "updatedAt">>;
		relations?: Array<{
			from?: string;
			to?: string;
			fromName?: string;
			toName?: string;
			type: string;
			properties?: Record<string, string>;
		}>;
	}): { entityIds: string[]; relationIds: string[] } {
		this.loadGraph();

		const now = new Date().toISOString();
		const entries: OntologyJSONLEntry[] = [];
		const entityIds: string[] = [];
		const relationIds: string[] = [];
		const byName = new Map<string, string>();
		for (const entity of this.entities.values()) {
			byName.set(entity.name.toLowerCase(), entity.id);
		}

		for (const entity of input.entities) {
			const id = this.generateId();
			const newEntity: OntologyEntity = { ...entity, id, createdAt: now, updatedAt: now };
			entityIds.push(id);
			byName.set(newEntity.name.toLowerCase(), id);
			entries.push({ kind: "entity", ...newEntity });
		}

		const resolveRef = (ref: string | undefined, name: string | undefined, label: string): string => {
			if (ref) {
				if (byName.get(ref.toLowerCase()) === ref || this.entities.has(ref) || entityIds.includes(ref)) return ref;
				const byLower = byName.get(ref.toLowerCase());
				if (byLower) return byLower;
				throw new Error(`${label} entity not found: ${ref}`);
			}
			if (name) {
				const id = byName.get(name.toLowerCase());
				if (!id) throw new Error(`${label} entity not found: ${name}`);
				return id;
			}
			throw new Error(`${label} entity reference missing (from/to or fromName/toName required)`);
		};

		for (const relation of input.relations ?? []) {
			const from = resolveRef(relation.from, relation.fromName, "Source");
			const to = resolveRef(relation.to, relation.toName, "Target");
			const id = this.generateId();
			const newRelation: OntologyRelation = {
				from,
				to,
				type: relation.type,
				properties: relation.properties ?? {},
				id,
				createdAt: now,
			};
			relationIds.push(id);
			entries.push({ kind: "relation", ...newRelation });
		}

		// Single locked append for the whole batch
		this.ensureDirectories();
		const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
		this.withGraphLock(() => {
			appendFileSync(this.graphPath, payload, "utf8");
		});
		try {
			this.lastMtimeMs = statSync(this.graphPath).mtimeMs;
		} catch {
			// best-effort
		}

		// Update in-memory state
		for (const entry of entries) {
			if (entry.kind === "entity") {
				this.entities.set(entry.id, {
					id: entry.id,
					type: entry.type,
					name: entry.name,
					properties: entry.properties,
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
				});
			} else if (entry.kind === "relation") {
				this.relations.set(entry.id, {
					id: entry.id,
					from: entry.from,
					to: entry.to,
					type: entry.type,
					properties: entry.properties,
					createdAt: entry.createdAt,
				});
			}
		}

		return { entityIds, relationIds };
	}

	/**
	 * Ajoute une relation
	 */
	addRelation(relation: Omit<OntologyRelation, "id" | "createdAt">): string {
		this.loadGraph();

		// Verify source and destination entities exist
		if (!this.entities.has(relation.from)) {
			throw new Error(`Source entity not found: ${relation.from}`);
		}
		if (!this.entities.has(relation.to)) {
			throw new Error(`Target entity not found: ${relation.to}`);
		}

		const id = this.generateId();
		const now = new Date().toISOString();

		const newRelation: OntologyRelation = {
			...relation,
			id,
			createdAt: now,
		};

		this.relations.set(id, newRelation);

		const entry: OntologyRelationEntry = {
			kind: "relation",
			...newRelation,
		};

		this.appendToFile(entry);
		return id;
	}

	/**
	 * Recherche par id/type/nom
	 */
	findEntity(query: { id?: string; type?: string; name?: string }): OntologyEntity[] {
		this.loadGraph();

		// Direct ID lookup - return exact match
		if (query.id) {
			const entity = this.entities.get(query.id);
			return entity ? [entity] : [];
		}

		const results: OntologyEntity[] = [];

		for (const entity of this.entities.values()) {
			let matches = true;

			if (query.type && entity.type !== query.type) {
				matches = false;
			}

			if (query.name && !entity.name.toLowerCase().includes(query.name.toLowerCase())) {
				matches = false;
			}

			if (matches) {
				results.push(entity);
			}
		}

		return results;
	}

	/**
	 * Toutes les relations d'une entité
	 */
	findRelations(entityId: string): OntologyRelation[] {
		this.loadGraph();

		const results: OntologyRelation[] = [];

		for (const relation of this.relations.values()) {
			if (relation.from === entityId || relation.to === entityId) {
				results.push(relation);
			}
		}

		return results;
	}

	/**
	 * Retourne le graphe complet
	 */
	getGraph(): { entities: OntologyEntity[]; relations: OntologyRelation[] } {
		this.loadGraph();

		return {
			entities: Array.from(this.entities.values()),
			relations: Array.from(this.relations.values()),
		};
	}

	/**
	 * Supprime entité + ses relations
	 */
	removeEntity(id: string): void {
		this.loadGraph();

		if (!this.entities.has(id)) {
			throw new Error(`Entity not found: ${id}`);
		}

		// Mark as deleted in file
		const deleteEntry: OntologyDeleteEntry = {
			kind: "delete",
			targetId: id,
			deletedAt: new Date().toISOString(),
		};

		this.appendToFile(deleteEntry);

		// Remove from memory
		this.entities.delete(id);

		// Remove all linked relations
		for (const [relationId, relation] of this.relations) {
			if (relation.from === id || relation.to === id) {
				this.relations.delete(relationId);
			}
		}
	}

	/**
	 * Trouve le chemin entre deux entités (BFS)
	 */
	queryPath(
		fromId: string,
		toId: string,
		maxDepth = 5,
	): Array<{ entity: OntologyEntity; relation?: OntologyRelation }> | null {
		this.loadGraph();

		if (!this.entities.has(fromId) || !this.entities.has(toId)) {
			return null;
		}

		if (fromId === toId) {
			return [{ entity: this.entities.get(fromId)! }];
		}

		// BFS pour trouver le chemin le plus court
		const queue: Array<{ entityId: string; path: Array<{ entity: OntologyEntity; relation?: OntologyRelation }> }> = [
			{ entityId: fromId, path: [{ entity: this.entities.get(fromId)! }] },
		];

		const visited = new Set<string>([fromId]);

		while (queue.length > 0) {
			const { entityId, path } = queue.shift()!;

			if (path.length > maxDepth) {
				continue;
			}

			// Trouve toutes les relations sortantes
			for (const relation of this.relations.values()) {
				if (relation.from === entityId) {
					const targetId = relation.to;

					if (targetId === toId) {
						// Found!
						return [...path, { entity: this.entities.get(targetId)!, relation }];
					}

					if (!visited.has(targetId)) {
						visited.add(targetId);
						queue.push({
							entityId: targetId,
							path: [...path, { entity: this.entities.get(targetId)!, relation }],
						});
					}
				}

				// Relations bidirectionnelles (from <-> to)
				if (relation.to === entityId) {
					const targetId = relation.from;

					if (targetId === toId) {
						// Found!
						return [...path, { entity: this.entities.get(targetId)!, relation }];
					}

					if (!visited.has(targetId)) {
						visited.add(targetId);
						queue.push({
							entityId: targetId,
							path: [...path, { entity: this.entities.get(targetId)!, relation }],
						});
					}
				}
			}
		}

		return null; // No path found
	}

	/**
	 * Exporte tout le graphe en JSON lisible
	 */
	export(): { entities: OntologyEntity[]; relations: OntologyRelation[] } {
		return this.getGraph();
	}

	/**
	 * Statistiques : nombre d'entités par type, nombre de relations par type
	 */
	stats(): { entitiesByType: Record<string, number>; relationsByType: Record<string, number> } {
		this.loadGraph();

		const entitiesByType: Record<string, number> = {};
		const relationsByType: Record<string, number> = {};

		for (const entity of this.entities.values()) {
			entitiesByType[entity.type] = (entitiesByType[entity.type] || 0) + 1;
		}

		for (const relation of this.relations.values()) {
			relationsByType[relation.type] = (relationsByType[relation.type] || 0) + 1;
		}

		return { entitiesByType, relationsByType };
	}
}
