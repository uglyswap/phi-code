export interface MemoryConfig {
	memoryDir: string; // ~/.phi/memory/
	projectMemoryDir: string; // .phi/memory/ (in the current project)
	ontologyPath: string; // ~/.phi/memory/ontology/graph.jsonl
	/**
	 * Cache directory for the embedding model downloaded by
	 * @huggingface/transformers. Defaults to <memoryDir>/models. Without it the
	 * library caches under its own node_modules folder, which is wiped by every
	 * update and unwritable for a global (sudo) npm install.
	 */
	modelCacheDir?: string;
}

export interface SearchResult {
	file: string;
	line: number;
	content: string;
	score: number;
}

export interface VectorSearchResult {
	file: string;
	chunkIndex: number;
	content: string;
	score: number; // cosine similarity 0-1
}

/** Entity types suggested to the model; the store accepts any non-empty type string. */
export type KnownOntologyEntityType =
	| "Person"
	| "Project"
	| "Device"
	| "Account"
	| "Document"
	| "Service"
	| "Concept"
	| "Library"
	| "Module"
	| "Tool";

// `string & {}` keeps editor completion for the known types while matching what
// the store actually persists (tools also propose types such as "Database").
export type OntologyEntityType = KnownOntologyEntityType | (string & {});

export interface OntologyEntity {
	id: string;
	type: OntologyEntityType;
	name: string;
	properties: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export interface OntologyRelation {
	id: string;
	from: string; // entity ID
	to: string; // entity ID
	type: string; // 'owns' | 'uses' | 'deploys' | 'manages' | 'depends_on' | etc.
	properties: Record<string, string>;
	createdAt: string;
}

export interface Note {
	file: string;
	date: string;
	content: string;
}

export interface UnifiedSearchResult {
	source: "notes" | "ontology" | "vectors";
	type?: "entity" | "relation" | "note" | "file";
	score: number;
	data: any;
}

export interface MemoryStatus {
	notes: {
		count: number;
		totalSize: number;
		lastModified: string | null;
	};
	ontology: {
		entities: number;
		relations: number;
		entitiesByType: Record<string, number>;
		relationsByType: Record<string, number>;
	};
	vectors: {
		documentCount: number;
		chunkCount: number;
		lastUpdate: string;
	};
}

// Types for ontology JSONL entries
export interface OntologyEntityEntry {
	kind: "entity";
	id: string;
	type: OntologyEntityType;
	name: string;
	properties: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export interface OntologyRelationEntry {
	kind: "relation";
	id: string;
	from: string;
	to: string;
	type: string;
	properties: Record<string, string>;
	createdAt: string;
}

export interface OntologyDeleteEntry {
	kind: "delete";
	targetId: string;
	deletedAt: string;
}

export type OntologyJSONLEntry = OntologyEntityEntry | OntologyRelationEntry | OntologyDeleteEntry;
