import type {
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import { currentRepositoryIdentity } from "../identity.ts";
import type { RepositorySpec } from "../protocol.ts";
import { repositoryResourceName } from "../resource.ts";

/** Contributes the BatonSession checkout as a Repository Resource. */
export class DevloopRepositorySource implements Source<RepositorySpec> {
  readonly type = "resource";
  readonly sourceId = "devloop";

  constructor(private readonly cwd: string) {}

  async start(context: SourceContext<RepositorySpec>): Promise<void> {
    const identity = await currentRepositoryIdentity(this.cwd);
    if (!identity) return;
    await context.emit({
      name: repositoryResourceName(identity),
      spec: { identity },
    });
  }
}
