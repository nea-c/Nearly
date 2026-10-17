import { Store, type Settings } from "./core.js";

/** Apply an acknowledged shared document without rebuilding live window resources.
 * Call only after this window's settings mutations have settled. Connection/job
 * snapshots remain immutable even when their saved profile is edited elsewhere.
 */
export function applyPersistentSettings(store: Store, data: Partial<Settings>): void {
  const validated = new Store(data, { ownedWorkspaceIds: [] });
  const { version: _version, ...persistent } = validated.serialize();
  Object.assign(store, persistent);
  store.connectionTreeWarning = validated.connectionTreeWarning;
  store.bookmarkTreeWarning = validated.bookmarkTreeWarning;
  store.preferenceWarnings = [...validated.preferenceWarnings];
  store.browsePreferencesRevision++;
}
