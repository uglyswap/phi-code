import { test, describe, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { SmartRouter } from '../src/router.js';
import type { RoutingConfig, TaskCategory } from '../src/types.js';

describe('SmartRouter', () => {
  let router: SmartRouter;
  let config: RoutingConfig;

  beforeEach(() => {
    config = SmartRouter.defaultConfig();
    router = new SmartRouter(config);
  });

  test('defaultConfig should return valid configuration', () => {
    const defaultConfig = SmartRouter.defaultConfig();
    
    assert(typeof defaultConfig === 'object');
    assert(typeof defaultConfig.routes === 'object');
    assert(typeof defaultConfig.default === 'object');
    
    // Check that all expected categories exist
    const expectedCategories: TaskCategory[] = ['code', 'debug', 'explore', 'plan', 'test', 'review', 'general'];
    for (const category of expectedCategories) {
      assert(defaultConfig.routes[category] !== undefined);
      assert(Array.isArray(defaultConfig.routes[category].keywords));
      assert(defaultConfig.routes[category].keywords.length > 0);
    }
  });

  test('getRecommendation should return correct category for code tasks', () => {
    const codePrompts = [
      'Write a function to sort an array',
      'Implement a REST API endpoint',
      'Create a class for user management',
      'Build a React component',
      'Code a solution for this problem'
    ];

    for (const prompt of codePrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'code');
      assert(typeof recommendation.model === 'string');
      assert(recommendation.agent === null || typeof recommendation.agent === 'string');
    }
  });

  test('getRecommendation should return correct category for debug tasks', () => {
    const debugPrompts = [
      'Fix this bug in my code',
      'Debug the error message',
      'Why is this function broken?',
      'Solve this issue with the API',
      'Repair the broken test'
    ];

    for (const prompt of debugPrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'debug');
    }
  });

  test('getRecommendation should return correct category for explore tasks', () => {
    const explorePrompts = [
      'Explore this codebase',
      'Understand how this works',
      'Analyze the architecture',
      'Examine the code structure',
      'Investigate the performance'
    ];

    for (const prompt of explorePrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'explore');
    }
  });

  test('getRecommendation should return correct category for plan tasks', () => {
    const planPrompts = [
      'Plan the project architecture',
      'Design a database schema',
      'Create a strategy for deployment',
      'Structure the application',
      'Organize the codebase'
    ];

    for (const prompt of planPrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'plan');
    }
  });

  test('getRecommendation should return correct category for test tasks', () => {
    const testPrompts = [
      'Write unit tests for this function',
      'Create integration tests',
      'Verify the API endpoints',
      'Test the user interface',
      'Validate the input handling'
    ];

    for (const prompt of testPrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'test');
    }
  });

  test('getRecommendation should return correct category for review tasks', () => {
    const reviewPrompts = [
      'Review this code for quality',
      'Audit the security measures',
      'Check the performance optimizations',
      'Validate the implementation',
      'Improve the code structure'
    ];

    for (const prompt of reviewPrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'review');
    }
  });

  test('getRecommendation should return general for unknown tasks', () => {
    const generalPrompts = [
      'What is the weather like?',
      'Tell me a joke',
      'Random question about physics',
      'Unrelated topic discussion'
    ];

    for (const prompt of generalPrompts) {
      const recommendation = router.getRecommendation(prompt);
      assert.equal(recommendation.category, 'general');
    }
  });

  test('getRecommendation should prioritize debug over other categories', () => {
    // Prompt that could match both debug and code keywords
    const prompt = 'Debug this function and fix the code implementation';
    const recommendation = router.getRecommendation(prompt);
    
    // Debug should have priority over code
    assert.equal(recommendation.category, 'debug');
  });

  test('getRecommendation should prioritize code over plan', () => {
    // Prompt that could match both code and plan keywords  
    const prompt = 'Plan and implement a function to handle user data';
    const recommendation = router.getRecommendation(prompt);
    
    // Code should have priority over plan
    assert.equal(recommendation.category, 'code');
  });

  test('classifyTask should handle case-insensitive matching', () => {
    const prompts = [
      'WRITE A FUNCTION',
      'Write A Function',
      'write a function',
      'WrItE a FuNcTiOn'
    ];

    for (const prompt of prompts) {
      const category = (router as any).classifyTask(prompt);
      assert.equal(category, 'code');
    }
  });

  test('classifyTask should return general for empty or unknown prompts', () => {
    const unknownPrompts = ['', 'xyz', '123', 'unknown task type'];

    for (const prompt of unknownPrompts) {
      const category = (router as any).classifyTask(prompt);
      assert.equal(category, 'general');
    }
  });

  test('getRecommendation should return default config for unknown category', () => {
    // Mock a router with incomplete configuration
    const incompleteConfig: RoutingConfig = {
      routes: {},
      default: {
        model: 'fallback-model',
        agent: 'fallback-agent'
      }
    };

    const incompleteRouter = new SmartRouter(incompleteConfig);
    const recommendation = incompleteRouter.getRecommendation('any prompt');

    assert.equal(recommendation.model, 'fallback-model');
    assert.equal(recommendation.agent, 'fallback-agent');
    assert.equal(recommendation.category, 'general');
  });

  test('loadConfig should use default when file does not exist', async () => {
    const config = await SmartRouter.loadConfig('/non/existent/path.json');
    
    // Should return default config without throwing error
    assert(typeof config === 'object');
    assert(typeof config.routes === 'object');
    assert(typeof config.default === 'object');
  });

  test('French keywords should work correctly', () => {
    const frenchPrompts = [
      'Développer une fonction',
      'Coder une solution',
      'Programmer une API',
      'Réparer ce bug',
      'Corriger cette erreur',
      'Analyser le code',
      'Comprendre l\'architecture',
      'Planifier le projet',
      'Concevoir la base de données',
      'Tester la fonction',
      'Vérifier les résultats',
      'Réviser le code',
      'Améliorer les performances'
    ];

    const expectedCategories: TaskCategory[] = [
      'code', 'code', 'code',  // développer, coder, programmer
      'debug', 'debug',        // réparer, corriger
      'explore', 'explore',    // analyser, comprendre
      'plan', 'plan',          // planifier, concevoir
      'test', 'test',          // tester, vérifier
      'review', 'review'       // réviser, améliorer
    ];

    for (let i = 0; i < frenchPrompts.length; i++) {
      const recommendation = router.getRecommendation(frenchPrompts[i]);
      assert.equal(recommendation.category, expectedCategories[i], 
        `French prompt "${frenchPrompts[i]}" should be categorized as "${expectedCategories[i]}" but got "${recommendation.category}"`);
    }
  });
});