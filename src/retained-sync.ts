import type { Profile } from "./core.js";
import { validateRules } from "./core.js";
import {
  localFolder,
  remoteFolder,
  text,
  connectionKey,
  validateConnectionKey,
} from "./explorer-preferences.js";

export type RetainedPendingState = "unknown" | "unreflected";
export interface RetainedSync {
  id: string;
  ownerTabId?: string;
  ownerTabClosed?: boolean;
  presetId?: string;
  profile: Profile;
  local: string;
  remote: string;
  exclusionRules: string;
  deleteRemoved: boolean;
  recursive: boolean;
  pendingState: RetainedPendingState;
}
export const MAX_RETAINED_SYNCS = 100;
const recordFields = [
  "id",
  "profile",
  "local",
  "remote",
  "exclusionRules",
  "deleteRemoved",
  "recursive",
  "pendingState",
] as const;
const profileFields = [
  "id",
  "name",
  "host",
  "port",
  "user",
  "auth",
  "mode",
  "keyFile",
  "hostKey",
] as const;
function plain(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("Invalid retained sync object");
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !fields.includes(key),
    ) ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unknown or missing retained sync field");
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    )
      throw Error("Retained sync fields must be ordinary data");
  }
}
function optionalText(value: unknown): string {
  if (value === "") return "";
  return text(value, 4096);
}
function profileSnapshot(value: unknown, project: boolean): Profile {
  const raw = plain(value);
  // Explicit own-field projection never reads runtime-only fields, including
  // passphrases and private key material. Saved DTO validation remains strict.
  const profile: Record<string, unknown> = {};
  if (!project) exact(raw, profileFields);
  for (const key of profileFields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw Error("Invalid retained sync profile field");
    profile[key] = descriptor.value;
  }
  if (
    profile.auth !== "key" ||
    !["mock", "sftp"].includes(profile.mode as string) ||
    !Number.isInteger(profile.port) ||
    Number(profile.port) < 1 ||
    Number(profile.port) > 65535
  )
    throw Error("Invalid retained sync profile");
  const clean: Profile = {
    id: text(profile.id, 128),
    name: text(profile.name, 100),
    host: text(profile.host, 4096),
    port: profile.port as number,
    user: text(profile.user, 4096),
    auth: "key",
    mode: profile.mode as Profile["mode"],
    keyFile: optionalText(profile.keyFile),
    hostKey: optionalText(profile.hostKey),
  };
  validateConnectionKey(connectionKey(clean));
  return clean;
}
function checked(value: unknown, projectProfile: boolean): RetainedSync {
  const record = plain(value);
  const owned =
    Object.hasOwn(record, "ownerTabId") ||
    Object.hasOwn(record, "ownerTabClosed");
  const hasPreset = Object.hasOwn(record, "presetId");
  exact(record, [
    ...recordFields,
    ...(owned ? ["ownerTabId", "ownerTabClosed"] : []),
    ...(hasPreset ? ["presetId"] : []),
  ]);
  const presetId = hasPreset ? text(record.presetId, 128) : undefined;
  if (presetId !== undefined && new TextEncoder().encode(presetId).length > 128)
    throw Error("Invalid retained sync preset ID");
  if (owned && typeof record.ownerTabClosed !== "boolean")
    throw Error("Invalid retained tab ownership");
  const ownerTabId = owned ? text(record.ownerTabId, 64) : undefined;
  // Restored tab IDs also identify native connection sessions.
  if (ownerTabId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(ownerTabId))
    throw Error("Invalid retained tab ownership");
  if (
    typeof record.deleteRemoved !== "boolean" ||
    typeof record.recursive !== "boolean" ||
    !["unknown", "unreflected"].includes(record.pendingState as string)
  )
    throw Error("Invalid retained sync options or pending state");
  if (
    typeof record.exclusionRules !== "string" ||
    record.exclusionRules.includes("\0") ||
    /[\ud800-\udfff]/u.test(record.exclusionRules)
  )
    throw Error("Invalid retained sync exclusion rules");
  validateRules(record.exclusionRules);
  const local = localFolder(record.local),
    remote = remoteFolder(record.remote),
    bytes = new TextEncoder();
  if (
    [record.local, record.remote, local, remote].some(
      (value) => bytes.encode(value as string).length > 4096,
    )
  )
    throw Error("Retained sync paths exceed 4096 bytes");
  return {
    id: text(record.id, 128),
    ...(hasPreset ? { presetId } : {}),
    ...(owned
      ? { ownerTabId, ownerTabClosed: record.ownerTabClosed as boolean }
      : {}),
    profile: profileSnapshot(record.profile, projectProfile),
    local,
    remote,
    exclusionRules: record.exclusionRules,
    deleteRemoved: record.deleteRemoved,
    recursive: record.recursive,
    pendingState: record.pendingState as RetainedPendingState,
  };
}
/** Strict persisted DTO validation. Nothing active or secret may be restored. */
export function validateRetainedSync(value: unknown): RetainedSync {
  return checked(value, false);
}
/** Runtime snapshot: project only complete public profile fields, then validate. */
export function snapshotRetainedSync(value: RetainedSync): RetainedSync {
  return checked(value, true);
}
export function validateRetainedSyncs(value: unknown): RetainedSync[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_RETAINED_SYNCS ||
    Reflect.ownKeys(value).some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !Number.isInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= value.length ||
          String(Number(key)) !== key),
    )
  )
    throw Error("Retained syncs are limited to 100 records");
  const result: RetainedSync[] = [];
  const ids = new Set<string>();
  const owners = new Set<string>();
  let openOwners = 0;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw Error("Invalid retained sync collection");
    const record = validateRetainedSync(descriptor.value);
    if (ids.has(record.id)) throw Error("Duplicate retained sync ID");
    ids.add(record.id);
    if (record.ownerTabId !== undefined) {
      if (owners.has(record.ownerTabId))
        throw Error("Duplicate retained tab owner");
      owners.add(record.ownerTabId);
      if (!record.ownerTabClosed && ++openOwners > 16)
        throw Error("At most 16 open retained tabs");
    }
    result.push(record);
  }
  return result;
}
