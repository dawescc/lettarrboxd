import axios from 'axios';
import logger from '../util/logger';
import { LetterboxdMovie } from './index';

interface SerializdItem {
    showId: number;
    showName: string;
    bannerImage: string;
    dateAdded: string;
}

interface SerializdResponse {
    items: SerializdItem[];
    totalPages: number;
    numberOfShows: number;
}

export class SerializdScraper {
    constructor(private url: string) {}

    async getSeries(): Promise<LetterboxdMovie[]> {
        logger.info(`Scraping Serializd watchlist: ${this.url}`);
        
        // Extract username from URL
        // Expected format: https://www.serializd.com/user/USERNAME/watchlist
        const match = this.url.match(/user\/([^\/]+)\/watchlist/);
        if (!match) {
            throw new Error(`Invalid Serializd watchlist URL: ${this.url}. Expected format: .../user/USERNAME/watchlist`);
        }
        const username = match[1];
        const baseUrl = `https://www.serializd.com/api/user/${username}/watchlistpage_v2`;
        
        const items: LetterboxdMovie[] = [];
        let page = 1;
        let totalPages = 1;

        try {
            do {
                const apiUrl = `${baseUrl}/${page}?sort_by=date_added_desc`;
                logger.debug(`Fetching Serializd API: ${apiUrl}`);

                const response = await axios.get<SerializdResponse>(apiUrl, {
                    headers: {
                        'X-Requested-With': 'serializd_vercel',
                        'Referer': this.url,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });

                const data = response.data;
                totalPages = data.totalPages;

                if (data.items) {
                    data.items.forEach(item => {
                        items.push({
                            id: item.showId,
                            name: item.showName,
                            tmdbId: item.showId.toString(),
                            slug: item.showName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                        });
                    });
                }

                page++;
                
                // Be nice to the API
                if (page <= totalPages) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } while (page <= totalPages);

            logger.debug(`Found ${items.length} series in Serializd watchlist`);
            return items;

        } catch (error) {
            logger.error('Error scraping Serializd:', error as any);
            throw error;
        }
    }
}
