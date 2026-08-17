/**
 * Command names used in user-facing messages.
 *
 * Kept in one place so a rebrand does not leave half the help text pointing at a
 * binary that is not installed: this package used to tell users to run `pi pods …`
 * while its own bin was `pi-pods`.
 */

/** This CLI's own binary name (see `bin` in package.json). */
export const CLI_COMMAND = "phi-pods";

/** The coding agent this package delegates prompting to. */
export const AGENT_COMMAND = "phi";

/** npm name of that agent, used to find its entry point behind a Windows shim. */
export const AGENT_PACKAGE = "@phi-code-admin/phi-code";
