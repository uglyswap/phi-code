import { readFile, writeFile } from "node:fs/promises";
import type { ModelProfile, TaskCategory } from "./types.js";

export class ModelProfiler {
	public profiles: Map<string, ModelProfile> = new Map();

	/**
	 * Charge les profiles depuis un fichier JSON
	 */
	async loadFromFile(path: string): Promise<void> {
		try {
			const content = await readFile(path, "utf8");
			const data = JSON.parse(content);

			if (Array.isArray(data.profiles)) {
				this.profiles.clear();
				for (const profile of data.profiles) {
					if (!ModelProfiler.isValidProfile(profile)) {
						console.warn("Skipping invalid profile entry");
						continue;
					}
					this.profiles.set(profile.id, profile);
				}
			}
		} catch (error) {
			// Missing file is nominal: fall back to defaults silently.
			// Only warn on real read/parse errors.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Could not load profiles from ${path}:`, error);
			}
			this.loadDefaultProfiles();
		}
	}

	/**
	 * Sauvegarde les profiles vers un fichier JSON
	 */
	async saveToFile(path: string): Promise<void> {
		const data = {
			profiles: Array.from(this.profiles.values()),
		};

		await writeFile(path, JSON.stringify(data, null, 2), "utf8");
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
			.filter((profile) => profile.strengths.includes(category))
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
	 * Valide la forme d'un profile chargé depuis un JSON non fiable.
	 * Empêche les entrées sans id (qui s'écraseraient sous la clé undefined)
	 * et les champs malformés qui feraient planter getBestForTask.
	 */
	static isValidProfile(profile: unknown): profile is ModelProfile {
		if (typeof profile !== "object" || profile === null) {
			return false;
		}

		const p = profile as Record<string, unknown>;

		if (typeof p.id !== "string" || p.id.length === 0) {
			return false;
		}
		if (typeof p.provider !== "string") {
			return false;
		}
		if (p.speed !== "fast" && p.speed !== "medium" && p.speed !== "slow") {
			return false;
		}
		if (p.quality !== "high" && p.quality !== "medium" && p.quality !== "low") {
			return false;
		}
		if (!Array.isArray(p.strengths) || !p.strengths.every((s) => typeof s === "string")) {
			return false;
		}
		if (typeof p.maxTokens !== "number" || typeof p.supportsTools !== "boolean") {
			return false;
		}

		return true;
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
