export interface ConnectionError {
  kind: "keyUnlockFailed" | "other";
  message: string;
}

/** Only the native connect_session discriminator selects inline presentation.
 * Text (including decoder/authentication wording) is never classification. */
export function connectionError(error: unknown): ConnectionError {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string") {
      return {
        kind: value.kind === "keyUnlockFailed" ? "keyUnlockFailed" : "other",
        message: value.message,
      };
    }
  }
  return { kind: "other", message: String(error) };
}
