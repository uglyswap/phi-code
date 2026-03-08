export interface MemoryConfig {
  memoryDir: string;        // ~/.phi/memory/
  projectMemoryDir: string; // .phi/memory/ (in the current project)
  ontologyPath: string;     // ~/.phi/memory/ontology/graph.jsonl
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

export interface OntologyEntity {
  id: string;
  type: 'Person' | 'Project' | 'Device' | 'Account' | 'Document' | 'Service' | 'Concept';
  name: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface OntologyRelation {
  id: string;
  from: string;      // entity ID
  to: string;        // entity ID
  type: string;      // 'owns' | 'uses' | 'deploys' | 'manages' | 'depends_on' | etc.
  properties: Record<string, string>;
  createdAt: string;
}

export interface Note {
  file: string;
  date: string;
  content: string;
}

export interface UnifiedSearchResult {
  source: 'notes' | 'ontology' | 'vectors';
  type?: 'entity' | 'relation' | 'note' | 'file';
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
  kind: 'entity';
  id: string;
  type: 'Person' | 'Project' | 'Device' | 'Account' | 'Document' | 'Service' | 'Concept';
  name: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface OntologyRelationEntry {
  kind: 'relation';
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, string>;
  createdAt: string;
}

export interface OntologyDeleteEntry {
  kind: 'delete';
  targetId: string;
  deletedAt: string;
}

export type OntologyJSONLEntry = OntologyEntityEntry | OntologyRelationEntry | OntologyDeleteEntry;
