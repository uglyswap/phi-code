import { ModelProfile, TaskCategory } from './types.js';
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
      // If file doesn't exist, use default profiles
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
        // Priority: quality > speed
        if (a.quality !== b.quality) {
          const qualityOrder = { high: 3, medium: 2, low: 1 };
          return qualityOrder[b.quality] - qualityOrder[a.quality];
        }
        
        if (a.speed !== b.speed) {
          const speedOrder = { fast: 3, medium: 2, slow: 1 };
          return speedOrder[b.speed] - speedOrder[a.speed];
        }
        
        return 0; // Equal priority
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
   * Returns empty default profiles.
   * Actual profiles should be populated from /phi-init or user configuration.
   * sigma-agents is provider-agnostic — no hardcoded model names.
   */
  getDefaultProfiles(): ModelProfile[] {
    return [];
  }
}