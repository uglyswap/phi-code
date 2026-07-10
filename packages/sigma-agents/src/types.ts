export type TaskCategory = "code" | "debug" | "explore" | "plan" | "test" | "review" | "general";

export interface RoutingConfig {
	routes: Record<
		TaskCategory,
		{
			preferredModel: string;
			fallback: string;
			agent: string | null;
			keywords: string[];
		}
	>;
	default: { model: string; agent: string | null };
}
