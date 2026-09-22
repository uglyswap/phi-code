/**
 * Authoritative upstream model metadata for a provider.
 *
 * Why this exists: the context window the footer, `/context`, `--list-models`
 * and auto-compaction use comes from the model object the runtime composes.
 * That composition upserts `models.json` entries ON TOP of the provider's
 * catalog by id (see applyModelsJson in coding-agent core), so a models.json
 * entry REPLACES the upstream definition of the same model — including its
 * `contextWindow` and `maxTokens`. Persisting a model that upstream already
 * publishes therefore silently rewrites its window with an inferred guess
 * (a 1M model showing "/200k", auto-compacting five times too early).
 *
 * The rule this module supports: only persist into models.json what upstream
 * does not publish. "Upstream" is the same two layers the runtime composes
 * before models.json:
 *   1. the bundled static catalog (phi-code-ai, `getModels`), and
 *   2. the pi.dev catalog overlay (GET /api/models/providers/<id>), which the
 *      runtime persists to ~/.phi/agent/models-store.json.
 *
 * A model id that no provider-specific catalog knows is still looked up across
 * every catalog pi.dev publishes (ids are global model identifiers): OpenCode
 * Zen lists models before its own catalog catches up, and the same id is often
 * already described for another provider.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBuiltinModelDataGeneratedAt } from "phi-code-ai/providers/all";
import { getModels } from "phi-code-ai/compat";

export const UPSTREAM_CATALOG_BASE_URL = "https://pi.dev";

/** Same revalidation window the runtime applies to the persisted overlay. */
const OVERLAY_FRESH_MS = 4 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Provider ids pi.dev publishes catalogs for. Used only as the cross-provider
 * index for models no provider-specific catalog resolved.
 */
export const UPSTREAM_CATALOG_PROVIDERS: readonly string[] = [
	"opencode",
	"opencode-go",
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"groq",
	"mistral",
	"deepseek",
	"xai",
];

export interface UpstreamModel {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface UpstreamOptions {
	/** Path of models.json; the runtime's overlay lives next to it. */
	modelsJsonPath: string;
	timeoutMs?: number;
	/** Skip network access entirely (PHI_OFFLINE / --offline). */
	offline?: boolean;
	/** Ignore the in-process cache (used by `/models refresh`). */
	force?: boolean;
}

/** Per-process fetch cache; failures are cached as `undefined` to avoid retry storms. */
const fetchCache = new Map<string, UpstreamModel[] | undefined>();

/** Path of the runtime's persisted catalog overlay. */
export function overlayCatalogPath(modelsJsonPath: string): string {
	return join(dirname(modelsJsonPath), "models-store.json");
}

/**
 * The runtime only overlays a catalog whose `lastModified` is newer than the
 * bundled catalog snapshot (see withRemoteCatalog) — an older remote body is
 * discarded in favor of the bundled definitions. Mirrored here so a model is
 * only ever treated as upstream-known when the runtime really composes that
 * definition; otherwise its models.json delta must stay, or the model would
 * vanish from the picker.
 */
function overlayApplies(lastModified: number | undefined): boolean {
	const generatedAt = getBuiltinModelDataGeneratedAt();
	if (generatedAt === undefined) return true;
	return lastModified !== undefined && lastModified > generatedAt;
}

/** True when this run must not touch the network (PHI_OFFLINE / --offline). */
export function offlineMode(): boolean {
	return process.env.PHI_OFFLINE !== undefined || process.env.PI_OFFLINE !== undefined;
}

/** Bundled (models.generated.ts) model ids for a provider. */
function bundledModelIds(providerId: string): Set<string> {
	try {
		const models = getModels(providerId as Parameters<typeof getModels>[0]) as Array<{ id: string }>;
		return new Set(models.map((m) => m.id));
	} catch {
		return new Set();
	}
}

/**
 * Every model id the runtime composes for a provider before models.json is
 * applied: the bundled static catalog plus the pi.dev overlay. A models.json
 * entry for one of these replaces that upstream definition instead of adding
 * to it — see the module docs.
 */
export async function upstreamKnownIds(providerId: string, options: UpstreamOptions): Promise<Set<string>> {
	const ids = bundledModelIds(providerId);
	for (const model of await loadUpstreamCatalog(providerId, options)) ids.add(model.id);
	return ids;
}

function toModels(entries: unknown): UpstreamModel[] {
	if (!Array.isArray(entries)) return [];
	const models: UpstreamModel[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { id?: unknown; contextWindow?: unknown; maxTokens?: unknown };
		if (typeof record.id !== "string" || record.id.length === 0) continue;
		const contextWindow =
			typeof record.contextWindow === "number" && record.contextWindow > 0 ? record.contextWindow : undefined;
		const maxTokens = typeof record.maxTokens === "number" && record.maxTokens > 0 ? record.maxTokens : undefined;
		if (contextWindow === undefined && maxTokens === undefined) continue;
		models.push({ id: record.id, contextWindow, maxTokens });
	}
	return models;
}

/** Parsed pi.dev catalog body: an id-keyed object, `{ models: [...] }`, or an array. */
function parseCatalog(body: unknown): UpstreamModel[] {
	if (Array.isArray(body)) return toModels(body);
	if (typeof body !== "object" || body === null) return [];
	if ("models" in body) return toModels((body as { models?: unknown }).models);
	return toModels(
		Object.entries(body as Record<string, unknown>).map(([id, value]) =>
			typeof value === "object" && value !== null ? { id, ...(value as object) } : { id },
		),
	);
}

/**
 * The runtime's persisted overlay for one provider plus how old it is. Ages are
 * tracked from `checkedAt`, the same stamp the runtime revalidates against.
 */
export function readOverlayCatalog(
	providerId: string,
	modelsJsonPath: string,
): { models: UpstreamModel[]; ageMs: number | undefined } {
	try {
		const raw = JSON.parse(readFileSync(overlayCatalogPath(modelsJsonPath), "utf-8")) as Record<
			string,
			{ models?: unknown; checkedAt?: unknown; lastModified?: unknown }
		>;
		const entry = raw?.[providerId];
		const checkedAt = entry?.checkedAt;
		const lastModified = typeof entry?.lastModified === "number" ? entry.lastModified : undefined;
		return {
			models: overlayApplies(lastModified) ? toModels(entry?.models) : [],
			ageMs: typeof checkedAt === "number" && checkedAt > 0 ? Date.now() - checkedAt : undefined,
		};
	} catch {
		return { models: [], ageMs: undefined };
	}
}

/**
 * Live catalog for one provider. Empty when unreachable, unpublished (pi.dev
 * answers 404 for providers it has no catalog for), or older than the bundled
 * snapshot the runtime would keep instead.
 */
export async function fetchUpstreamCatalog(
	providerId: string,
	options: Omit<UpstreamOptions, "modelsJsonPath"> = {},
): Promise<UpstreamModel[] | undefined> {
	if (!options.force && fetchCache.has(providerId)) return fetchCache.get(providerId);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	let result: UpstreamModel[] | undefined;
	try {
		const response = await fetch(
			`${UPSTREAM_CATALOG_BASE_URL}/api/models/providers/${encodeURIComponent(providerId)}`,
			{ signal: controller.signal, headers: { accept: "application/json", "user-agent": "phi-code" } },
		);
		if (response.ok) {
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			const body = await response.json();
			result = overlayApplies(Number.isNaN(lastModified) ? undefined : lastModified)
				? parseCatalog(body)
				: [];
		}
	} catch {
		// offline / timeout / malformed body — callers fall back to the overlay
	} finally {
		clearTimeout(timer);
	}
	fetchCache.set(providerId, result);
	return result;
}

/**
 * Upstream metadata for a provider: the fresh overlay while it is still inside
 * the runtime's revalidation window, otherwise the live pi.dev catalog merged
 * over the overlay, so a stale cache still covers what it knows.
 */
export async function loadUpstreamCatalog(
	providerId: string,
	options: UpstreamOptions,
): Promise<UpstreamModel[]> {
	const overlay = readOverlayCatalog(providerId, options.modelsJsonPath);
	if (
		!options.force &&
		overlay.models.length > 0 &&
		overlay.ageMs !== undefined &&
		overlay.ageMs < OVERLAY_FRESH_MS
	) {
		return overlay.models;
	}
	if (options.offline) return overlay.models;

	const live = await fetchUpstreamCatalog(providerId, options);
	if (!live || live.length === 0) return overlay.models;

	const merged = new Map(overlay.models.map((model) => [model.id, model] as const));
	for (const model of live) {
		const existing = merged.get(model.id);
		merged.set(model.id, existing ? { ...existing, ...model } : model);
	}
	return [...merged.values()];
}

/**
 * Window and maxTokens for ids no provider-specific catalog resolved, looked up
 * across every catalog pi.dev publishes.
 */
export async function resolveUpstreamById(
	ids: ReadonlySet<string>,
	excludeProviderIds: readonly string[],
	options: UpstreamOptions,
): Promise<Map<string, UpstreamModel>> {
	const resolved = new Map<string, UpstreamModel>();
	if (ids.size === 0) return resolved;

	const excluded = new Set(excludeProviderIds);
	const catalogs = await Promise.all(
		UPSTREAM_CATALOG_PROVIDERS.filter((providerId) => !excluded.has(providerId)).map((providerId) =>
			loadUpstreamCatalog(providerId, options),
		),
	);

	for (const models of catalogs) {
		for (const model of models) {
			if (resolved.has(model.id) || !ids.has(model.id)) continue;
			resolved.set(model.id, model);
		}
	}
	return resolved;
}
