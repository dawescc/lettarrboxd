export interface MediaItem {
    tmdbId: string;
    title: string;
    slug?: string;
    tags?: string[];
    qualityProfile?: string;
    // Letterboxd metadata — used for filtering, carried through for reference
    rating?: number;
    publishedYear?: number;
    imdbId?: string;
    // TV only
    seasons?: number[];
    episodes?: { season: number; episode: number }[];
}

export interface ScrapeResult {
    items: MediaItem[];
    managedTags: Set<string>; // tags from all lists — system can touch these
    unsafeTags: Set<string>;  // tags from failed lists — protect from cleanup
    abortCleanup: boolean;    // true when a tagless list fails — full stop
}
