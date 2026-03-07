import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillMatch, SkillsConfig } from './types.js';
import { SkillScanner } from './scanner.js';

export class SkillLoader {
  private scanner: SkillScanner;
  private skills: Skill[] = [];
  private lastScanTime: number = 0;
  private readonly SCAN_CACHE_MS = 60000; // Cache les scans pendant 1 minute

  constructor(scanner: SkillScanner) {
    this.scanner = scanner;
    this.refreshSkills();
  }

  /**
   * Cherche les skills pertinents pour un prompt donné
   */
  findRelevantSkills(prompt: string): SkillMatch[] {
    this.refreshSkillsIfNeeded();
    
    const promptWords = this.extractWords(prompt.toLowerCase());
    const matches: SkillMatch[] = [];

    for (const skill of this.skills) {
      const matchedKeywords: string[] = [];
      let score = 0;

      // Check keyword matches for this skill
      for (const keyword of skill.keywords) {
        if (promptWords.includes(keyword)) {
          matchedKeywords.push(keyword);
          score += 1;
        }
      }

      // Bonus pour les correspondances dans le nom ou la description
      const skillName = skill.name.toLowerCase();
      const skillDesc = skill.description.toLowerCase();
      
      for (const word of promptWords) {
        if (skillName.includes(word)) {
          score += 2; // Bonus pour le nom
        }
        if (skillDesc.includes(word)) {
          score += 1; // Bonus pour la description
        }
      }

      // Ajouter si pertinent
      if (score > 0) {
        matches.push({
          skill,
          matchedKeywords,
          score
        });
      }
    }

    // Sort by score descending
    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Retourne le contenu d'un skill par nom
   */
  getSkillContext(skillName: string): string | null {
    this.refreshSkillsIfNeeded();
    
    const skill = this.skills.find(s => s.name === skillName);
    return skill ? skill.content : null;
  }

  /**
   * Liste tous les skills installés
   */
  listSkills(): Skill[] {
    this.refreshSkillsIfNeeded();
    return [...this.skills]; // Retourner une copie
  }

  /**
   * Copie un skill d'un chemin source vers le répertoire skills
   */
  installSkill(source: string, targetDir?: string): boolean {
    try {
      // Determine target directory (default: globalDir)
      const targetBase = targetDir || this.scanner['config'].globalDir;
      const skillName = path.basename(source);
      const targetPath = path.join(targetBase, skillName);

      // Verify source exists
      if (!fs.existsSync(source)) {
        return false; // Source directory not found
        return false;
      }

      // Verify SKILL.md exists in source
      const sourceSkillMd = path.join(source, 'SKILL.md');
      if (!fs.existsSync(sourceSkillMd)) {
        return false; // No SKILL.md in source
        return false;
      }

      // Create target directory if needed
      fs.mkdirSync(targetBase, { recursive: true });

      // Copy recursively
      this.copyDirectory(source, targetPath);

      // Refresh skills list
      this.forceRefresh();

      console.log(`Skill '${skillName}' installed successfully to ${targetPath}`);
      return true;
    } catch (error) {
      // Skill installation failed
      return false;
    }
  }

  private refreshSkillsIfNeeded() {
    const now = Date.now();
    if (now - this.lastScanTime > this.SCAN_CACHE_MS) {
      this.refreshSkills();
    }
  }

  private refreshSkills() {
    this.skills = this.scanner.scan();
    this.lastScanTime = Date.now();
  }

  private forceRefresh() {
    this.lastScanTime = 0;
    this.refreshSkills();
  }

  private extractWords(text: string): string[] {
    return text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2)
      .map(word => word.toLowerCase());
  }

  private copyDirectory(source: string, target: string) {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
}