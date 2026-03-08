import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { OntologyManager } from '../src/ontology.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { MemoryConfig, OntologyEntity } from '../src/types.js';

describe('OntologyManager', () => {
  let ontologyManager: OntologyManager;
  let tempDir: string;

  beforeEach(() => {
    // Create temporary test directory
    tempDir = join(process.cwd(), 'test-ontology-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    
    const config: MemoryConfig = {
      memoryDir: tempDir,
      projectMemoryDir: join(tempDir, 'project'),
      ontologyPath: join(tempDir, 'ontology', 'graph.jsonl')
    };
    
    ontologyManager = new OntologyManager(config);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('addEntity should create a new entity with ID', () => {
    const entityData = {
      type: 'Person' as const,
      name: 'John Doe',
      properties: { email: 'john@example.com' }
    };
    
    const id = ontologyManager.addEntity(entityData);
    
    assert(typeof id === 'string');
    assert(id.length > 0);
    
    const entities = ontologyManager.findEntity({ name: 'John Doe' });
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'John Doe');
    assert.equal(entities[0].type, 'Person');
    assert.equal(entities[0].properties.email, 'john@example.com');
  });

  test('addRelation should create a relation between entities', () => {
    // Create two entities
    const personId = ontologyManager.addEntity({
      type: 'Person',
      name: 'Alice',
      properties: {}
    });
    
    const projectId = ontologyManager.addEntity({
      type: 'Project',
      name: 'My Project',
      properties: {}
    });
    
    // Create relation
    const relationId = ontologyManager.addRelation({
      from: personId,
      to: projectId,
      type: 'owns',
      properties: { role: 'owner' }
    });
    
    assert(typeof relationId === 'string');
    
    const relations = ontologyManager.findRelations(personId);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].from, personId);
    assert.equal(relations[0].to, projectId);
    assert.equal(relations[0].type, 'owns');
  });

  test('addRelation should throw error for non-existent entities', () => {
    assert.throws(() => {
      ontologyManager.addRelation({
        from: 'invalid-id',
        to: 'another-invalid-id',
        type: 'test',
        properties: {}
      });
    }, /Source entity not found/);
  });

  test('findEntity should filter by type', () => {
    ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    ontologyManager.addEntity({ type: 'Project', name: 'Project A', properties: {} });
    ontologyManager.addEntity({ type: 'Person', name: 'Bob', properties: {} });
    
    const people = ontologyManager.findEntity({ type: 'Person' });
    assert.equal(people.length, 2);
    assert(people.every(p => p.type === 'Person'));
  });

  test('findEntity should filter by name (case-insensitive)', () => {
    ontologyManager.addEntity({ type: 'Person', name: 'Alice Smith', properties: {} });
    ontologyManager.addEntity({ type: 'Person', name: 'Bob Johnson', properties: {} });
    
    const results = ontologyManager.findEntity({ name: 'alice' });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Alice Smith');
  });

  test('findRelations should return all relations for an entity', () => {
    const personId = ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    const project1Id = ontologyManager.addEntity({ type: 'Project', name: 'Project 1', properties: {} });
    const project2Id = ontologyManager.addEntity({ type: 'Project', name: 'Project 2', properties: {} });
    
    ontologyManager.addRelation({ from: personId, to: project1Id, type: 'owns', properties: {} });
    ontologyManager.addRelation({ from: personId, to: project2Id, type: 'manages', properties: {} });
    ontologyManager.addRelation({ from: project1Id, to: personId, type: 'owned_by', properties: {} });
    
    const relations = ontologyManager.findRelations(personId);
    assert.equal(relations.length, 3); // All relations involving this entity
  });

  test('queryPath should find path between entities', () => {
    const aliceId = ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    const projectId = ontologyManager.addEntity({ type: 'Project', name: 'Project', properties: {} });
    const serviceId = ontologyManager.addEntity({ type: 'Service', name: 'Service', properties: {} });
    
    ontologyManager.addRelation({ from: aliceId, to: projectId, type: 'owns', properties: {} });
    ontologyManager.addRelation({ from: projectId, to: serviceId, type: 'uses', properties: {} });
    
    const path = ontologyManager.queryPath(aliceId, serviceId);
    
    assert(path !== null);
    assert.equal(path.length, 3); // Alice -> Project -> Service
    assert.equal(path[0].entity.name, 'Alice');
    assert.equal(path[1].entity.name, 'Project');
    assert.equal(path[2].entity.name, 'Service');
  });

  test('queryPath should return null for no path', () => {
    const alice = ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    const bob = ontologyManager.addEntity({ type: 'Person', name: 'Bob', properties: {} });
    
    // No relations between them
    const path = ontologyManager.queryPath(alice, bob);
    assert.equal(path, null);
  });

  test('stats should return entity and relation counts by type', () => {
    ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    ontologyManager.addEntity({ type: 'Person', name: 'Bob', properties: {} });
    ontologyManager.addEntity({ type: 'Project', name: 'Project', properties: {} });
    
    const personId = ontologyManager.findEntity({ name: 'Alice' })[0].id;
    const projectId = ontologyManager.findEntity({ name: 'Project' })[0].id;
    ontologyManager.addRelation({ from: personId, to: projectId, type: 'owns', properties: {} });
    
    const stats = ontologyManager.stats();
    
    assert.equal(stats.entitiesByType['Person'], 2);
    assert.equal(stats.entitiesByType['Project'], 1);
    assert.equal(stats.relationsByType['owns'], 1);
  });

  test('export should return all entities and relations', () => {
    ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    const projectId = ontologyManager.addEntity({ type: 'Project', name: 'Project', properties: {} });
    
    const exported = ontologyManager.export();
    
    assert.equal(exported.entities.length, 2);
    assert.equal(exported.relations.length, 0);
    assert(exported.entities.some(e => e.name === 'Alice'));
    assert(exported.entities.some(e => e.name === 'Project'));
  });

  test('removeEntity should delete entity and its relations', () => {
    const aliceId = ontologyManager.addEntity({ type: 'Person', name: 'Alice', properties: {} });
    const projectId = ontologyManager.addEntity({ type: 'Project', name: 'Project', properties: {} });
    
    ontologyManager.addRelation({ from: aliceId, to: projectId, type: 'owns', properties: {} });
    
    // Verify entity and relation exist
    assert.equal(ontologyManager.findEntity({ name: 'Alice' }).length, 1);
    assert.equal(ontologyManager.findRelations(aliceId).length, 1);
    
    // Remove entity
    ontologyManager.removeEntity(aliceId);
    
    // Verify entity and its relations are gone
    assert.equal(ontologyManager.findEntity({ name: 'Alice' }).length, 0);
    assert.equal(ontologyManager.findRelations(aliceId).length, 0);
  });

  test('removeEntity should throw error for non-existent entity', () => {
    assert.throws(() => {
      ontologyManager.removeEntity('invalid-id');
    }, /Entity not found/);
  });
});