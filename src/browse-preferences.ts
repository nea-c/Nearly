import {
  validateConnectionKey,
  localFolder,
  remoteFolder,
} from "./explorer-preferences.js";
export interface BrowseLocation {
  local?: string;
  remote?: string;
}
export type BrowseLocations = Record<string, BrowseLocation>;
export function validateBrowseLocations(value: unknown): BrowseLocations {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 500
  )
    throw Error("Browse locations are limited to 500 connection identities");
  const result: BrowseLocations = {};
  for (const [raw, paths] of Object.entries(value)) {
    const key = validateConnectionKey(raw);
    if (
      Object.hasOwn(result, key) ||
      !paths ||
      typeof paths !== "object" ||
      Array.isArray(paths) ||
      Object.keys(paths).some((k) => k !== "local" && k !== "remote")
    )
      throw Error("Invalid or duplicate browse location");
    const p = paths as Record<string, unknown>;
    if (p.local === undefined && p.remote === undefined)
      throw Error("A successful browse location is required");
    result[key] = {
      ...(p.local === undefined ? {} : { local: localFolder(p.local) }),
      ...(p.remote === undefined ? {} : { remote: remoteFolder(p.remote) }),
    };
  }
  return result;
}
