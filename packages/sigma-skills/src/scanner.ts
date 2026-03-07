import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillsConfig } from './types.js';

export class SkillScanner {
  private config: SkillsConfig;

  constructor(config: SkillsConfig) {
    this.config = config;
  }

  /**
   * Scanne tous les répertoires et charge les skills
   */
  scan(): Skill[] {
    const skills: Skill[] = [];
    
    // Scanner les trois répertoires possibles
    const dirs = [
      this.config.globalDir,
      this.config.projectDir,
      this.config.bundledDir
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(dir, entry.name);
          const skill = this.loadSkill(skillPath);
          if (skill) {
            skills.push(skill);
          }
        }
      }
    }

    return skills;
  }

  /**
   * Charge un skill depuis un dossier (lit SKILL.md, extrait keywords des headers/bullet points)
   */
  loadSkill(dir: string): Skill | null {
    const skillMdPath = path.join(dir, 'SKILL.md');
    
    if (!fs.existsSync(skillMdPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const name = path.basename(dir);
      
      // Extraire la description du premier paragraphe après le titre
      const lines = content.split('\n');
      let description = '';
      let foundHeader = false;
      
      for (const line of lines) {
        if (line.startsWith('#')) {
          foundHeader = true;
          continue;
        }
        if (foundHeader && line.trim()) {
          description = line.trim();
          break;
        }
      }
      
      // Extraire les mots-clés
      const keywords = this.extractKeywords(content);
      
      // Lister les fichiers du dossier
      const files = this.getSkillFiles(dir);
      
      return {
        name,
        description: description || `Skill: ${name}`,
        content,
        path: dir,
        keywords,
        files
      };
    } catch (error) {
      console.warn(`Failed to load skill from ${dir}:`, error);
      return null;
    }
  }

  /**
   * Extrait les mots-clés d'un SKILL.md (headers h1/h2, mots après "When to use", termes techniques)
   */
  extractKeywords(content: string): string[] {
    const keywords = new Set<string>();
    const lines = content.split('\n');
    
    for (const line of lines) {
      // Headers H1/H2
      if (line.startsWith('#')) {
        const headerText = line.replace(/^#+\s*/, '').toLowerCase();
        this.addWordsToKeywords(headerText, keywords);
      }
      
      // Lignes contenant "when to use", "use when", etc.
      if (line.toLowerCase().includes('when to use') || 
          line.toLowerCase().includes('use when') ||
          line.toLowerCase().includes('trigger on')) {
        this.addWordsToKeywords(line, keywords);
      }
      
      // Listes à puces (bullet points)
      if (line.trim().startsWith('-') || line.trim().startsWith('*')) {
        const bulletText = line.replace(/^\s*[-*]\s*/, '');
        this.addWordsToKeywords(bulletText, keywords);
      }
    }
    
    return Array.from(keywords).filter(k => k.length > 2); // Filtrer les mots trop courts
  }

  private addWordsToKeywords(text: string, keywords: Set<string>) {
    // Nettoyer et extraire les mots
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !this.isStopWord(word));
    
    for (const word of words) {
      keywords.add(word);
    }
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'she', 'use', 'her', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'oil', 'sit', 'set'
    ]);
    return stopWords.has(word);
  }

  private getSkillFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .map(entry => entry.name)
        .filter(name => !name.startsWith('.'));
    } catch {
      return [];
    }
  }
}