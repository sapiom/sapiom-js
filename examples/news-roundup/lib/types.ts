export interface RawArticle {
  title: string;
  url: string;
  snippet: string;
}

export interface SelectedArticle {
  title: string;
  url: string;
  summary: string;
  imagePrompt: string;
}

export interface IllustratedArticle {
  title: string;
  sourceUrl: string;
  summary: string;
  /** File-storage fileName of the article image, or null when generation failed. */
  imageFileName: string | null;
}

export interface RoundupShared extends Record<string, unknown> {
  companyName: string;
  companySlug: string;
  runDate: string;
  storagePrefix: string;
}
