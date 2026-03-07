import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { NotesManager } from './notes.js';
import { OntologyManager } from './ontology.js';
import { QMDManager } from './qmd.js';
import type { MemoryConfig, UnifiedSearchResult, MemoryStatus } from './types.js';

export class SigmaMemory {
  public readonly notes: NotesManager;
  public readonly ontology: OntologyManager;
  public readonly qmd: QMDManager;
  private readonly config: MemoryConfig;

  constructor(config?: Partial<MemoryConfig>) {
    // Default configuration
    const defaultConfig: MemoryConfig = {
      memoryDir: join(homedir(), '.phi', 'memory'),
      projectMemoryDir: join(process.cwd(), '.phi', 'memory'),
      ontologyPath: join(homedir(), '.phi', 'memory', 'ontology', 'graph.jsonl'),
      qmdEnabled: true,
      qmdCommand: 'qmd'
    };

    this.config = { ...defaultConfig, ...config };

    // Initialize managers
    this.notes = new NotesManager(this.config);
    this.ontology = new OntologyManager(this.config);
    this.qmd = new QMDManager(this.config);
  }

  /**
   * Unified search: searches notes + ontology + QMD, combines results
   */
  async search(query: string): Promise<UnifiedSearchResult[]> {
    const results: UnifiedSearchResult[] = [];

    // Search in notes
    try {
      const notesResults = this.notes.search(query);
      for (const result of notesResults) {
        results.push({
          source: 'notes',
          type: 'note',
          score: 0.8, // Default score for notes
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

    // QMD vector search
    try {
      const qmdResults = await this.qmd.search(query, 5);
      for (const result of qmdResults) {
        results.push({
          source: 'qmd',
          type: 'file',
          score: result.score,
          data: result
        });
      }
    } catch (error) {
      // QMD search failed silently
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Initialize all required directories
   */
  async init(): Promise<void> {
    // Create base directories
    if (!existsSync(this.config.memoryDir)) {
      mkdirSync(this.config.memoryDir, { recursive: true });
    }

    if (!existsSync(this.config.projectMemoryDir)) {
      mkdirSync(this.config.projectMemoryDir, { recursive: true });
    }

    // Initialize QMD if enabled
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      try {
        await this.qmd.update();
      } catch (error) {
        // QMD initialization failed silently
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

    // QMD status
    let qmdStatus: MemoryStatus['qmd'] = { available: false };
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      const status = await this.qmd.status();
      qmdStatus = {
        available: true,
        status: status || { files: 0, chunks: 0, lastUpdate: null }
      };
    }

    return {
      notes: notesStatus,
      ontology: ontologyStatus,
      qmd: qmdStatus
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
export { QMDManager } from './qmd.js';
export * from './types.js';

// Default export
export default SigmaMemory;