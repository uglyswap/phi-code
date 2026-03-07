# Phi Code Extensions

This directory contains the official Phi Code extensions - a collection of TypeScript extensions that enhance the Pi coding agent with specialized capabilities. Each extension follows the Pi extension pattern (`export default function(pi: ExtensionAPI)`) and provides focused functionality for different aspects of AI-assisted development.

## Available Extensions

### 1. 🧠 Memory Extension (`memory.ts`)

Persistent memory management for conversations and context.

**Features:**
- `memory_search(query)` - Full-text search across memory files
- `memory_write(content, file?)` - Write to memory files (defaults to today's date)
- `memory_read(file?)` - Read specific files or list all available
- Auto-loads `AGENTS.md` on session start
- Creates memory directories automatically (`~/.phi/memory/`, `.phi/memory/`)

**Usage:**
```typescript
// The extension automatically provides these tools to the LLM
memory_search("previous bug fixes")
memory_write("Important lesson learned about React hooks", "react-notes.md")
memory_read("2024-03-07.md")
```

### 2. 🎯 Smart Router Extension (`smart-router.ts`)

Intelligent model routing based on task analysis.

**Features:**
- Analyzes user input to detect task types
- Suggests appropriate models via notifications
- Configurable routing rules via `~/.phi/agent/routing.json`
- `/routing` command for configuration management

**Task Categories:**
- **Code tasks** (implement, create, refactor) → Coder model
- **Debug tasks** (fix, bug, error) → Reasoning model  
- **Exploration** (read, analyze, explain) → Fast model
- **Planning** (plan, design, architect) → Reasoning model

**Commands:**
- `/routing` - Show current configuration
- `/routing enable|disable` - Toggle smart routing
- `/routing notify-on|notify-off` - Toggle notifications
- `/routing test` - Test routing on sample inputs

### 3. 📋 Orchestrator Extension (`orchestrator.ts`)

High-level project planning and task management.

**Features:**
- `/plan <description>` - Create structured project plans
- `orchestrate(description)` - LLM-callable planning tool
- Generates spec files and TODO lists with timestamps
- Automatic task breakdown and status tracking

**File Output:**
- `.phi/plans/spec-TIMESTAMP.md` - Project specifications
- `.phi/plans/todo-TIMESTAMP.md` - Task lists with checkboxes

**Commands:**
- `/plan <description>` - Create a new project plan
- `/plans` - List existing project plans

### 4. 🧩 Skill Loader Extension (`skill-loader.ts`)

Dynamic loading and injection of specialized skills.

**Features:**
- Scans `~/.phi/agent/skills/` and `.phi/skills/` for skills
- Keyword-based skill detection and auto-loading
- `/skills` command to browse available skills
- Automatic context injection when skills are relevant

**Skill Structure:**
```
skill-name/
├── SKILL.md          # Main skill content
└── (other files)     # Optional supporting files
```

**Commands:**
- `/skills` - List all available skills
- `/skills <name>` - View specific skill details

### 5. 🌐 Web Search Extension (`web-search.ts`)

Internet search capabilities with multiple providers.

**Features:**
- `web_search(query, count?)` - LLM-accessible web search
- Brave Search API integration (with `BRAVE_API_KEY`)
- DuckDuckGo HTML fallback when API unavailable
- `/search` command for quick searches

**Setup:**
```bash
# Optional: Set Brave Search API key for better results
export BRAVE_API_KEY="your-api-key"
```

**Commands:**
- `/search <query>` - Quick web search from chat

### 6. 🏆 Benchmark Extension (`benchmark.ts`)

Integrated AI model performance testing and comparison.

**Features:**
- `/benchmark` command for interactive testing
- Fibonacci code generation test (more categories planned)
- Performance metrics: time, quality, token usage
- Results persistence in `~/.phi/benchmark/results.json`
- Model ranking and comparison

**Test Categories (V1):**
- **Fibonacci** - Iterative function implementation with test cases

**Commands:**
- `/benchmark` - Show available options
- `/benchmark <model>` - Test specific model
- `/benchmark results` - View benchmark report
- `/benchmark clear` - Clear all results

## Installation

1. Copy the desired extensions to your extensions directory:
   ```bash
   # Global installation
   cp -r packages/coding-agent/extensions/phi ~/.pi/agent/extensions/
   
   # Project-specific installation  
   cp -r packages/coding-agent/extensions/phi .pi/extensions/
   ```

2. Extensions will automatically load on next Pi session start.

## Configuration

### Memory Extension
- Memory files stored in `~/.phi/memory/` (global) and `.phi/memory/` (local)
- No configuration required - creates directories automatically

### Smart Router Extension
- Configuration: `~/.phi/agent/routing.json`
- Auto-creates default config on first run
- Modify patterns and model assignments as needed

### Skill Loader Extension
- Skills directory: `~/.phi/agent/skills/` (global) and `.phi/skills/` (local)
- Each skill is a folder containing `SKILL.md`

### Web Search Extension
- Optional: Set `BRAVE_API_KEY` environment variable
- Falls back to DuckDuckGo if no API key provided

### Benchmark Extension
- Results saved to `~/.phi/benchmark/results.json`
- No configuration required

## Development

Each extension follows these conventions:

```typescript
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "phi-code";

export default function extensionName(pi: ExtensionAPI) {
  // Register tools
  pi.registerTool({
    name: "tool_name",
    description: "Tool description",
    parameters: Type.Object({
      param: Type.String({ description: "Parameter description" })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Implementation
    }
  });

  // Register commands
  pi.registerCommand("command", {
    description: "Command description", 
    handler: async (args, ctx) => {
      // Implementation
    }
  });

  // Event listeners
  pi.on("session_start", async (event, ctx) => {
    // Session initialization
  });
}
```

### Guidelines
- Use `@sinclair/typebox` for parameter schemas
- Prefer Node.js built-in modules over external dependencies
- Include JSDoc comments for all functions
- Handle errors gracefully with user-friendly messages
- Use `ctx.ui.notify()` for user feedback

## Future Extensions

Planned extensions for future releases:

- **Git Integration** - Advanced Git operations and workflow automation
- **Code Review** - Automated code review and quality checking  
- **Documentation** - Auto-generation of docs from code
- **Testing** - Test generation and coverage analysis
- **Deployment** - CI/CD pipeline integration
- **Monitoring** - Real-time system monitoring and alerting

## Contributing

To add new extensions:

1. Create a new `.ts` file in this directory
2. Follow the existing pattern and conventions
3. Add comprehensive JSDoc documentation
4. Update this README with the new extension details
5. Test thoroughly before submitting

## License

Same license as the main Phi Code project.