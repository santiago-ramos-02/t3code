// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction or hard link to link without elevation.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** How one entry of an agent's config directory appears in its plain mirror. */
export type PlainEntry =
  | { readonly kind: "link" }
  | { readonly kind: "omit" }
  | { readonly kind: "write"; readonly content: string }
  // A real directory holding links to the children that pass `keep`.
  | { readonly kind: "filter"; readonly keep: (name: string) => boolean }
  // A real directory whose children are planned in turn, for changes deeper down.
  | { readonly kind: "mirror"; readonly plan: (name: string, directory: boolean) => PlainEntry };

export class PlainConfigMirrorError extends Schema.TaggedError<PlainConfigMirrorError>()(
  "PlainConfigMirrorError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Links `target` to the real `source`. Directories use a junction on Windows, which needs no
 * elevation. Files try a symlink, then a hard link, then a copy: an agent only reads these.
 */
function linkEntry(source: string, target: string, directory: boolean, platform: NodeJS.Platform) {
  return Effect.tryPromise({
    try: async () => {
      if (directory) {
        await NodeFSP.symlink(source, target, platform === "win32" ? "junction" : "dir");
        return;
      }
      try {
        await NodeFSP.symlink(source, target, "file");
      } catch {
        try {
          await NodeFSP.link(source, target);
        } catch {
          await NodeFSP.copyFile(source, target);
        }
      }
    },
    catch: (cause) =>
      new PlainConfigMirrorError({ detail: `Could not link ${source} into ${target}.`, cause }),
  });
}

/**
 * Builds a mirror of an agent's config directory at `target`: each entry of `source` is linked
 * back, omitted, rewritten, or narrowed to some of its children, as `plan` decides. Shared state
 * such as sessions and credentials stays linked, so the agent works as it does normally, minus
 * what the plan leaves out. `target` is replaced if it exists.
 */
export const materializePlainMirror = Effect.fn("materializePlainMirror")(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly platform: NodeJS.Platform;
  readonly plan: (name: string, directory: boolean) => PlainEntry;
  // Leave out entries that cannot be linked, such as files the OS holds locked, instead of
  // failing. Only for mirrors where no single entry is essential, like a whole home folder.
  readonly skipUnlinkable?: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (detail: string) => (cause: unknown) =>
    new PlainConfigMirrorError({ detail, cause });
  const isDirectory = (entry: string) =>
    fileSystem.stat(entry).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  yield* fileSystem
    .remove(input.target, { recursive: true, force: true })
    .pipe(Effect.mapError(fail(`Could not clear ${input.target}.`)));
  yield* fileSystem
    .makeDirectory(input.target, { recursive: true })
    .pipe(Effect.mapError(fail(`Could not create ${input.target}.`)));
  const mirror = (
    source: string,
    target: string,
    plan: (name: string, directory: boolean) => PlainEntry,
  ): Effect.Effect<void, PlainConfigMirrorError> =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false)))) return;
      const names = yield* fileSystem
        .readDirectory(source)
        .pipe(Effect.mapError(fail(`Could not read ${source}.`)));
      for (const name of names) {
        const childSource = path.join(source, name);
        const childTarget = path.join(target, name);
        const directory = yield* isDirectory(childSource);
        const entry = plan(name, directory);
        if (entry.kind === "omit") continue;
        if (entry.kind === "link") {
          yield* linkEntry(childSource, childTarget, directory, input.platform).pipe(
            input.skipUnlinkable ? Effect.ignore : (effect) => effect,
          );
        } else if (entry.kind === "write") {
          yield* fileSystem
            .writeFileString(childTarget, entry.content)
            .pipe(Effect.mapError(fail(`Could not write ${childTarget}.`)));
        } else {
          yield* fileSystem
            .makeDirectory(childTarget, { recursive: true })
            .pipe(Effect.mapError(fail(`Could not create ${childTarget}.`)));
          if (!directory) continue;
          if (entry.kind === "mirror") {
            yield* mirror(childSource, childTarget, entry.plan);
            continue;
          }
          const children = yield* fileSystem
            .readDirectory(childSource)
            .pipe(Effect.mapError(fail(`Could not read ${childSource}.`)));
          for (const child of children) {
            if (!entry.keep(child)) continue;
            const grandchild = path.join(childSource, child);
            yield* linkEntry(
              grandchild,
              path.join(childTarget, child),
              yield* isDirectory(grandchild),
              input.platform,
            );
          }
        }
      }
    });
  yield* mirror(input.source, input.target, input.plan);
});
