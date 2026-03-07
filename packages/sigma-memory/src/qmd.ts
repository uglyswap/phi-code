import { execSync } from 'child_process';
import type { MemoryConfig, SearchResult } from './types.js';

export class QMDManager {
  private config: MemoryConfig;
  private qmdCommand: string;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.qmdCommand = config.qmdCommand || 'qmd';
  }

  /**
   * Retourne true si QMD est installé et fonctionnel
   */
  isAvailable(): boolean {
    if (!this.config.qmdEnabled) {
      return false;
    }

    try {
      // Teste si le binaire QMD est accessible
      execSync(`${this.qmdCommand} --version`, { 
        stdio: 'ignore',
        timeout: 5000 
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Lance `qmd query` et parse les résultats
   */
  async search(query: string, maxResults = 10): Promise<SearchResult[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const output = execSync(
        `${this.qmdCommand} query "${query.replace(/"/g, '\\"')}" --limit ${maxResults} --format json`,
        { 
          encoding: 'utf8',
          timeout: 30000,
          cwd: this.config.memoryDir
        }
      );

      if (!output.trim()) {
        return [];
      }

      const result = JSON.parse(output);
      
      // Le format attendu est { results: [{file, line, content, score}] }
      if (result.results && Array.isArray(result.results)) {
        return result.results.map((item: any) => ({
          file: item.file || '',
          line: item.line || 0,
          content: item.content || '',
          score: item.score || 0
        }));
      }

      return [];
    } catch (error) {
      console.error('QMD search error:', error);
      return [];
    }
  }

  /**
   * Lance `qmd update` pour reindexer
   */
  async update(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      execSync(`${this.qmdCommand} update`, {
        stdio: 'ignore',
        timeout: 60000,
        cwd: this.config.memoryDir
      });
      return true;
    } catch (error) {
      console.error('QMD update error:', error);
      return false;
    }
  }

  /**
   * Lance `qmd embed` pour recalculer les embeddings
   */
  async embed(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      execSync(`${this.qmdCommand} embed`, {
        stdio: 'ignore',
        timeout: 300000, // 5 minutes pour les embeddings
        cwd: this.config.memoryDir
      });
      return true;
    } catch (error) {
      console.error('QMD embed error:', error);
      return false;
    }
  }

  /**
   * Liste les collections QMD
   */
  async collections(): Promise<string[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const output = execSync(`${this.qmdCommand} collections --format json`, {
        encoding: 'utf8',
        timeout: 10000,
        cwd: this.config.memoryDir
      });

      if (!output.trim()) {
        return [];
      }

      const result = JSON.parse(output);
      
      // Retourne la liste des noms de collections
      if (result.collections && Array.isArray(result.collections)) {
        return result.collections.map((col: any) => col.name || col);
      }

      return [];
    } catch (error) {
      console.error('QMD collections error:', error);
      return [];
    }
  }

  /**
   * Retourne le statut (nb fichiers, nb chunks, dernière mise à jour)
   */
  async status(): Promise<{ files: number; chunks: number; lastUpdate: string | null } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const output = execSync(`${this.qmdCommand} status --format json`, {
        encoding: 'utf8',
        timeout: 10000,
        cwd: this.config.memoryDir
      });

      if (!output.trim()) {
        return { files: 0, chunks: 0, lastUpdate: null };
      }

      const result = JSON.parse(output);
      
      return {
        files: result.files || 0,
        chunks: result.chunks || 0,
        lastUpdate: result.lastUpdate || null
      };
    } catch (error) {
      console.error('QMD status error:', error);
      return { files: 0, chunks: 0, lastUpdate: null };
    }
  }
}