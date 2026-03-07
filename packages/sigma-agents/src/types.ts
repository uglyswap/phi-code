export type TaskCategory = 'code' | 'debug' | 'explore' | 'plan' | 'test' | 'review' | 'general';

export interface ModelProfile {
  id: string;
  provider: string;
  speed: 'fast' | 'medium' | 'slow';
  quality: 'high' | 'medium' | 'low';
  strengths: TaskCategory[];
  maxTokens: number;
  supportsTools: boolean;
}

export interface RoutingConfig {
  routes: Record<TaskCategory, {
    preferredModel: string;
    fallback: string;
    agent: string | null;
    keywords: string[];
  }>;
  default: { model: string; agent: string | null };
}

export interface SubAgentConfig {
  name: string;
  description: string;
  model: string;
  tools: string[];
  systemPrompt: string;
  maxTokens?: number;
}

export interface SubAgentResult {
  agentName: string;
  model: string;
  output: string;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error?: string;
}