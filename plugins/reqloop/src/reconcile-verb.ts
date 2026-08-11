import type {
  Resource,
  ResourceClient,
} from "@compforge/baton-plugin";

export const USER_DECISION_TIMEOUT_MS = 10 * 60_000;
export const HARNESS_FOLLOW_UP_TIMEOUT_MS = 30 * 60_000;

export function verbFailure(action: string, detail?: string): Error {
  return new Error(`${action} failed${detail ? `: ${detail}` : ""}`);
}

/**
 * @spec After a Core verb resumes, reconcile writes only to the latest version of the same Resource incarnation.
 * @rule A verb may wait while Resource status changes; never patch the pre-verb resourceVersion or a replacement uid.
 * @see {@link ../docs/reconcile.md}
 */
export async function resourceAfterVerb<TSpec, TStatus>(
  resources: ResourceClient,
  before: Readonly<Resource<TSpec, TStatus>>,
): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
  return await resources.get<TSpec, TStatus>({
    apiVersion: before.apiVersion,
    kind: before.kind,
    namespace: before.metadata.namespace,
    name: before.metadata.name,
    uid: before.metadata.uid,
  });
}
