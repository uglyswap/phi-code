import { SubAgentConfig } from './types';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class SubAgentManager {
  private agents: Map<string, SubAgentConfig> = new Map();

  /**
   * Charge les définitions d'agents depuis un répertoire
   * Les fichiers .md doivent avoir un frontmatter YAML
   */
  async loadAgentDefinitions(agentsDir: string): Promise<void> {
    try {
      const files = await readdir(agentsDir);
      const mdFiles = files.filter(file => file.endsWith('.md'));

      this.agents.clear();

      for (const file of mdFiles) {
        try {
          const filePath = join(agentsDir, file);
          const content = await readFile(filePath, 'utf8');
          const agent = this.parseAgentMarkdown(content);
          
          if (agent) {
            this.agents.set(agent.name, agent);
          }
        } catch (error) {
          console.warn(`Could not parse agent file ${file}:`, error);
        }
      }
    } catch (error) {
      console.warn(`Could not load agent definitions from ${agentsDir}:`, error);
    }
  }

  /**
   * Retourne la liste des agents disponibles
   */
  getAvailableAgents(): SubAgentConfig[] {
    return Array.from(this.agents.values());
  }

  /**
   * Construit la commande CLI pour spawner un sous-agent phi
   */
  createCommand(agent: SubAgentConfig, task: string): string[] {
    return [
      'phi',
      '--print',
      '--model',
      agent.model,
      '--no-session',
      '--system-prompt',
      agent.systemPrompt,
      task
    ];
  }

  /**
   * Parse un fichier markdown avec frontmatter YAML
   * Format attendu :
   * ---
   * name: agent-name
   * description: Agent description
   * model: model-name
   * tools: [tool1, tool2]
   * maxTokens: 4096
   * ---
   * 
   * # System Prompt
   * 
   * Le contenu après le frontmatter devient le system prompt...
   */
  parseAgentMarkdown(content: string): SubAgentConfig | null {
    const lines = content.split('\n');
    
    if (!lines[0]?.startsWith('---')) {
      return null;
    }

    // Trouver la fin du frontmatter
    let frontmatterEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        frontmatterEnd = i;
        break;
      }
    }

    if (frontmatterEnd === -1) {
      return null;
    }

    // Extraire et parser le frontmatter YAML
    const frontmatterLines = lines.slice(1, frontmatterEnd);
    const frontmatter: any = {};

    for (const line of frontmatterLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      const valueStr = trimmed.substring(colonIndex + 1).trim();

      // Parser la valeur
      let value: any = valueStr;

      // Arrays (format: [item1, item2])
      if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
        const arrayContent = valueStr.slice(1, -1);
        value = arrayContent.split(',').map(item => item.trim().replace(/['"]/g, ''));
      }
      // Numbers
      else if (/^\d+$/.test(valueStr)) {
        value = parseInt(valueStr, 10);
      }
      // Remove quotes from strings
      else if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
               (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
        value = valueStr.slice(1, -1);
      }

      frontmatter[key] = value;
    }

    // Extraire le system prompt (contenu après le frontmatter)
    const systemPromptLines = lines.slice(frontmatterEnd + 1);
    const systemPrompt = systemPromptLines.join('\n').trim();

    // Valider les champs requis
    if (!frontmatter.name || !frontmatter.model || !systemPrompt) {
      return null;
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description || '',
      model: frontmatter.model,
      tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
      systemPrompt,
      maxTokens: frontmatter.maxTokens || undefined
    };
  }

  /**
   * Récupère un agent par son nom
   */
  getAgent(name: string): SubAgentConfig | null {
    return this.agents.get(name) || null;
  }

  /**
   * Vérifie si un agent existe
   */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }
}