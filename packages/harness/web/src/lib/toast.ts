/** What kind of thing a toast announces: something went wrong ("error", the
 *  default), something POSITIVELY finished ("success" — the scarce green,
 *  reserved for a confirmed win like a copy or a deploy), or a neutral
 *  status worth knowing ("info" — progress, hand-offs, empty results).
 *  Callers announcing a result opt into success/info explicitly. */
export type ToastTone = "info" | "success" | "error";

export interface ToastMessage {
  message: string;
  tone: ToastTone;
}

export function createToastMessage(
  message: string,
  tone: ToastTone = "error",
): ToastMessage {
  return { message, tone };
}
