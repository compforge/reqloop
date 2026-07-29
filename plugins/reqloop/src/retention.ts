import type {
  Controller,
  Resource,
  ResourceClient,
} from "@compforge/baton-plugin";

export const DELETE_AFTER_ANNOTATION =
  "reqloop.baton.dev/delete-after";

function deleteAfter<TSpec, TStatus>(
  resource: Readonly<Resource<TSpec, TStatus>>,
): number | undefined {
  const value = resource.metadata.annotations?.[DELETE_AFTER_ANNOTATION];
  if (value === undefined) return;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(
      `${resource.kind}/${resource.metadata.name} annotation ` +
        `${DELETE_AFTER_ANNOTATION} must be an ISO timestamp`,
    );
  }
  return timestamp;
}

function currentTime(now: () => Date): number {
  const timestamp = now().getTime();
  if (Number.isNaN(timestamp)) {
    throw new Error("reqloop retention clock returned an invalid Date");
  }
  return timestamp;
}

/**
 * Applies the user's absolute deletion deadline before domain reconciliation.
 *
 * The annotation is desired policy; Baton deletionTimestamp remains the
 * authoritative transition into terminating cleanup.
 */
export function withUserDeletionPolicy<TSpec, TStatus>(
  resources: ResourceClient,
  controller: Controller<TSpec, TStatus>,
  now: () => Date = () => new Date(),
): Controller<TSpec, TStatus> {
  return {
    ...controller,
    async reconcile(baton, resource) {
      if (resource.metadata.deletionTimestamp !== undefined) {
        return await controller.reconcile(baton, resource);
      }
      const deadline = deleteAfter(resource);
      if (
        deadline !== undefined &&
        deadline <= currentTime(now)
      ) {
        await resources.delete(
          {
            apiVersion: resource.apiVersion,
            kind: resource.kind,
          },
          resource.metadata.name,
        );
        return;
      }

      const result = await controller.reconcile(baton, resource);
      if (deadline === undefined) return result;
      const remainingMs = Math.max(
        1,
        Math.ceil(deadline - currentTime(now)),
      );
      if (
        result?.requeueAfterMs !== undefined &&
        result.requeueAfterMs <= remainingMs
      ) {
        return result;
      }
      return {
        ...(result ?? {}),
        requeueAfterMs: remainingMs,
      };
    },
  };
}
