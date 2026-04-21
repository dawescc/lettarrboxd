require('dotenv').config();

import env from './util/env';
import { loadConfig } from './util/config';
import logger from './util/logger';
import { scrape as scrapeLetterboxd } from './scraper/letterboxd';
import { scrape as scrapeSerializd } from './scraper/serializd';
import { sync as syncRadarr } from './radarr';
import { sync as syncSonarr } from './sonarr';
import { syncTags as syncPlex, prefetchLibrary as prefetchPlexLibrary } from './plex';
import { startHealthServer, setAppStatus, updateComponentStatus } from './api/health';
import { TAG_LETTERBOXD, TAG_SERIALIZD } from './util/constants';

async function run() {
    const config = loadConfig();
    logger.info('Starting sync...');

    // Kick off the Plex library index in the background — it'll be warm by the time we need it
    prefetchPlexLibrary();

    // Step 1: Scrape sources in parallel
    const [movies, shows] = await Promise.all([
        config.letterboxd.length
            ? scrapeLetterboxd(config.letterboxd)
                .then(r => { updateComponentStatus('letterboxd', 'ok', `${r.items.length} movies`); return r; })
                .catch((e: any) => { updateComponentStatus('letterboxd', 'error', e.message); logger.error('Letterboxd scrape failed:', e); return null; })
            : Promise.resolve(null),
        config.serializd.length
            ? scrapeSerializd(config.serializd)
                .then(r => { updateComponentStatus('serializd', 'ok', `${r.items.length} shows`); return r; })
                .catch((e: any) => { updateComponentStatus('serializd', 'error', e.message); logger.error('Serializd scrape failed:', e); return null; })
            : Promise.resolve(null),
    ]);

    // Step 2: Push to *arr in parallel — returns set of TMDB IDs already in library
    const [existingMovieTmdbIds, existingShowTmdbIds] = await Promise.all([
        movies
            ? syncRadarr(movies.items, movies)
                .then(ids => { updateComponentStatus('radarr', 'ok'); return ids; })
                .catch((e: any) => {
                    updateComponentStatus('radarr', 'error', e.message);
                    logger.error('Radarr sync failed:', e);
                    throw e;
                })
            : Promise.resolve(new Set<string>()),
        shows
            ? syncSonarr(shows.items, shows)
                .then(ids => { updateComponentStatus('sonarr', 'ok'); return ids; })
                .catch((e: any) => {
                    updateComponentStatus('sonarr', 'error', e.message);
                    logger.error('Sonarr sync failed:', e);
                    throw e;
                })
            : Promise.resolve(new Set<string>()),
    ]);

    // Step 3: Plex — one pass, after both arr syncs, only items that already existed
    if (config.plex && (movies || shows)) {
        try {
            const plexCfg = config.plex;
            if (movies) {
                const plexItems = movies.items.filter(i => existingMovieTmdbIds.has(i.tmdbId));
                logger.info(`Plex movie sync: ${plexItems.length}/${movies.items.length} already in Radarr library.`);
                const globalTags = [...(plexCfg.tags ?? []), ...(config.radarr?.tags ?? []), TAG_LETTERBOXD];
                const managedTags = new Set([...movies.managedTags, ...globalTags]);
                await syncPlex(plexItems, globalTags, managedTags, 'movie');
            }
            if (shows) {
                const plexItems = shows.items.filter(i => existingShowTmdbIds.has(i.tmdbId));
                logger.info(`Plex show sync: ${plexItems.length}/${shows.items.length} already in Sonarr library.`);
                const globalTags = [...(plexCfg.tags ?? []), ...(config.sonarr?.tags ?? []), TAG_SERIALIZD];
                const managedTags = new Set([...shows.managedTags, ...globalTags]);
                await syncPlex(plexItems, globalTags, managedTags, 'show');
            }
            updateComponentStatus('plex', 'ok');
        } catch (e: any) {
            updateComponentStatus('plex', 'error', e.message);
            logger.error('Plex sync failed:', e);
        }
    }

    logger.info('Sync complete.');
}

function scheduleNextRun() {
    const ms = env.CHECK_INTERVAL_MINUTES * 60 * 1000;
    setTimeout(() => {
        setAppStatus('syncing');
        run().catch(e => logger.error('Fatal error in run:', e)).finally(() => {
            setAppStatus('idle');
            scheduleNextRun();
        });
    }, ms);
    logger.info(`Next run: ${new Date(Date.now() + ms).toLocaleString()}`);
}

async function main() {
    startHealthServer(3000);
    logger.info('Application started.');
    setAppStatus('syncing');
    run().catch(e => logger.error('Fatal error in initial run:', e)).finally(() => {
        setAppStatus('idle');
        scheduleNextRun();
    });
}

if (require.main === module) {
    main().catch(e => logger.error(e));
}
