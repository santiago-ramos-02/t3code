/**
 * A plain mirror planned from gentle-ai's own footprint instead of the built-in lists.
 *
 * @module gentleAi/PlainFootprint
 */
import type * as Path from "effect/Path";

import type { PlainEntry } from "./PlainConfigMirror.ts";

/**
 * What gentle-ai added to some agents, keyed by `footprintKey`: paths a plain config leaves out,
 * and shared files replaced with gentle-ai's own version without its parts.
 */
export interface GentleAiPlainFootprint {
  readonly removed: ReadonlySet<string>;
  readonly rewritten: ReadonlyMap<string, string>;
}

export const EMPTY_FOOTPRINT: GentleAiPlainFootprint = { removed: new Set(), rewritten: new Map() };

/** The key a footprint uses for a path: absolute, and case-folded where the filesystem is. */
export function footprintKey(path: Path.Path, filePath: string, platform: NodeJS.Platform) {
  const resolved = path.resolve(filePath);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/**
 * Plans a mirror of `directory` from a footprint: gentle-ai's paths are left out, its rewritten
 * files are written, directories holding either are mirrored in turn, and the rest is linked.
 */
export function footprintPlan(
  footprint: GentleAiPlainFootprint,
  directory: string,
  path: Path.Path,
  platform: NodeJS.Platform,
): (name: string, isDirectory: boolean) => PlainEntry {
  const keys = [...footprint.removed, ...footprint.rewritten.keys()];
  return (name) => {
    const entry = path.join(directory, name);
    const key = footprintKey(path, entry, platform);
    if (footprint.removed.has(key)) return { kind: "omit" };
    const content = footprint.rewritten.get(key);
    if (content !== undefined) return { kind: "write", content };
    const inside = key + path.sep;
    if (keys.some((candidate) => candidate.startsWith(inside)))
      return { kind: "mirror", plan: footprintPlan(footprint, entry, path, platform) };
    return { kind: "link" };
  };
}

/** A file's plain content: gentle-ai's rewrite, null when gentle-ai owns it, else unchanged. */
export function plainContent(
  footprint: GentleAiPlainFootprint,
  filePath: string,
  content: string,
  path: Path.Path,
  platform: NodeJS.Platform,
): string | null {
  const key = footprintKey(path, filePath, platform);
  if (footprint.removed.has(key)) return null;
  return footprint.rewritten.get(key) ?? content;
}
