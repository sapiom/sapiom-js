/** Lowercase-ascii-hyphen slug, ≤40 chars so "news-roundup-<slug>" fits sandbox name limits. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "company";
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
