import type {
  CreateEvent,
  DeleteEvent,
  EventHandler,
  EventResource,
  MapFunc,
  ReconcileRequest,
  Resource,
  UpdateEvent,
} from "@compforge/baton-plugin";

function uniqueRequests(
  requests: readonly ReconcileRequest[],
): readonly ReconcileRequest[] {
  const unique = new Map<string, ReconcileRequest>();
  for (const request of requests) {
    if (!unique.has(request.name)) unique.set(request.name, request);
  }
  return Object.freeze([...unique.values()]);
}

function typedResource<TSpec, TStatus>(
  resource: EventResource,
): Readonly<Resource<TSpec, TStatus>> {
  return resource as Readonly<Resource<TSpec, TStatus>>;
}

/** Maps old and new snapshots so relationship removals wake the former owner. */
export function enqueueRequestsFromMapFunc<
  TSpec = unknown,
  TStatus = unknown,
>(
  map: MapFunc<TSpec, TStatus>,
): EventHandler {
  return Object.freeze({
    async create(event: CreateEvent) {
      return uniqueRequests(
        await map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
    async update(event: UpdateEvent) {
      return uniqueRequests([
        ...await map(typedResource<TSpec, TStatus>(event.oldObject)),
        ...await map(typedResource<TSpec, TStatus>(event.newObject)),
      ]);
    },
    async delete(event: DeleteEvent) {
      return uniqueRequests(
        await map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
  });
}
