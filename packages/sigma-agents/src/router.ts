import { RoutingConfig, TaskCategory } from './types.js';
import { readFile } from 'node:fs/promises';

export class SmartRouter {
  private config: RoutingConfig;

  constructor(config: RoutingConfig) {
    this.config = config;
  }

  /**
   * Analyse le prompt et retourne la catégorie de tâche
   * Priorité : debug > code > plan > review > test > explore > general
   */
  classifyTask(prompt: string): TaskCategory {
    const lowerPrompt = prompt.toLowerCase();
    const categories: TaskCategory[] = [];

    // Check each category
    for (const [category, route] of Object.entries(this.config.routes)) {
      const hasKeyword = route.keywords.some(keyword => 
        lowerPrompt.includes(keyword.toLowerCase())
      );
      
      if (hasKeyword) {
        categories.push(category as TaskCategory);
      }
    }

    if (categories.length === 0) {
      return 'general';
    }

    // Apply priorities
    const priorityOrder: TaskCategory[] = ['debug', 'code', 'plan', 'review', 'test', 'explore', 'general'];
    
    for (const priority of priorityOrder) {
      if (categories.includes(priority)) {
        return priority;
      }
    }

    return categories[0];
  }

  /**
   * Retourne le modèle et l'agent recommandés pour un prompt
   */
  getRecommendation(prompt: string): { model: string; agent: string | null; category: TaskCategory } {
    const category = this.classifyTask(prompt);
    const route = this.config.routes[category];

    if (!route) {
      return {
        model: this.config.default.model,
        agent: this.config.default.agent,
        category
      };
    }

    return {
      model: route.preferredModel,
      agent: route.agent,
      category
    };
  }

  /**
   * Charge la configuration depuis un fichier JSON
   */
  static async loadConfig(configPath: string): Promise<RoutingConfig> {
    try {
      const content = await readFile(configPath, 'utf8');
      return JSON.parse(content);
    } catch {
      // File doesn't exist yet — use defaults silently
      return SmartRouter.defaultConfig();
    }
  }

  /**
   * Default configuration with provider-agnostic model names.
   * Uses 'default' as model placeholder — the actual model is determined
   * at runtime by /phi-init or the user's routing.json.
   */
  static defaultConfig(): RoutingConfig {
    return {
      routes: {
        code: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['code', 'implement', 'write', 'create', 'build', 'développer', 'coder', 'programmer', 'function', 'class', 'method']
        },
        debug: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['debug', 'fix', 'error', 'bug', 'broken', 'issue', 'problem', 'repair', 'correct', 'erreur', 'problème', 'réparer']
        },
        explore: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['explore', 'understand', 'analyze', 'examine', 'investigate', 'study', 'review', 'explorer', 'analyser', 'comprendre']
        },
        plan: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['plan', 'design', 'architecture', 'strategy', 'approach', 'structure', 'organize', 'concevoir', 'planifier', 'architecture']
        },
        test: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['test', 'testing', 'unit', 'integration', 'verify', 'validate', 'check', 'tester', 'vérifier', 'valider']
        },
        review: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['review', 'audit', 'check', 'validate', 'quality', 'improve', 'optimize', 'réviser', 'améliorer', 'optimiser']
        },
        general: {
          preferredModel: 'default',
          fallback: 'default',
          agent: null,
          keywords: ['help', 'explain', 'what', 'how', 'why', 'question', 'aide', 'expliquer', 'comment', 'pourquoi']
        }
      },
      default: {
        model: 'default',
        agent: null
      }
    };
  }
}