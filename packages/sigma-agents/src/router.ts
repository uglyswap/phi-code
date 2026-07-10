import { readFile } from "node:fs/promises";
import type { RoutingConfig, TaskCategory } from "./types.js";

export class SmartRouter {
	private config: RoutingConfig;

	constructor(config: RoutingConfig) {
		this.config = config;
	}

	/**
	 * Analyse le prompt et retourne la catégorie de tâche.
	 *
	 * Scoring: whole-word keyword matches per category (naive plural folding,
	 * multi-word keywords match as substrings). Best score wins. Ties break by
	 * intent priority — categories whose keywords are strong action verbs
	 * (debug, test, explore, review) beat categories that also match on generic
	 * nouns like "code" or "structure" (code, plan):
	 * debug > test > explore > review > code > plan > general.
	 *
	 * Whole-word matching matters: the previous substring match classified
	 * "functionality" as code (contains "function") and "codebase" as code.
	 */
	classifyTask(prompt: string): TaskCategory {
		const lowerPrompt = prompt.toLowerCase();
		if (!this.config?.routes) {
			return "general";
		}

		// Tokenize into whole words, folding naive plurals ("tests" -> "test").
		const words = new Set<string>();
		for (const word of lowerPrompt.match(/[\p{L}\p{N}]+/gu) ?? []) {
			words.add(word);
			if (word.length > 3 && word.endsWith("s")) {
				words.add(word.slice(0, -1));
			}
		}

		const scores = new Map<TaskCategory, number>();
		for (const [category, route] of Object.entries(this.config.routes)) {
			if (!Array.isArray(route?.keywords)) continue;
			let score = 0;
			// Dedupe so a keyword listed twice in a config cannot double-count.
			for (const needle of new Set(route.keywords.map((k) => k.toLowerCase()))) {
				const matched = needle.includes(" ") ? lowerPrompt.includes(needle) : words.has(needle);
				if (matched) score++;
			}
			if (score > 0) {
				scores.set(category as TaskCategory, score);
			}
		}

		if (scores.size === 0) {
			return "general";
		}

		const priorityOrder: TaskCategory[] = ["debug", "test", "explore", "review", "code", "plan", "general"];
		let best: TaskCategory | undefined;
		let bestScore = 0;
		for (const [category, score] of scores) {
			if (
				score > bestScore ||
				(score === bestScore &&
					best !== undefined &&
					priorityOrder.indexOf(category) !== -1 &&
					priorityOrder.indexOf(category) < priorityOrder.indexOf(best))
			) {
				best = category;
				bestScore = score;
			}
		}

		return best ?? "general";
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
				category,
			};
		}

		return {
			model: route.preferredModel,
			agent: route.agent,
			category,
		};
	}

	/**
	 * Charge la configuration depuis un fichier JSON
	 */
	static async loadConfig(configPath: string): Promise<RoutingConfig> {
		try {
			const content = await readFile(configPath, "utf8");
			const parsed: unknown = JSON.parse(content);

			if (!SmartRouter.validateRoutingConfig(parsed)) {
				console.warn(`Invalid routing config structure in ${configPath}; falling back to defaults`);
				return SmartRouter.defaultConfig();
			}

			return parsed;
		} catch {
			// File doesn't exist yet — use defaults silently
			return SmartRouter.defaultConfig();
		}
	}

	/**
	 * Valide la structure d'une RoutingConfig chargée depuis un fichier non fiable.
	 * Fail-safe : retourne false sur toute incohérence structurelle.
	 */
	static validateRoutingConfig(config: unknown): config is RoutingConfig {
		if (typeof config !== "object" || config === null) {
			return false;
		}

		const candidate = config as Record<string, unknown>;

		const routes = candidate.routes;
		if (typeof routes !== "object" || routes === null) {
			return false;
		}

		for (const route of Object.values(routes as Record<string, unknown>)) {
			if (typeof route !== "object" || route === null) {
				return false;
			}
			const r = route as Record<string, unknown>;
			if (typeof r.preferredModel !== "string" || typeof r.fallback !== "string") {
				return false;
			}
			if (!(r.agent === null || typeof r.agent === "string")) {
				return false;
			}
			if (!Array.isArray(r.keywords) || !r.keywords.every((k) => typeof k === "string")) {
				return false;
			}
		}

		const defaults = candidate.default;
		if (typeof defaults !== "object" || defaults === null) {
			return false;
		}
		const d = defaults as Record<string, unknown>;
		if (typeof d.model !== "string") {
			return false;
		}
		if (!(d.agent === null || typeof d.agent === "string")) {
			return false;
		}

		return true;
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
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"code",
						"implement",
						"write",
						"create",
						"build",
						"développer",
						"coder",
						"programmer",
						"function",
						"class",
						"method",
					],
				},
				debug: {
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"debug",
						"fix",
						"error",
						"bug",
						"broken",
						"issue",
						"problem",
						"repair",
						"correct",
						"erreur",
						"problème",
						"réparer",
					],
				},
				explore: {
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"explore",
						"understand",
						"analyze",
						"examine",
						"investigate",
						"study",
						"explorer",
						"analyser",
						"comprendre",
					],
				},
				plan: {
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"plan",
						"design",
						"architecture",
						"strategy",
						"approach",
						"structure",
						"organize",
						"concevoir",
						"planifier",
					],
				},
				test: {
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"test",
						"testing",
						"unit",
						"integration",
						"verify",
						"validate",
						"check",
						"tester",
						"vérifier",
						"valider",
					],
				},
				review: {
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"review",
						"audit",
						"check",
						"validate",
						"quality",
						"improve",
						"optimize",
						"réviser",
						"améliorer",
						"optimiser",
					],
				},
				general: {
					preferredModel: "default",
					fallback: "default",
					agent: null,
					keywords: [
						"help",
						"explain",
						"what",
						"how",
						"why",
						"question",
						"aide",
						"expliquer",
						"comment",
						"pourquoi",
					],
				},
			},
			default: {
				model: "default",
				agent: null,
			},
		};
	}
}
