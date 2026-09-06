/**
 * `phi completions <bash|zsh|fish>` — print shell completions.
 *
 * Generated from the live command/flag metadata (top-level commands and
 * builtin slash commands), so completions stay in sync with the CLI.
 */

import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";

const TOP_LEVEL_COMMANDS = [
	"install",
	"remove",
	"uninstall",
	"update",
	"list",
	"config",
	"auth",
	"login",
	"logout",
	"completions",
] as const;

const GLOBAL_FLAGS = [
	"--help",
	"--version",
	"--model",
	"--provider",
	"--print",
	"--continue",
	"--resume",
	"--mode",
	"--offline",
	"--verbose",
] as const;

function bashCompletions(): string {
	const commands = TOP_LEVEL_COMMANDS.join(" ");
	const flags = GLOBAL_FLAGS.join(" ");
	const slash = BUILTIN_SLASH_COMMANDS.map((c) => `/${c.name}`).join(" ");
	return `# bash completion for phi
_phi_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${commands} ${flags}" -- "$cur"))
    return 0
  fi
  if [[ "$cur" == /* ]]; then
    COMPREPLY=($(compgen -W "${slash}" -- "$cur"))
    return 0
  fi
  COMPREPLY=($(compgen -W "${flags}" -- "$cur"))
}
complete -F _phi_complete phi
`;
}

function zshCompletions(): string {
	const commands = TOP_LEVEL_COMMANDS.map((c) => `'${c}'`).join(" ");
	const flags = GLOBAL_FLAGS.map((f) => `'${f}'`).join(" ");
	const slash = BUILTIN_SLASH_COMMANDS.map((c) => `'/${c.name}:${c.description.replace(/'/g, "")}'`).join(" ");
	return `#compdef phi
# zsh completion for phi
_phi() {
  local -a commands flags slash
  commands=(${commands})
  flags=(${flags})
  slash=(${slash})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    _describe 'flag' flags
  elif [[ \${words[CURRENT]} == /* ]]; then
    _describe 'slash command' slash
  else
    _describe 'flag' flags
  fi
}
_phi "$@"
`;
}

function fishCompletions(): string {
	const lines: string[] = ["# fish completion for phi"];
	for (const c of TOP_LEVEL_COMMANDS) {
		lines.push(`complete -c phi -n "__fish_use_subcommand" -a "${c}"`);
	}
	for (const f of GLOBAL_FLAGS) {
		lines.push(`complete -c phi -l ${f.slice(2)}`);
	}
	for (const c of BUILTIN_SLASH_COMMANDS) {
		lines.push(`complete -c phi -a "/${c.name}" -d "${c.description.replace(/"/g, "'")}"`);
	}
	return lines.join("\n") + "\n";
}

/** Handle `phi completions <shell>`. Returns true when the args were consumed. */
export function handleCompletionsCommand(args: string[]): boolean {
	if (args[0] !== "completions") return false;
	const shell = args[1];
	if (shell === "bash") process.stdout.write(bashCompletions());
	else if (shell === "zsh") process.stdout.write(zshCompletions());
	else if (shell === "fish") process.stdout.write(fishCompletions());
	else {
		console.error("Usage: phi completions <bash|zsh|fish>");
		console.error("Install: phi completions bash > ~/.local/share/bash-completion/completions/phi");
		process.exitCode = 1;
	}
	return true;
}
