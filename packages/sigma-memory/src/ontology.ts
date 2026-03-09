import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import type { 
  MemoryConfig, 
  OntologyEntity, 
  OntologyRelation,
  OntologyJSONLEntry,
  OntologyEntityEntry,
  OntologyRelationEntry,
  OntologyDeleteEntry
} from './types.js';

export class OntologyManager {
  private config: MemoryConfig;
  private graphPath: string;
  private entities: Map<string, OntologyEntity> = new Map();
  private relations: Map<string, OntologyRelation> = new Map();
  private loaded = false;

  constructor(config: MemoryConfig) {
    this.config = config;
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
    return randomBytes(16).toString('hex');
  }

  private loadGraph(): void {
    if (this.loaded) return;

    this.entities.clear();
    this.relations.clear();

    if (!existsSync(this.graphPath)) {
      this.loaded = true;
      return;
    }

    const content = readFileSync(this.graphPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const entry: OntologyJSONLEntry = JSON.parse(line);

        switch (entry.kind) {
          case 'entity':
            this.entities.set(entry.id, {
              id: entry.id,
              type: entry.type,
              name: entry.name,
              properties: entry.properties,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt
            });
            break;

          case 'relation':
            this.relations.set(entry.id, {
              id: entry.id,
              from: entry.from,
              to: entry.to,
              type: entry.type,
              properties: entry.properties,
              createdAt: entry.createdAt
            });
            break;

          case 'delete':
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
      } catch (error) {
        // Skip malformed JSONL line
      }
    }

    this.loaded = true;
  }

  private appendToFile(entry: OntologyJSONLEntry): void {
    this.ensureDirectories();
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.graphPath, line, 'utf8');
  }

  /**
   * Ajoute une entité
   */
  addEntity(entity: Omit<OntologyEntity, 'id' | 'createdAt' | 'updatedAt'>): string {
    this.loadGraph();

    const id = this.generateId();
    const now = new Date().toISOString();
    
    const newEntity: OntologyEntity = {
      ...entity,
      id,
      createdAt: now,
      updatedAt: now
    };

    this.entities.set(id, newEntity);

    const entry: OntologyEntityEntry = {
      kind: 'entity',
      ...newEntity
    };

    this.appendToFile(entry);
    return id;
  }

  /**
   * Ajoute une relation
   */
  addRelation(relation: Omit<OntologyRelation, 'id' | 'createdAt'>): string {
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
      createdAt: now
    };

    this.relations.set(id, newRelation);

    const entry: OntologyRelationEntry = {
      kind: 'relation',
      ...newRelation
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
      relations: Array.from(this.relations.values())
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
      kind: 'delete',
      targetId: id,
      deletedAt: new Date().toISOString()
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
  queryPath(fromId: string, toId: string, maxDepth = 5): Array<{ entity: OntologyEntity; relation?: OntologyRelation }> | null {
    this.loadGraph();

    if (!this.entities.has(fromId) || !this.entities.has(toId)) {
      return null;
    }

    if (fromId === toId) {
      return [{ entity: this.entities.get(fromId)! }];
    }

    // BFS pour trouver le chemin le plus court
    const queue: Array<{ entityId: string; path: Array<{ entity: OntologyEntity; relation?: OntologyRelation }> }> = [
      { entityId: fromId, path: [{ entity: this.entities.get(fromId)! }] }
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
              path: [...path, { entity: this.entities.get(targetId)!, relation }]
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
              path: [...path, { entity: this.entities.get(targetId)!, relation }]
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