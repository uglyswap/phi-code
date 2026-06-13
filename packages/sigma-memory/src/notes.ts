import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import type { MemoryConfig, Note } from "./types.js";

export class NotesManager {
	private config: MemoryConfig;
	private notesDir: string;

	constructor(config: MemoryConfig) {
		this.config = config;
		this.notesDir = join(config.memoryDir, "notes");
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
	 * Résout un nom de fichier note en chemin absolu en garantissant qu'il
	 * reste à l'intérieur du dossier notes (protection anti path traversal).
	 */
	private resolveNotePath(filename: string): string {
		const base = resolve(this.notesDir);
		const target = resolve(base, filename);
		if (target !== base && !target.startsWith(base + sep)) {
			throw new Error(`Invalid note filename (path traversal blocked): ${filename}`);
		}
		return target;
	}

	/**
	 * Écrit dans un fichier .md (date du jour si pas de nom).
	 *
	 * Par défaut (overwrite=false) on NE remplace JAMAIS un fichier existant :
	 * un suffixe numérique unique (-2, -3, ...) est ajouté pour éviter la perte
	 * de données (clobber même-jour). Passer overwrite=true pour forcer le
	 * remplacement total de l'ancien comportement.
	 *
	 * Retourne le nom de fichier réellement écrit (utile quand un suffixe a été
	 * généré) pour que l'appelant indexe le bon nom.
	 */
	write(content: string, filename?: string, overwrite = false): string {
		const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
		const file = filename || `${today}.md`;

		// Resolve once up-front to validate against path traversal before any
		// candidate-name probing on disk.
		this.resolveNotePath(file);

		let finalName = file;
		if (!overwrite && existsSync(this.resolveNotePath(file))) {
			// Find a unique "-N" suffixed name so we never clobber existing data.
			const dotIndex = file.lastIndexOf(".");
			const stem = dotIndex > 0 ? file.slice(0, dotIndex) : file;
			const ext = dotIndex > 0 ? file.slice(dotIndex) : "";
			let counter = 2;
			let candidate = `${stem}-${counter}${ext}`;
			while (existsSync(this.resolveNotePath(candidate))) {
				counter += 1;
				candidate = `${stem}-${counter}${ext}`;
			}
			finalName = candidate;
		}

		const filePath = this.resolveNotePath(finalName);
		writeFileSync(filePath, content, "utf8");
		return finalName;
	}

	/**
	 * Lit un fichier
	 */
	read(filename: string): string {
		const filePath = this.resolveNotePath(filename);
		if (!existsSync(filePath)) {
			throw new Error(`File not found: ${filename}`);
		}
		return readFileSync(filePath, "utf8");
	}

	/**
	 * Liste tous les fichiers .md avec leur taille et date
	 */
	list(): Array<{ name: string; size: number; date: string }> {
		if (!existsSync(this.notesDir)) {
			return [];
		}

		return readdirSync(this.notesDir)
			.filter((file) => file.endsWith(".md"))
			.map((file) => {
				const filePath = this.resolveNotePath(file);
				const stats = statSync(filePath);
				return {
					name: file,
					size: stats.size,
					date: stats.mtime.toISOString(),
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

		// Recherche full-text en JS pur : aucun shell, donc aucune injection de
		// commande possible, et fonctionne sur toutes les plateformes (y compris
		// Windows, qui n'a ni grep ni la syntaxe 2>/dev/null || true).
		const needle = query.toLowerCase();
		const files = readdirSync(this.notesDir).filter((f) => f.endsWith(".md"));
		for (const file of files) {
			const filePath = join(this.notesDir, file);
			const content = readFileSync(filePath, "utf8");
			content.split("\n").forEach((line, index) => {
				if (line.toLowerCase().includes(needle)) {
					results.push({
						file,
						line: index + 1,
						content: line.trim(),
					});
				}
			});
		}

		return results;
	}

	/**
	 * Retourne les notes des N derniers jours
	 */
	getRecent(days: number): Note[] {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - days);

		const files = this.list().filter((file) => {
			const fileDate = new Date(file.date);
			return fileDate >= cutoffDate;
		});

		return files.map((file) => {
			const content = this.read(file.name);
			return {
				file: file.name,
				date: file.date,
				content,
			};
		});
	}

	/**
	 * Ajoute à un fichier existant
	 */
	append(content: string, filename?: string): void {
		const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
		const file = filename || `${today}.md`;
		const filePath = this.resolveNotePath(file);

		// Add blank line if file exists and doesn't end with one
		if (existsSync(filePath)) {
			const existingContent = readFileSync(filePath, "utf8");
			const separator = existingContent.endsWith("\n") ? "" : "\n";
			appendFileSync(filePath, separator + content, "utf8");
		} else {
			writeFileSync(filePath, content, "utf8");
		}
	}
}
