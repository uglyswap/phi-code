import { ModelProfile, TaskCategory } from './types';
import { readFile, writeFile } from 'node:fs/promises';

export class ModelProfiler {
  public profiles: Map<string, ModelProfile> = new Map();

  /**
   * Charge les profiles depuis un fichier JSON
   */
  async loadFromFile(path: string): Promise<void> {
    try {
      const content = await readFile(path, 'utf8');
      const data = JSON.parse(content);
      
      if (Array.isArray(data.profiles)) {
        this.profiles.clear();
        for (const profile of data.profiles) {
          this.profiles.set(profile.id, profile);
        }
      }
    } catch (error) {
      // Si le fichier n'existe pas, on utilise les profiles par défaut
      console.warn(`Could not load profiles from ${path}:`, error);
      this.loadDefaultProfiles();
    }
  }

  /**
   * Sauvegarde les profiles vers un fichier JSON
   */
  async saveToFile(path: string): Promise<void> {
    const data = {
      profiles: Array.from(this.profiles.values())
    };
    
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Ajoute un profile
   */
  addProfile(profile: ModelProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /**
   * Retourne le meilleur modèle pour une tâche donnée
   */
  getBestForTask(category: TaskCategory): ModelProfile | null {
    const candidates = Array.from(this.profiles.values())
      .filter(profile => profile.strengths.includes(category))
      .sort((a, b) => {
        // Priorité: quality > speed > cost
        if (a.quality !== b.quality) {
          const qualityOrder = { high: 3, medium: 2, low: 1 };
          return qualityOrder[b.quality] - qualityOrder[a.quality];
        }
        
        if (a.speed !== b.speed) {
          const speedOrder = { fast: 3, medium: 2, slow: 1 };
          return speedOrder[b.speed] - speedOrder[a.speed];
        }
        
        return a.cost - b.cost; // Coût plus bas = mieux
      });
    
    return candidates[0] || null;
  }

  /**
   * Charge les profiles par défaut des modèles Alibaba
   */
  private loadDefaultProfiles(): void {
    const defaultProfiles = this.getDefaultProfiles();
    this.profiles.clear();
    
    for (const profile of defaultProfiles) {
      this.profiles.set(profile.id, profile);
    }
  }

  /**
   * Retourne les profiles par défaut des 8 modèles Alibaba
   */
  getDefaultProfiles(): ModelProfile[] {
    return [
      {
        id: 'qwen3.5-plus',
        provider: 'alibaba',
        cost: 0,
        speed: 'medium',
        quality: 'high',
        strengths: ['code', 'debug', 'plan', 'review', 'general'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'qwen3-max-2026-01-23',
        provider: 'alibaba',
        cost: 0,
        speed: 'slow',
        quality: 'high',
        strengths: ['plan', 'debug', 'review'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'qwen3-coder-plus',
        provider: 'alibaba',
        cost: 0,
        speed: 'medium',
        quality: 'high',
        strengths: ['code', 'debug'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'qwen3-coder-next',
        provider: 'alibaba',
        cost: 0,
        speed: 'fast',
        quality: 'high',
        strengths: ['code'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'kimi-k2.5',
        provider: 'alibaba',
        cost: 0,
        speed: 'fast',
        quality: 'medium',
        strengths: ['explore', 'test', 'general'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'glm-5',
        provider: 'alibaba',
        cost: 0,
        speed: 'medium',
        quality: 'medium',
        strengths: ['general', 'code'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'glm-4.7',
        provider: 'alibaba',
        cost: 0,
        speed: 'fast',
        quality: 'low',
        strengths: ['explore', 'general'],
        maxTokens: 131072,
        supportsTools: true
      },
      {
        id: 'MiniMax-M2.5',
        provider: 'alibaba',
        cost: 0,
        speed: 'fast',
        quality: 'medium',
        strengths: ['general'],
        maxTokens: 131072,
        supportsTools: true
      }
    ];
  }
}