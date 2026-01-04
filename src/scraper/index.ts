import { ListScraper } from './list';
import { CollectionsScraper } from './collections';
import { PopularScraper } from './popular';
import env from '../util/env';

export interface ScrapedMedia {
    id: number;
    name: string;
    tmdbId?: string|null;
    slug: string;
    tags?: string[]; // Custom tags from the source list
    qualityProfile?: string; // Override global quality profile
}

export interface LetterboxdMovie extends ScrapedMedia {
    imdbId?: string|null;
    publishedYear?: number|null;
    rating?: number|null;
}

export interface ScrapedSeries extends ScrapedMedia {
    seasons?: number[];
}

export enum ListType {
  WATCHLIST = 'watchlist',
  REGULAR_LIST = 'regular_list',
  WATCHED_MOVIES = 'watched_movies',
  ACTOR_FILMOGRAPHY = 'actor_filmography',
  DIRECTOR_FILMOGRAPHY = 'director_filmography',
  WRITER_FILMOGRAPHY = 'writer_filmography',
  COLLECTIONS = 'collections',
  POPULAR_MOVIES = 'popular_movies'
}

export const LETTERBOXD_BASE_URL = 'https://letterboxd.com';

const URL_PATTERNS = {
  [ListType.WATCHLIST]: /^https:\/\/letterboxd\.com\/[^\/]+\/watchlist\/?$/,
  [ListType.REGULAR_LIST]: /^https:\/\/letterboxd\.com\/[^\/]+\/list\/[^\/]+\/?$/,
  [ListType.WATCHED_MOVIES]: /^https:\/\/letterboxd\.com\/[^\/]+\/films\/?$/,
  [ListType.ACTOR_FILMOGRAPHY]: /^https:\/\/letterboxd\.com\/actor\/[^\/]+\/?$/,
  [ListType.DIRECTOR_FILMOGRAPHY]: /^https:\/\/letterboxd\.com\/director\/[^\/]+\/?$/,
  [ListType.WRITER_FILMOGRAPHY]: /^https:\/\/letterboxd\.com\/writer\/[^\/]+\/?$/,
  [ListType.COLLECTIONS]: /^https:\/\/letterboxd\.com\/films\/in\/[^\/]+\/?$/,
  [ListType.POPULAR_MOVIES]: /^https:\/\/letterboxd\.com\/films\/popular\/?$/
};

export const detectListType = (url: string): ListType | null => {
  for (const [listType, pattern] of Object.entries(URL_PATTERNS)) {
    if (pattern.test(url)) {
      return listType as ListType;
    }
  }
  return null;
};

export const fetchMoviesFromUrl = async (
  url: string, 
  take?: number, 
  strategy?: 'oldest' | 'newest'
): Promise<{ items: LetterboxdMovie[], hasErrors: boolean }> => {
  const listType = detectListType(url);
  
  if (!listType) {
    throw new Error(`Unsupported URL format: ${url}`);
  }
  
  // Use provided values or fallback to ENV (legacy cleanup, though caller should handle defaults)
  const finalTake = take ?? env.LETTERBOXD_TAKE_AMOUNT;
  const finalStrategy = strategy ?? env.LETTERBOXD_TAKE_STRATEGY;

  switch (listType) {
    case ListType.ACTOR_FILMOGRAPHY:
    case ListType.DIRECTOR_FILMOGRAPHY:
    case ListType.WRITER_FILMOGRAPHY:
    case ListType.WATCHLIST:
    case ListType.REGULAR_LIST:
    case ListType.WATCHED_MOVIES:
      const listScraper = new ListScraper(url, finalTake, finalStrategy);
      return listScraper.getMovies();

    case ListType.COLLECTIONS:
      const collectionsScraper = new CollectionsScraper(url, finalTake, finalStrategy);
      return collectionsScraper.getMovies();

    case ListType.POPULAR_MOVIES:
      const popularScraper = new PopularScraper(url, finalTake, finalStrategy);
      return popularScraper.getMovies();
      
    default:
      throw new Error(`Unsupported list type: ${listType}`);
  }
}