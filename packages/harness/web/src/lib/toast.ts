/** What kind of thing a toast announces. Only two tones, because only two
 *  change what you would do next: something went wrong, or something
 *  finished/is worth knowing. The default is "error" — callers announcing a
 *  result opt into "info" (mirrors design-eng's sapiom-studio toast model). */
export type ToastTone = "info" | "error";

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
