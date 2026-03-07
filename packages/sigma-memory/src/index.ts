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
    // Configuration par défaut
    const defaultConfig: MemoryConfig = {
      memoryDir: join(homedir(), '.phi', 'memory'),
      projectMemoryDir: join(process.cwd(), '.phi', 'memory'),
      ontologyPath: join(homedir(), '.phi', 'memory', 'ontology', 'graph.jsonl'),
      qmdEnabled: true,
      qmdCommand: 'qmd'
    };

    this.config = { ...defaultConfig, ...config };

    // Initialise les managers
    this.notes = new NotesManager(this.config);
    this.ontology = new OntologyManager(this.config);
    this.qmd = new QMDManager(this.config);
  }

  /**
   * Recherche unifiée : cherche dans notes + ontology + QMD, combine les résultats
   */
  async search(query: string): Promise<UnifiedSearchResult[]> {
    const results: UnifiedSearchResult[] = [];

    // Recherche dans les notes
    try {
      const notesResults = this.notes.search(query);
      for (const result of notesResults) {
        results.push({
          source: 'notes',
          type: 'note',
          score: 0.8, // Score par défaut pour les notes
          data: result
        });
      }
    } catch (error) {
      console.error('Notes search error:', error);
    }

    // Recherche dans l'ontologie
    try {
      const entityResults = this.ontology.findEntity({ name: query });
      for (const entity of entityResults) {
        results.push({
          source: 'ontology',
          type: 'entity',
          score: 0.9, // Score élevé pour les entités
          data: entity
        });

        // Inclut aussi les relations de cette entité
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
      console.error('Ontology search error:', error);
    }

    // Recherche QMD (vectorielle)
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
      console.error('QMD search error:', error);
    }

    // Trie par score décroissant
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Initialise tous les dossiers nécessaires
   */
  async init(): Promise<void> {
    // Crée les dossiers de base
    if (!existsSync(this.config.memoryDir)) {
      mkdirSync(this.config.memoryDir, { recursive: true });
    }

    if (!existsSync(this.config.projectMemoryDir)) {
      mkdirSync(this.config.projectMemoryDir, { recursive: true });
    }

    // Initialise QMD si activé
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      try {
        await this.qmd.update();
      } catch (error) {
        console.error('QMD initialization error:', error);
      }
    }
  }

  /**
   * Status de tous les sous-systèmes
   */
  async status(): Promise<MemoryStatus> {
    // Status des notes
    const notesList = this.notes.list();
    const notesStatus = {
      count: notesList.length,
      totalSize: notesList.reduce((sum, note) => sum + note.size, 0),
      lastModified: notesList.length > 0 ? notesList[0].date : null
    };

    // Status de l'ontologie
    const ontologyStats = this.ontology.stats();
    const ontologyGraph = this.ontology.getGraph();
    const ontologyStatus = {
      entities: ontologyGraph.entities.length,
      relations: ontologyGraph.relations.length,
      entitiesByType: ontologyStats.entitiesByType,
      relationsByType: ontologyStats.relationsByType
    };

    // Status QMD
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
   * Configuration actuelle
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }
}

// Exports pour une utilisation facile
export { NotesManager } from './notes.js';
export { OntologyManager } from './ontology.js';
export { QMDManager } from './qmd.js';
export * from './types.js';

// Export par défaut
export default SigmaMemory;