/**
 * Split a command line typed in the `/mcp add` wizard into argv.
 *
 * Whitespace separates arguments except inside "double" or 'single' quotes.
 * Inside double quotes, `\"` and `\\` are escapes; every other backslash is kept
 * literally so Windows paths (`C:\tools\server.exe`) survive unquoted or quoted.
 * Never executed through a shell: the result goes to spawn() as command + args.
 */
export function splitCommandLine(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inArg = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < input.length; i++) {
		const c = input[i] as string;
		if (quote) {
			if (c === quote) quote = null;
			else if (quote === '"' && c === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
				current += input[i + 1];
				i++;
			} else current += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			inArg = true;
		} else if (/\s/.test(c)) {
			if (inArg) args.push(current);
			current = "";
			inArg = false;
		} else {
			current += c;
			inArg = true;
		}
	}
	if (quote) throw new Error(`Unterminated ${quote} quote in command`);
	if (inArg) args.push(current);
	return args;
}
