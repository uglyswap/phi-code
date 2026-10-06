/**
 * Escape a value for safe inclusion inside single quotes in a POSIX shell
 * command. Wraps the result in single quotes and replaces any embedded single
 * quote with the '\'' sequence so the value cannot break out of the quoting or
 * inject shell syntax (e.g. a path or token containing a single quote).
 */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
