import type { RetainedSync } from "./retained-sync.js";

/** Return existing objects in a full, changed permutation, or reject atomically. */
export function reorderedWorkspaces<T extends { id: string }>(
  current: readonly T[],
  orderedIds: readonly string[],
): T[] | undefined {
  if (
    !Array.isArray(orderedIds) ||
    orderedIds.length !== current.length ||
    current.length > 16
  )
    return undefined;
  const byId = new Map(current.map((item) => [item.id, item]));
  if (byId.size !== current.length) return undefined;
  const result: T[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    // Reject sparse/accessor inputs without executing caller-provided getters.
    const slot = Object.getOwnPropertyDescriptor(orderedIds, String(i));
    if (
      !slot ||
      !Object.hasOwn(slot, "value") ||
      typeof slot.value !== "string"
    )
      return undefined;
    const item = byId.get(slot.value);
    if (!item) return undefined;
    byId.delete(slot.value);
    result.push(item);
  }
  return result.some((item, i) => item !== current[i]) ? result : undefined;
}

/**
 * Only live owned-open slots participate. Closed/legacy slots keep their exact
 * placement, preserving the close/restore stack. An open owner awaiting runtime
 * materialization also stays in its slot so queued saves cannot lose its record.
 */
export function retainedSyncsInWorkspaceOrder(
  records: readonly RetainedSync[],
  workspaces: readonly { id: string }[],
): RetainedSync[] {
  const liveIds = new Set(workspaces.map((w) => w.id));
  const participates = (record: RetainedSync): boolean =>
    record.ownerTabId !== undefined &&
    record.ownerTabClosed === false &&
    liveIds.has(record.ownerTabId);
  const byOwner = new Map(
    records.filter(participates).map((r) => [r.ownerTabId!, r]),
  );
  const ordered = workspaces.flatMap((w) => {
    const record = byOwner.get(w.id);
    return record ? [record] : [];
  });
  // Defensive guard: invalid internal runtime IDs must never duplicate/drop DTOs.
  if (
    ordered.length !== byOwner.size ||
    byOwner.size !== records.filter(participates).length
  )
    throw Error("Invalid live retained tab workspace order");
  let index = 0;
  return records.map((record) =>
    participates(record) ? ordered[index++] : record,
  );
}
