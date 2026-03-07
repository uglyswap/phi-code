import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import type { MemoryConfig, Note } from './types.js';

export class NotesManager {
  private config: MemoryConfig;
  private notesDir: string;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.notesDir = join(config.memoryDir, 'notes');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!existsSync(this.config.memoryDir)) {
      mkdirSync(this.config.memoryDir, { recursive: true });
    }
    if (!existsSync(this.notesDir)) {
      mkdirSync(this.notesDir, { recursive: true });
    }
  }

  /**
   * Écrit dans un fichier .md (date du jour si pas de nom)
   */
  write(content: string, filename?: string): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const file = filename || `${today}.md`;
    const filePath = join(this.notesDir, file);
    
    writeFileSync(filePath, content, 'utf8');
  }

  /**
   * Lit un fichier
   */
  read(filename: string): string {
    const filePath = join(this.notesDir, filename);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filename}`);
    }
    return readFileSync(filePath, 'utf8');
  }

  /**
   * Liste tous les fichiers .md avec leur taille et date
   */
  list(): Array<{ name: string; size: number; date: string }> {
    if (!existsSync(this.notesDir)) {
      return [];
    }

    return readdirSync(this.notesDir)
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const filePath = join(this.notesDir, file);
        const stats = statSync(filePath);
        return {
          name: file,
          size: stats.size,
          date: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Recherche full-text (grep-like) dans tous les .md
   */
  search(query: string): Array<{ file: string; line: number; content: string }> {
    if (!existsSync(this.notesDir)) {
      return [];
    }

    const results: Array<{ file: string; line: number; content: string }> = [];
    
    try {
      // Utilise grep pour une recherche efficace
      const grepResult = execSync(
        `grep -n "${query.replace(/"/g, '\\"')}" "${this.notesDir}"/*.md 2>/dev/null || true`,
        { encoding: 'utf8' }
      );

      if (grepResult.trim()) {
        const lines = grepResult.trim().split('\n');
        for (const line of lines) {
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (match) {
            const [, fullPath, lineNumber, content] = match;
            const filename = fullPath.replace(this.notesDir + '/', '');
            results.push({
              file: filename,
              line: parseInt(lineNumber),
              content: content.trim()
            });
          }
        }
      }
    } catch (error) {
      // Fallback à une recherche en JavaScript si grep échoue
      const files = readdirSync(this.notesDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = join(this.notesDir, file);
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              file,
              line: index + 1,
              content: line.trim()
            });
          }
        });
      }
    }

    return results;
  }

  /**
   * Retourne les notes des N derniers jours
   */
  getRecent(days: number): Note[] {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const files = this.list().filter(file => {
      const fileDate = new Date(file.date);
      return fileDate >= cutoffDate;
    });

    return files.map(file => {
      const content = this.read(file.name);
      return {
        file: file.name,
        date: file.date,
        content
      };
    });
  }

  /**
   * Ajoute à un fichier existant
   */
  append(content: string, filename?: string): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const file = filename || `${today}.md`;
    const filePath = join(this.notesDir, file);
    
    // Ajoute une ligne vide si le fichier existe déjà et ne se termine pas par une ligne vide
    if (existsSync(filePath)) {
      const existingContent = readFileSync(filePath, 'utf8');
      const separator = existingContent.endsWith('\n') ? '' : '\n';
      appendFileSync(filePath, separator + content, 'utf8');
    } else {
      writeFileSync(filePath, content, 'utf8');
    }
  }
}