import { Store, type Settings } from "./core.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// An uncertain approval reload may adopt only the intended pin. Adopting a
// fresh revision with stale unrelated sections would defeat the native CAS.
export function sameSettingsAfterHostPin(before: Settings, after: Settings, profileId: string): boolean {
  const snapshot = (data: Settings) => {
    const value = new Store(data).serialize() as unknown as Record<string, unknown>;
    for (const key of ["settingsRevision", "connectionTreeChanged", "bookmarkTreeChanged", "browseLocationsChanged", "lastSelectedProfileChanged"])
      delete value[key];
    value.profiles = (value.profiles as Settings["profiles"]).map(profile =>
      profile.id === profileId ? { ...profile, hostKey: "" } : profile,
    );
    return stable(value);
  };
  try { return snapshot(before) === snapshot(after); }
  catch { return false; }
}
