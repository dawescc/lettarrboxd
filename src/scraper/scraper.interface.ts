import { LetterboxdMovie } from ".";

interface Scraper {
    /**
     * Retrieves all movies from the configured Letterboxd source.
     * 
     * Scrapes the Letterboxd URL (watchlist, regular list, etc.) and extracts
     * movie data including titles and TMDB IDs. Handles pagination automatically
     * and applies rate limiting between requests.
     * 
     * @returns Promise that resolves to an object containing items and an error flag
     * @throws Error if scraping fails or network issues occur
     */
    getMovies(): Promise<{ items: LetterboxdMovie[], hasErrors: boolean }>;
}

export default Scraper;