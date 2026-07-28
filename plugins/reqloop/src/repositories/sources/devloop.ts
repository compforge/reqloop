import type {
  Source,
  SourceContext,
} from "@qiankun01/baton-plugin";

import { currentRepositoryIdentity } from "../identity.ts";
import type { RepositorySpec } from "../protocol.ts";
import { repositoryResourceName } from "../resource.ts";

/** Contributes the BatonSession checkout as a Repository Resource. */
export class DevloopRepositorySource implements Source<RepositorySpec> {
  readonly type = "resource";
  readonly sourceId = "devloop";

  constructor(private readonly cwd: string) {}

  start(context: SourceContext<RepositorySpec>): void {
    const identity = currentRepositoryIdentity(this.cwd);
    if (!identity) return;
    context.emit({
      name: repositoryResourceName(identity),
      spec: { identity },
    });
  }
}
