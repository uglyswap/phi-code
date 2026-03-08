import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { NotesManager } from './notes.js';
import { OntologyManager } from './ontology.js';
import { VectorStore } from './vector-store.js';
import type { MemoryConfig, UnifiedSearchResult, MemoryStatus } from './types.js';

export class SigmaMemory {
  public readonly notes: NotesManager;
  public readonly ontology: OntologyManager;
  public readonly vectors: VectorStore;
  private readonly config: MemoryConfig;

  constructor(config?: Partial<MemoryConfig>) {
    // Default configuration
    const defaultConfig: MemoryConfig = {
      memoryDir: join(homedir(), '.phi', 'memory'),
      projectMemoryDir: join(process.cwd(), '.phi', 'memory'),
      ontologyPath: join(homedir(), '.phi', 'memory', 'ontology', 'graph.jsonl')
    };

    this.config = { ...defaultConfig, ...config };

    // Initialize managers
    this.notes = new NotesManager(this.config);
    this.ontology = new OntologyManager(this.config);
    this.vectors = new VectorStore(join(this.config.memoryDir, 'vectors.db'));
  }

  /**
   * Unified search: searches notes + ontology + vectors, combines results
   */
  async search(query: string): Promise<UnifiedSearchResult[]> {
    const results: UnifiedSearchResult[] = [];

    // Search in notes (full-text grep)
    try {
      const notesResults = this.notes.search(query);
      for (const result of notesResults) {
        results.push({
          source: 'notes',
          type: 'note',
          score: 0.8, // Default score for text-match notes
          data: result
        });
      }
    } catch (error) {
      // Notes search failed silently
    }

    // Search in ontology
    try {
      const entityResults = this.ontology.findEntity({ name: query });
      for (const entity of entityResults) {
        results.push({
          source: 'ontology',
          type: 'entity',
          score: 0.9,
          data: entity
        });

        // Include relations for this entity
        const relations = this.ontology.findRelations(entity.id);
        for (const relation of relations) {
          results.push({
            source: 'ontology',
            type: 'relation',
            score: 0.7,
            data: relation
          });
        }
      }
    } catch (error) {
      // Ontology search failed silently
    }

    // Vector similarity search
    try {
      const vectorResults = await this.vectors.search(query, 5);
      for (const result of vectorResults) {
        results.push({
          source: 'vectors',
          type: 'file',
          score: result.score,
          data: result
        });
      }
    } catch (error) {
      // Vector search failed silently
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Initialize all required directories and the vector store.
   * On first run, this will download the embedding model and index notes.
   */
  async init(): Promise<void> {
    // Create base directories
    if (!existsSync(this.config.memoryDir)) {
      mkdirSync(this.config.memoryDir, { recursive: true });
    }

    if (!existsSync(this.config.projectMemoryDir)) {
      mkdirSync(this.config.projectMemoryDir, { recursive: true });
    }

    // Initialize vector store (DB setup only — fast)
    await this.vectors.init();

    // Auto-index existing notes into the vector store
    await this.indexNotes();
  }

  /**
   * Index all markdown notes into the vector store.
   * Reads every .md file from the notes directory and adds it.
   */
  async indexNotes(): Promise<void> {
    const notesList = this.notes.list();

    for (const note of notesList) {
      try {
        const content = this.notes.read(note.name);
        await this.vectors.addDocument(note.name, content);
      } catch {
        // Skip files that can't be read
      }
    }
  }

  /**
   * Status of all subsystems
   */
  async status(): Promise<MemoryStatus> {
    // Notes status
    const notesList = this.notes.list();
    const notesStatus = {
      count: notesList.length,
      totalSize: notesList.reduce((sum, note) => sum + note.size, 0),
      lastModified: notesList.length > 0 ? notesList[0].date : null
    };

    // Ontology status
    const ontologyStats = this.ontology.stats();
    const ontologyGraph = this.ontology.getGraph();
    const ontologyStatus = {
      entities: ontologyGraph.entities.length,
      relations: ontologyGraph.relations.length,
      entitiesByType: ontologyStats.entitiesByType,
      relationsByType: ontologyStats.relationsByType
    };

    // Vector store status
    const vectorStats = this.vectors.getStats();

    return {
      notes: notesStatus,
      ontology: ontologyStatus,
      vectors: vectorStats
    };
  }

  /**
   * Current configuration
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }
}

// Convenient exports
export { NotesManager } from './notes.js';
export { OntologyManager } from './ontology.js';
export { VectorStore } from './vector-store.js';
export * from './types.js';

// Default export
export default SigmaMemory;
