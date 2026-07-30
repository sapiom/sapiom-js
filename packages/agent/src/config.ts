/**
 * Injected run configuration a step reads from its entry input.
 *
 * A template declares which managed resource it opens — its `resources[].handle`
 * in `template.json` — and Sapiom provisions it at deploy. But that declaration is
 * a build-time artifact: it never reaches step code. So a run needs the chosen
 * handle *injected*, and the injection seam is the entry input. The setup panel's
 * settings (and, later, its "use my own" resource picker) write the chosen handle
 * into the entry input under a declared key, which the engine merges into
 * `ctx.input` per run.
 *
 * Historically templates hardcoded the handle (`const DEFAULT_DB_HANDLE = "…"`)
 * and re-read it in every step, so the *declared* handle and the *opened* handle
 * were two independent literals that could drift, and nothing let a run open a
 * different one. {@link resolveResourceHandle} is the single seam that reads the
 * injected handle, so a declared / provisioned / picked handle finally becomes
 * the one the run opens.
 */

/** Options for {@link resolveResourceHandle}. */
export interface ResolveResourceHandleOptions {
  /**
   * The code-side default handle — the value used when the entry input carries
   * none. This is the runtime guarantee that keeps a zero-setup run working; the
   * manifest declares the same value as the setting's `default` (its renderable
   * projection). Required, because a run must always open *some* handle.
   */
  readonly fallback: string;
  /**
   * The top-level key in the entry input that carries the injected handle — the
   * field a declared `settings[]` entry's `path` targets, and what the picker
   * writes. Defaults to `"dbHandle"`, the convention the templates already use.
   */
  readonly key?: string;
}

/**
 * Resolve the resource handle a run should open from its injected entry input,
 * falling back to the code-side default.
 *
 * Read-only and side-effect-free: it inspects `input` and never provisions,
 * mutates, or opens anything. Safe to call from an entry step — it never throws
 * on a missing, empty, or malformed value; it simply falls back. An injected
 * handle wins only when it is a non-empty string once trimmed.
 *
 * @example
 * ```ts
 * const DEFAULT_DB_HANDLE = "meeting-notes-crm";
 * const handle = resolveResourceHandle(input, { fallback: DEFAULT_DB_HANDLE });
 * ctx.shared.set("dbHandle", handle);
 * ```
 */
export function resolveResourceHandle(
  input: unknown,
  opts: ResolveResourceHandleOptions,
): string {
  const key = opts.key ?? "dbHandle";
  if (input && typeof input === "object") {
    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return opts.fallback;
}
