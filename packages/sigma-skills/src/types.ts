export interface Skill {
	name: string;
	description: string;
	content: string; // Contenu du SKILL.md
	path: string; // Chemin absolu
	keywords: string[]; // Keywords extracted from SKILL.md
	files: string[]; // Fichiers dans le dossier du skill
}

export interface SkillMatch {
	skill: Skill;
	matchedKeywords: string[];
	score: number;
}

export interface SkillsConfig {
	globalDir: string; // ~/.phi/agent/skills/
	projectDir: string; // .phi/skills/
	bundledDir: string; // Chemin vers skills/ dans le repo
	autoInject: boolean; // Auto-inject matched skill context
	/** Sources supplémentaires scannées entre projectDir et globalDir (ordre = priorité, first-wins). Ex: .claude/skills, .agents/skills, .codex/skills, .github/skills. */
	extraDirs?: string[];
	/** Répertoire des skills auto-appris (~/.phi/agent/managed-skills/), priorité minimale. */
	managedDir?: string;
	/** Noms de skills à ignorer (match exact ou glob simple avec *). */
	ignoredSkills?: string[];
}
