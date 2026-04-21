/**
 * Radarr sync.
 * Takes a list of movies (MediaItem[]) and syncs them to Radarr:
 *   - existing + owned  → update tags
 *   - not in library    → add
 *   - owned + off list  → remove (if REMOVE_MISSING_ITEMS)
 */
import Axios from 'axios';
import env from './util/env';
import { loadConfig } from './util/config';
import logger from './util/logger';
import { retryOperation, withTimeout } from './util/retry';
import { radarrLimiter, createRateLimitedAxios } from './util/limiters';
import { calculateNextTagIds } from './util/tagLogic';
import { resolveDefaultProfileId } from './util/arr';
import { TAG_LETTERBOXD } from './util/constants';
import type { MediaItem, ScrapeResult } from './types';

const http = createRateLimitedAxios(
    Axios.create({
        baseURL: env.RADARR_API_URL,
        headers: { 'X-Api-Key': env.RADARR_API_KEY },
        timeout: 30_000,
    }),
    radarrLimiter,
    'Radarr'
);

interface Ctx {
    profileMap: Map<string, number>;
    defaultProfileId: number;
    rootFolder: string;
    tagMap: Map<string, number>;
    labelById: Map<number, string>;
    ownershipTagId: number;
    managedTagIds: Set<number>;
    systemTagIds: number[];
}

export async function sync(items: MediaItem[], opts: Pick<ScrapeResult, 'managedTags' | 'unsafeTags' | 'abortCleanup'>): Promise<Set<string>> {
    const config = loadConfig();
    const configuredProfileName = config.radarr?.qualityProfile ?? env.RADARR_QUALITY_PROFILE;

    // Fetch everything we need in parallel
    const [profiles, rootFolders, allTags, existingMovies] = await Promise.all([
        retryOperation(() => http.get('/api/v3/qualityprofile').then(r => r.data), 'get Radarr profiles'),
        retryOperation(() => http.get('/api/v3/rootfolder').then(r => r.data), 'get Radarr root folders'),
        retryOperation(() => http.get('/api/v3/tag').then(r => r.data), 'get Radarr tags'),
        retryOperation(() => http.get('/api/v3/movie').then(r => r.data), 'get Radarr movies'),
    ]);

    // Quality profile
    const profileMap = new Map<string, number>(profiles.map((p: any) => [p.name, p.id]));
    const defaultProfileId = resolveDefaultProfileId('Radarr', profiles, configuredProfileName, profileMap);

    // Root folder
    const rootFolderCfg = config.radarr?.rootFolder;
    const rootFolder: string = rootFolderCfg?.startsWith('/')
        ? rootFolderCfg
        : rootFolderCfg
            ? (await retryOperation(() => http.get(`/api/v3/rootfolder/${rootFolderCfg}`).then(r => r.data.path), 'get root folder by id'))
            : rootFolders[0]?.path;
    if (!rootFolder) throw new Error('No Radarr root folder found');

    // Tags — build maps, create any missing
    const tagMap = new Map<string, number>(allTags.map((t: any) => [t.label, t.id]));
    const labelById = new Map<number, string>(allTags.map((t: any) => [t.id, t.label]));

    const globalTagNames = [TAG_LETTERBOXD, ...(config.radarr?.tags ?? [])];
    const itemTagNames = [...new Set(items.flatMap(i => i.tags ?? []))];
    const needed = [...new Set([...globalTagNames, ...itemTagNames, ...opts.managedTags])];

    for (const label of needed) {
        if (!tagMap.has(label)) {
            try {
                const res = await http.post('/api/v3/tag', { label });
                tagMap.set(label, res.data.id);
                labelById.set(res.data.id, label);
                logger.info(`Created Radarr tag: ${label}`);
            } catch (e: any) {
                logger.error(`Failed to create tag '${label}': ${e.message}`);
            }
        }
    }

    const ownershipTagId = tagMap.get(TAG_LETTERBOXD)!;
    const systemTagIds = globalTagNames.map(l => tagMap.get(l)).filter((id): id is number => id !== undefined);
    const managedTagIds = new Set(
        [...opts.managedTags, ...globalTagNames].map(l => tagMap.get(l)).filter((id): id is number => id !== undefined)
    );

    const ctx: Ctx = { profileMap, defaultProfileId, rootFolder, tagMap, labelById, ownershipTagId, managedTagIds, systemTagIds };

    // Sync each item
    const byTmdb = new Map<number, any>(existingMovies.map((m: any) => [m.tmdbId, m]));

    logger.info(`Syncing ${items.length} movies to Radarr...`);
    const results = await Promise.allSettled(items.map(item =>
        withTimeout(syncItem(item, byTmdb, ctx), 60_000, `Radarr sync ${item.title}`).catch((e: any) => {
            logger.error(`Failed to sync ${item.title}: ${e.message}`);
        })
    ));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) logger.warn(`${failed}/${items.length} Radarr movies failed.`);

    // Cleanup
    if (!opts.abortCleanup && env.REMOVE_MISSING_ITEMS) {
        const listIds = new Set(items.map(i => parseInt(i.tmdbId)).filter(Boolean));
        const toRemove = existingMovies.filter((m: any) => {
            if (!m.tags?.includes(ownershipTagId)) return false;
            if (listIds.has(m.tmdbId)) return false;
            return !m.tags.some((id: number) => opts.unsafeTags.has(labelById.get(id) ?? ''));
        });

        if (toRemove.length) {
            logger.info(`Removing ${toRemove.length} movies from Radarr...`);
            await Promise.allSettled(toRemove.map((m: any) =>
                withTimeout(removeMovie(m), 30_000, `remove ${m.title}`).catch((e: any) => logger.error(`Failed to remove ${m.title}: ${e.message}`))
            ));
        }
    }

    logger.info('Radarr sync complete.');
    return new Set<string>(existingMovies.map((m: any) => String(m.tmdbId)).filter(Boolean));
}

async function syncItem(item: MediaItem, byTmdb: Map<number, any>, ctx: Ctx): Promise<void> {
    const tmdbId = parseInt(item.tmdbId);
    if (!tmdbId) return;

    const itemTagIds = (item.tags ?? []).map(l => ctx.tagMap.get(l)).filter((id): id is number => id !== undefined);
    const finalTagIds = [...new Set([...ctx.systemTagIds, ...itemTagIds])];
    const profileId = (item.qualityProfile ? ctx.profileMap.get(item.qualityProfile) : undefined) ?? ctx.defaultProfileId;

    const existing = byTmdb.get(tmdbId);

    if (existing) {
        const owned = existing.tags?.includes(ctx.ownershipTagId) || env.OVERRIDE_TAGS;
        if (!owned) {
            logger.debug(`Skipping ${item.title}: not owned.`);
            return;
        }
        const nextTags = calculateNextTagIds(existing.tags ?? [], ctx.managedTagIds, finalTagIds);
        const unchanged = nextTags.length === existing.tags?.length && nextTags.every((t: number) => existing.tags.includes(t));
        if (!unchanged) {
            await retryOperation(() => updateMovie(existing, nextTags), `update ${item.title}`);
        } else {
            logger.debug(`${item.title} tags up to date.`);
        }
        return;
    }

    await retryOperation(() => addMovie(item, tmdbId, profileId, finalTagIds, ctx.rootFolder), `add ${item.title}`);
}

async function addMovie(item: MediaItem, tmdbId: number, profileId: number, tagIds: number[], rootFolder: string): Promise<void> {
    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would add movie: ${item.title} (TMDB: ${tmdbId})`);
        return;
    }
    try {
        await http.post('/api/v3/movie', {
            title: item.title,
            tmdbId,
            qualityProfileId: profileId,
            rootFolderPath: rootFolder,
            minimumAvailability: env.RADARR_MINIMUM_AVAILABILITY,
            monitored: !env.RADARR_ADD_UNMONITORED,
            tags: tagIds,
            addOptions: { searchForMovie: true },
        });
        logger.info(`Added movie: ${item.title}`);
    } catch (e: any) {
        const data = e.response?.data;
        const alreadyExists = Array.isArray(data) && data.some((err: any) =>
            err.errorCode === 'MovieExistsValidator' ||
            err.errorMessage?.includes('already been added')
        );
        if (!alreadyExists) throw e;
        logger.debug(`${item.title} already exists in Radarr.`);
    }
}

async function updateMovie(movie: any, tags: number[]): Promise<void> {
    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would update tags for: ${movie.title}`);
        return;
    }
    await http.put(`/api/v3/movie/${movie.id}`, { ...movie, tags });
    logger.info(`Updated tags for: ${movie.title}`);
}

async function removeMovie(movie: any): Promise<void> {
    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would remove movie: ${movie.title}`);
        return;
    }
    await http.delete(`/api/v3/movie/${movie.id}`, {
        params: { deleteFiles: true, addImportExclusion: false },
    });
    logger.info(`Removed movie: ${movie.title}`);
}

