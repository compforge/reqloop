import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import type {
  ResourceNamespace,
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

/**
 * Mirrors Baton's stable Project identity until PluginContext exposes it.
 * Keeping the path digest prevents same-named checkouts from sharing state.
 */
export function projectResourceNamespace(cwd: string): ResourceNamespace {
  const canonical = resolve(cwd);
  const readable = (
    basename(canonical).replace(/[^a-zA-Z0-9._-]/g, "-") || "project"
  ).slice(0, 80);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `v1/project/${readable}-${digest}`;
}

/** Forces every observation from a Source into one Resource namespace. */
export function namespaceSource<TSpec>(
  source: Source<TSpec>,
  namespace: ResourceNamespace,
): Source<TSpec> {
  return Object.freeze({
    type: source.type,
    sourceId: source.sourceId,
    async start(context: SourceContext<TSpec>) {
      await source.start(Object.freeze({
        ...context,
        emit: async (
          resource: Parameters<SourceContext<TSpec>["emit"]>[0],
        ) => await context.emit({
          ...resource,
          namespace,
        }),
      }));
    },
  });
}
