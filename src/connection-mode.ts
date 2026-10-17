import { t, html } from "./i18n.js";
import type { Profile } from "./core.js";

declare const __NEARLY_ENABLE_MOCK__: boolean;
// Vite only enables this for an explicitly opted-in development server.
// Production builds always replace it with false, irrespective of environment.
export const mockEnabled =
  typeof __NEARLY_ENABLE_MOCK__ !== "undefined" && __NEARLY_ENABLE_MOCK__;

export const disabledMockMessage =
  "保存済みのモック接続は無効です。接続設定で接続方式を選択して保存してください。";

export function canUseConnection(mode: string, enabled = mockEnabled): boolean {
  return mode === "sftp" || (enabled && mode === "mock");
}

export function parseConnectionMode(
  value: FormDataEntryValue | null,
  enabled = mockEnabled,
): Profile["mode"] {
  if (value === "sftp" || (enabled && value === "mock")) return value;
  throw Error(t("接続方式を選択してください"));
}

export function connectionModeOptions(
  mode?: Profile["mode"],
  enabled = mockEnabled,
): string {
  const selected = mode ?? (enabled ? "mock" : "sftp");
  return `${!enabled && selected === "mock" ? html`<option value="" disabled selected>選択してください</option>` : ""}<option value="sftp" ${selected === "sftp" ? "selected" : ""}>SFTP</option>${enabled ? html`<option value="mock" ${selected === "mock" ? "selected" : ""}>モック</option>` : ""}`;
}
