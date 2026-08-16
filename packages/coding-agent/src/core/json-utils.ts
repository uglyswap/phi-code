/**
 * Shared helpers for user-edited JSON config files.
 *
 * models.json is documented as tolerating `//` line comments and trailing
 * commas (see docs/custom-provider.md). Every reader of that file must go
 * through the same normalization, otherwise a commented config parses in one
 * subsystem and crashes another.
 *
 * Upstream 0.84 grew its own copy of this helper in `utils/json.ts` (byte for
 * byte the same regexes). Two copies is exactly the shape of the bug this
 * module was created to kill, so this is now a re-export: one implementation,
 * one behaviour, and existing `core/json-utils` imports keep working.
 */

export { stripJsonComments } from "../utils/json.ts";
