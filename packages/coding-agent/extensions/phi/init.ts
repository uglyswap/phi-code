/**
 * Phi Init Extension - Interactive setup wizard for Phi Code
 *
 * Provides an interactive wizard to configure Phi Code with:
 * - API key detection and model discovery
 * - Intelligent model routing configuration
 * - Agent definitions setup
 * - Extension activation
 *
 * Features:
 * - /phi-init command for setup wizard
 * - Auto-detects available API keys
 * - Three setup modes: auto, benchmark, manual
 * - Creates ~/.phi/agent/ configuration structure
 * - Activates Phi Code extensions
 *
 * Usage:
 * 1. Run /phi-init to start the wizard
 * 2. Follow interactive prompts
 * 3. Configuration saved to ~/.phi/agent/
 */

import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, readFile, access, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface DetectedProvider {
  name: string;
  envVar: string;
  models: string[];
  available: boolean;
}

interface ModelConfig {
  id: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
}

interface RoutingConfigData {
  routes: Record<string, {
    preferredModel: string;
    fallback: string;
    agent: string | null;
    keywords: string[];
  }>;
  default: { model: string; agent: string | null };
}

export default function initExtension(pi: ExtensionAPI) {
  const phiAgentDir = join(homedir(), ".phi", "agent");
  const routingConfigPath = join(phiAgentDir, "routing.json");
  const modelsConfigPath = join(phiAgentDir, "models.json");
  const agentsDir = join(phiAgentDir, "agents");
  const extensionsDir = join(phiAgentDir, "extensions");

  /**
   * Détecte les clés API disponibles dans l'environnement
   */
  function detectProviders(): DetectedProvider[] {
    const providers: DetectedProvider[] = [
      {
        name: "Alibaba DashScope",
        envVar: "DASHSCOPE_API_KEY",
        models: [
          "qwen3.5-plus",
          "qwen3-max-2026-01-23", 
          "qwen3-coder-plus",
          "qwen3-coder-next",
          "kimi-k2.5",
          "glm-5",
          "glm-4.7",
          "MiniMax-M2.5"
        ],
        available: false
      },
      {
        name: "OpenAI",
        envVar: "OPENAI_API_KEY", 
        models: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "gpt-4o"],
        available: false
      },
      {
        name: "Anthropic",
        envVar: "ANTHROPIC_API_KEY",
        models: ["claude-3.5-sonnet", "claude-3-opus", "claude-3-haiku"],
        available: false
      },
      {
        name: "Google",
        envVar: "GOOGLE_API_KEY",
        models: ["gemini-pro", "gemini-pro-vision"],
        available: false
      }
    ];

    // Vérifier la disponibilité des clés API
    for (const provider of providers) {
      provider.available = !!process.env[provider.envVar];
    }

    return providers;
  }

  /**
   * Crée la configuration par défaut (mode auto)
   */
  function createAutoConfig(availableProviders: DetectedProvider[]): { routing: RoutingConfigData; models: ModelConfig[] } {
    // Priorité: Alibaba (gratuit) > Anthropic > OpenAI > Google
    const preferenceOrder = ["Alibaba DashScope", "Anthropic", "OpenAI", "Google"];
    
    let primaryProvider: DetectedProvider | null = null;
    
    for (const providerName of preferenceOrder) {
      const provider = availableProviders.find(p => p.name === providerName && p.available);
      if (provider) {
        primaryProvider = provider;
        break;
      }
    }

    if (!primaryProvider) {
      throw new Error("Aucun provider disponible détecté");
    }

    const models: ModelConfig[] = primaryProvider.models.map(modelId => ({
      id: modelId,
      provider: primaryProvider!.name,
      apiKey: process.env[primaryProvider!.envVar]
    }));

    const routing: RoutingConfigData = {
      routes: {
        code: {
          preferredModel: primaryProvider.models.find(m => m.includes("coder")) || primaryProvider.models[0],
          fallback: primaryProvider.models[0],
          agent: null,
          keywords: ["code", "implement", "write", "create", "build", "develop", "function", "class"]
        },
        debug: {
          preferredModel: primaryProvider.models[0],
          fallback: primaryProvider.models[1] || primaryProvider.models[0],
          agent: null,
          keywords: ["debug", "fix", "error", "bug", "broken", "issue", "problem", "repair"]
        },
        plan: {
          preferredModel: primaryProvider.models.find(m => m.includes("max")) || primaryProvider.models[0],
          fallback: primaryProvider.models[0],
          agent: null,
          keywords: ["plan", "design", "architecture", "strategy", "structure", "organize"]
        },
        review: {
          preferredModel: primaryProvider.models[0],
          fallback: primaryProvider.models[1] || primaryProvider.models[0],
          agent: null,
          keywords: ["review", "audit", "check", "validate", "quality", "improve", "optimize"]
        },
        test: {
          preferredModel: primaryProvider.models.find(m => m.includes("fast")) || primaryProvider.models[0],
          fallback: primaryProvider.models[0],
          agent: null,
          keywords: ["test", "testing", "unit", "integration", "verify", "validate"]
        },
        explore: {
          preferredModel: primaryProvider.models.find(m => m.includes("fast")) || primaryProvider.models[0],
          fallback: primaryProvider.models[0],
          agent: null,
          keywords: ["explore", "understand", "analyze", "examine", "investigate"]
        },
        general: {
          preferredModel: primaryProvider.models[0],
          fallback: primaryProvider.models[1] || primaryProvider.models[0],
          agent: null,
          keywords: ["help", "explain", "what", "how", "why", "question"]
        }
      },
      default: {
        model: primaryProvider.models[0],
        agent: null
      }
    };

    return { routing, models };
  }

  /**
   * Crée les répertoires nécessaires
   */
  async function ensureDirectories(): Promise<void> {
    await mkdir(phiAgentDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await mkdir(extensionsDir, { recursive: true });
  }

  /**
   * Copie les définitions d'agents par défaut
   */
  async function copyDefaultAgents(): Promise<void> {
    // Pour l'instant, nous créons un agent par défaut simple
    const defaultAgent = `---
name: general-assistant
description: General purpose assistant for various tasks
model: qwen3.5-plus
tools: [read, write, exec, web_search]
maxTokens: 4096
---

# General Assistant

You are a helpful AI assistant capable of handling various tasks including:

- Code analysis and debugging
- File operations
- Web searches
- General problem solving

Always be precise, helpful, and follow instructions carefully.
`;

    await writeFile(join(agentsDir, "general-assistant.md"), defaultAgent, "utf8");
  }

  /**
   * Active les extensions Phi Code
   */
  async function activateExtensions(): Promise<void> {
    const extensionConfig = {
      enabled: true,
      extensions: [
        "phi/memory",
        "phi/benchmark", 
        "phi/smart-router",
        "phi/skill-loader",
        "phi/web-search",
        "phi/orchestrator"
      ]
    };

    await writeFile(
      join(extensionsDir, "config.json"),
      JSON.stringify(extensionConfig, null, 2),
      "utf8"
    );
  }

  /**
   * Wizard interactif
   */
  pi.registerCommand("phi-init", {
    description: "Initialize Phi Code with interactive wizard",
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify("🚀 Welcome to Phi Code Setup Wizard!", "info");

        // 1. Détection des API keys
        ctx.ui.notify("🔍 Detecting available API keys...", "info");
        const providers = detectProviders();
        const availableProviders = providers.filter(p => p.available);

        if (availableProviders.length === 0) {
          ctx.ui.notify("❌ No API keys detected. Please set one of the following environment variables:\n" +
            providers.map(p => `- ${p.envVar} (for ${p.name})`).join("\n"), "error");
          return;
        }

        ctx.ui.notify("✅ Found API keys for:", "info");
        for (const provider of availableProviders) {
          ctx.ui.notify(`  - ${provider.name} (${provider.models.length} models)`, "info");
        }

        // 2. Choix du mode de configuration
        const mode = await ctx.ui.input("Choose setup mode:\n" +
          "1. auto - Use public rankings to assign models (fastest)\n" +
          "2. benchmark - Test models with simple exercises (recommended)\n" +
          "3. manual - Choose models yourself (most control)\n" +
          "\nEnter mode (1-3 or auto/benchmark/manual):");

        const selectedMode = mode.toLowerCase().startsWith("1") || mode.toLowerCase().startsWith("a") ? "auto" :
                            mode.toLowerCase().startsWith("2") || mode.toLowerCase().startsWith("b") ? "benchmark" :
                            mode.toLowerCase().startsWith("3") || mode.toLowerCase().startsWith("m") ? "manual" : "auto";

        ctx.ui.notify(`📋 Selected mode: ${selectedMode}`, "info");

        let config: { routing: RoutingConfigData; models: ModelConfig[] };

        if (selectedMode === "auto") {
          config = createAutoConfig(availableProviders);
        } else {
          // Pour benchmark et manual, utilisons auto pour l'instant (à implémenter)
          ctx.ui.notify("⚠️  Benchmark and manual modes not yet implemented, using auto mode.", "info");
          config = createAutoConfig(availableProviders);
        }

        // 3. Créer les répertoires
        ctx.ui.notify("📁 Creating configuration directories...", "info");
        await ensureDirectories();

        // 4. Écrire les fichiers de configuration
        ctx.ui.notify("💾 Writing configuration files...", "info");
        await writeFile(routingConfigPath, JSON.stringify(config.routing, null, 2), "utf8");
        await writeFile(modelsConfigPath, JSON.stringify({ models: config.models }, null, 2), "utf8");

        // 5. Copier les agents par défaut
        ctx.ui.notify("🤖 Setting up default agents...", "info");
        await copyDefaultAgents();

        // 6. Activer les extensions
        ctx.ui.notify("🔌 Activating extensions...", "info");
        await activateExtensions();

        // 7. Confirmation finale
        const confirm = await ctx.ui.confirm("Setup complete! Would you like to see the configuration summary?");
        
        if (confirm) {
          ctx.ui.notify("📊 Configuration Summary:\n" +
            `- Models configured: ${config.models.length}\n` +
            `- Primary provider: ${availableProviders[0].name}\n` +
            `- Config location: ${phiAgentDir}\n` +
            `- Extensions activated: Yes\n` +
            `- Default agents: Created\n\n` +
            "🎉 Phi Code is ready to use! Try running 'phi --help' for available commands.", "info");
        }

      } catch (error) {
        ctx.ui.notify(`❌ Setup failed: ${error}`, "error");
      }
    }
  });
}