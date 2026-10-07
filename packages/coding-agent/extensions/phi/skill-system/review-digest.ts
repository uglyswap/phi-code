/**
 * Review digest builder (plan §C4.4).
 *
 * The full transcript is too expensive, so the fork receives a bounded digest:
 * loaded skills, available index, user corrections, failure/recovery pairs and
 * the last messages. Truncation order is fixed (recent exchanges first, then
 * failures) and secrets are masked BEFORE anything is written to disk.
 */

export interface DigestSkillInfo {
	name: string;
	description: string;
}

export interface DigestInput {
	/** Session branch entries (shape-tolerant: we only read message entries). */
	branch: Iterable<unknown>;
	loadedSkills: readonly string[];
	availableSkills: readonly DigestSkillInfo[];
	maxChars: number;
}

interface ExtractedMessage {
	role: string;
	text: string;
	toolName?: string;
	isError?: boolean;
}

const CORRECTION_MARKERS = [
	"stop",
	"non,",
	"pas comme ça",
	"toujours",
	"jamais",
	"je préfère",
	"trop verbeux",
	"trop long",
	"corrige",
	"arrête",
	"don't",
	"do not",
	"not like this",
];

const SECRET_PATTERNS: RegExp[] = [
	/sk-[A-Za-z0-9_-]{10,}/g,
	/ghp_[A-Za-z0-9]{20,}/g,
	/AKIA[0-9A-Z]{16}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

export function maskSecrets(text: string): string {
	let masked = text;
	for (const pattern of SECRET_PATTERNS) masked = masked.replace(pattern, "«redacted»");
	return masked;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

function extractMessages(branch: Iterable<unknown>): ExtractedMessage[] {
	const messages: ExtractedMessage[] = [];
	for (const entry of branch) {
		const e = entry as { type?: string; message?: Record<string, unknown> };
		if (e.type !== "message" || !e.message) continue;
		const role = typeof e.message.role === "string" ? e.message.role : undefined;
		if (!role) continue;
		if (role === "toolResult") {
			messages.push({
				role,
				toolName: typeof e.message.toolName === "string" ? e.message.toolName : undefined,
				isError: e.message.isError === true,
				text: contentToText(e.message.content),
			});
			continue;
		}
		messages.push({ role, text: contentToText(e.message.content) });
	}
	return messages;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}… [truncated]`;
}

function buildSections(
	messages: ExtractedMessage[],
	input: DigestInput,
): { header: string; corrections: string; failures: string; recent: string } {
	const loaded = input.loadedSkills.length > 0 ? input.loadedSkills.map((name) => `- ${name}`).join("\n") : "- (none)";
	const available =
		input.availableSkills.length > 0
			? input.availableSkills.map((skill) => `- ${skill.name} — ${truncate(skill.description, 80)}`).join("\n")
			: "- (none)";
	const header = ["=== SKILLS CHARGÉES CE TOUR ===", loaded, "", "=== SKILLS DISPONIBLES (index) ===", available].join(
		"\n",
	);

	const corrections: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const lowered = message.text.toLowerCase();
		if (!CORRECTION_MARKERS.some((marker) => lowered.includes(marker))) continue;
		corrections.push(`- ${truncate(message.text.trim(), 200)}`);
		if (corrections.length >= 10) break;
	}
	const correctionsSection =
		corrections.length > 0
			? `=== CORRECTIONS UTILISATEUR ===\n${corrections.join("\n")}`
			: "=== CORRECTIONS UTILISATEUR ===\n(aucune)";

	const failurePairs: string[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult" || !message.isError) continue;
		let recovery = "(pas de récupération observée)";
		for (let next = index + 1; next < messages.length; next++) {
			const candidate = messages[next];
			if (candidate.role === "toolResult" && candidate.toolName === message.toolName && !candidate.isError) {
				recovery = `récupéré via ${candidate.toolName}: ${truncate(candidate.text, 200)}`;
				break;
			}
		}
		failurePairs.push(`- ${message.toolName ?? "tool"} a échoué: ${truncate(message.text, 400)}\n  ${recovery}`);
		if (failurePairs.length >= 15) break;
	}
	const failuresSection =
		failurePairs.length > 0
			? `=== ÉCHECS ET RÉCUPÉRATIONS ===\n${failurePairs.join("\n")}`
			: "=== ÉCHECS ET RÉCUPÉRATIONS ===\n(aucun)";

	const recent = messages
		.slice(-24)
		.map(
			(message) =>
				`${message.role}${message.toolName ? `(${message.toolName})` : ""}: ${truncate(message.text, 2000)}`,
		)
		.join("\n\n");
	return {
		header,
		corrections: correctionsSection,
		failures: failuresSection,
		recent: `=== DERNIERS ÉCHANGES ===\n${recent}`,
	};
}

export function buildReviewDigest(input: DigestInput): string {
	const messages = extractMessages(input.branch);
	const { header, corrections, failures, recent } = buildSections(messages, input);
	const assemble = (correctionsText: string, failureText: string, recentText: string): string =>
		[header, correctionsText, failureText, recentText].filter((part) => part !== "").join("\n\n");
	let result = assemble(corrections, failures, recent);
	if (result.length <= input.maxChars) return maskSecrets(result);
	// 1) Shrink the recent exchanges first (the cheapest section to lose).
	const overflow = result.length - input.maxChars;
	let recentText = truncate(recent, Math.max(0, recent.length - overflow));
	result = assemble(corrections, failures, recentText);
	if (result.length <= input.maxChars) return maskSecrets(result);
	// 2) Drop the failures section entirely.
	recentText = recent;
	result = assemble(corrections, "", recentText);
	if (result.length <= input.maxChars) return maskSecrets(result);
	// 3) Last resort: hard cut.
	return maskSecrets(result.slice(0, input.maxChars));
}
