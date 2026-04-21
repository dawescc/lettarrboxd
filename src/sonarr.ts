/**
 * Sonarr sync.
 * Takes a list of shows (MediaItem[]) and syncs them to Sonarr:
 *   - existing + owned  → update tags + reconcile season monitoring
 *   - not in library    → lookup TMDB→TVDB, add
 *   - owned + off list  → remove series (if REMOVE_MISSING_ITEMS)
 */
import Axios from 'axios';
import env from './util/env';
import { loadConfig } from './util/config';
import logger from './util/logger';
import { retryOperation, withTimeout } from './util/retry';
import { sonarrLimiter, createRateLimitedAxios } from './util/limiters';
import { calculateNextTagIds } from './util/tagLogic';
import { resolveDefaultProfileId } from './util/arr';
import { TAG_SERIALIZD } from './util/constants';
import type { MediaItem, ScrapeResult } from './types';

const http = createRateLimitedAxios(
    Axios.create({
        baseURL: env.SONARR_API_URL,
        headers: { 'X-Api-Key': env.SONARR_API_KEY },
        timeout: 30_000,
    }),
    sonarrLimiter,
    'Sonarr'
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
    byTmdb: Map<number, any>;
    byTvdb: Map<number, any>;
    keepTvdbIds: Set<number>;
}

export async function sync(items: MediaItem[], opts: Pick<ScrapeResult, 'managedTags' | 'unsafeTags' | 'abortCleanup'>): Promise<Set<string>> {
    const config = loadConfig();
    const configuredProfileName = config.sonarr?.qualityProfile ?? env.SONARR_QUALITY_PROFILE;

    const [profiles, rootFolders, allTags, existingSeries] = await Promise.all([
        retryOperation(() => http.get('/api/v3/qualityprofile').then(r => r.data), 'get Sonarr profiles'),
        retryOperation(() => http.get('/api/v3/rootfolder').then(r => r.data), 'get Sonarr root folders'),
        retryOperation(() => http.get('/api/v3/tag').then(r => r.data), 'get Sonarr tags'),
        retryOperation(() => http.get('/api/v3/series').then(r => r.data), 'get Sonarr series'),
    ]);

    // Quality profile
    const profileMap = new Map<string, number>(profiles.map((p: any) => [p.name, p.id]));
    const defaultProfileId = resolveDefaultProfileId('Sonarr', profiles, configuredProfileName, profileMap);

    // Root folder
    const rootFolderCfg = config.sonarr?.rootFolder;
    const rootFolder: string = rootFolderCfg?.startsWith('/')
        ? rootFolderCfg
        : rootFolderCfg
            ? (await retryOperation(() => http.get(`/api/v3/rootfolder/${rootFolderCfg}`).then(r => r.data.path), 'get root folder by id'))
            : rootFolders[0]?.path;
    if (!rootFolder) throw new Error('No Sonarr root folder found');

    // Tags
    const tagMap = new Map<string, number>(allTags.map((t: any) => [t.label, t.id]));
    const labelById = new Map<number, string>(allTags.map((t: any) => [t.id, t.label]));

    const globalTagNames = [TAG_SERIALIZD, ...(config.sonarr?.tags ?? [])];
    const itemTagNames = [...new Set(items.flatMap(i => i.tags ?? []))];
    const needed = [...new Set([...globalTagNames, ...itemTagNames, ...opts.managedTags])];

    for (const label of needed) {
        if (!tagMap.has(label)) {
            try {
                const res = await http.post('/api/v3/tag', { label });
                tagMap.set(label, res.data.id);
                labelById.set(res.data.id, label);
                logger.info(`Created Sonarr tag: ${label}`);
            } catch (e: any) {
                logger.error(`Failed to create tag '${label}': ${e.message}`);
            }
        }
    }

    const ownershipTagId = tagMap.get(TAG_SERIALIZD)!;
    const systemTagIds = globalTagNames.map(l => tagMap.get(l)).filter((id): id is number => id !== undefined);
    const managedTagIds = new Set(
        [...opts.managedTags, ...globalTagNames].map(l => tagMap.get(l)).filter((id): id is number => id !== undefined)
    );

    // Build lookup maps for existing series
    const byTmdb = new Map<number, any>();
    const byTvdb = new Map<number, any>();
    for (const s of existingSeries) {
        if (s.tmdbId) byTmdb.set(s.tmdbId, s);
        byTvdb.set(s.tvdbId, s);
    }

    const keepTvdbIds = new Set<number>();
    const ctx: Ctx = { profileMap, defaultProfileId, rootFolder, tagMap, labelById, ownershipTagId, managedTagIds, systemTagIds, byTmdb, byTvdb, keepTvdbIds };

    logger.info(`Syncing ${items.length} shows to Sonarr...`);
    const results = await Promise.allSettled(items.map(item =>
        withTimeout(syncItem(item, ctx), 60_000, `Sonarr sync ${item.title}`).catch((e: any) => {
            logger.error(`Failed to sync ${item.title}: ${e.message}`);
        })
    ));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) logger.warn(`${failed}/${items.length} Sonarr shows failed.`);

    // Cleanup
    if (!opts.abortCleanup && env.REMOVE_MISSING_ITEMS) {
        const toRemove = existingSeries.filter((s: any) => {
            if (!s.tags?.includes(ownershipTagId)) return false;
            if (keepTvdbIds.has(s.tvdbId)) return false;
            return !s.tags.some((id: number) => opts.unsafeTags.has(labelById.get(id) ?? ''));
        });

        if (toRemove.length) {
            logger.info(`Removing ${toRemove.length} series from Sonarr...`);
            await Promise.allSettled(toRemove.map((s: any) =>
                withTimeout(removeSeries(s), 30_000, `remove ${s.title}`).catch((e: any) => logger.error(`Failed to remove ${s.title}: ${e.message}`))
            ));
        }
    }

    logger.info('Sonarr sync complete.');
    return new Set<string>(existingSeries.map((s: any) => String(s.tmdbId)).filter(Boolean));
}

async function syncItem(item: MediaItem, ctx: Ctx): Promise<void> {
    const tmdbId = parseInt(item.tmdbId);
    if (!tmdbId) return;

    const itemTagIds = (item.tags ?? []).map(l => ctx.tagMap.get(l)).filter((id): id is number => id !== undefined);
    const finalTagIds = [...new Set([...ctx.systemTagIds, ...itemTagIds])];
    const profileId = (item.qualityProfile ? ctx.profileMap.get(item.qualityProfile) : undefined) ?? ctx.defaultProfileId;

    // Find in existing library
    let existing = ctx.byTmdb.get(tmdbId);

    if (!existing) {
        // Sonarr lookup to get tvdbId
        const lookupResult = await lookupByTmdb(item.tmdbId, item.title);
        if (!lookupResult) return;

        // May already be in library under tvdbId
        existing = ctx.byTvdb.get(lookupResult.tvdbId);

        if (!existing) {
            // Not in library — add it
            const tvdbId = await addSeries(item, lookupResult, profileId, finalTagIds, ctx.rootFolder);
            if (tvdbId) ctx.keepTvdbIds.add(tvdbId);
            return;
        }
    }

    ctx.keepTvdbIds.add(existing.tvdbId);

    const owned = existing.tags?.includes(ctx.ownershipTagId) || env.OVERRIDE_TAGS;
    if (!owned) {
        logger.debug(`Skipping ${item.title}: not owned.`);
        return;
    }

    // Update tags
    const nextTags = calculateNextTagIds(existing.tags ?? [], ctx.managedTagIds, finalTagIds);
    const unchanged = nextTags.length === existing.tags?.length && nextTags.every((t: number) => existing.tags.includes(t));
    if (!unchanged) {
        await retryOperation(() => updateSeries(existing, nextTags), `update tags for ${item.title}`);
        existing = { ...existing, tags: nextTags };
    }

    // Reconcile season monitoring
    if (item.seasons?.length) {
        await reconcileSeasons(existing, item.seasons);
    }
}

async function lookupByTmdb(tmdbId: string, title: string): Promise<any | null> {
    try {
        const res = await http.get('/api/v3/series/lookup', { params: { term: `tmdb:${tmdbId}` } });
        const result = res.data?.[0];
        if (result) return result;
    } catch { /* fall through to title search */ }

    // Title fallback
    try {
        const res = await http.get('/api/v3/series/lookup', { params: { term: title } });
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const match = (res.data ?? []).find((r: any) => normalize(r.title) === normalize(title));
        if (match) {
            logger.info(`Found ${title} via title match: ${match.title} (TVDB: ${match.tvdbId})`);
            return match;
        }
    } catch { /* ignore */ }

    logger.warn(`Series not found in Sonarr: ${title} (TMDB: ${tmdbId})`);
    return null;
}

async function addSeries(item: MediaItem, lookup: any, profileId: number, tagIds: number[], rootFolder: string): Promise<number | null> {
    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would add series: ${lookup.title}`);
        return lookup.tvdbId;
    }
    try {
        const seasons = buildSeasonMonitoring(lookup.seasons ?? [], item.seasons);
        await http.post('/api/v3/series', {
            title: lookup.title,
            tvdbId: lookup.tvdbId,
            qualityProfileId: profileId,
            rootFolderPath: rootFolder,
            monitored: !env.SONARR_ADD_UNMONITORED,
            tags: tagIds,
            seasons,
            addOptions: { searchForMissingEpisodes: true },
        });
        logger.info(`Added series: ${lookup.title}`);
        return lookup.tvdbId;
    } catch (e: any) {
        logger.error(`Failed to add ${item.title}: ${e.message}`);
        return null;
    }
}

async function updateSeries(series: any, tags: number[]): Promise<void> {
    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would update tags for: ${series.title}`);
        return;
    }
    await http.put(`/api/v3/series/${series.id}`, { ...series, tags });
    logger.info(`Updated tags for: ${series.title}`);
}

async function removeSeries(series: any): Promise<void> {
    if (env.DRY_RUN) {
        logger.info(`[DRY RUN] Would remove series: ${series.title}`);
        return;
    }
    await http.delete(`/api/v3/series/${series.id}`, {
        params: { deleteFiles: true, addImportExclusion: false },
    });
    logger.info(`Removed series: ${series.title}`);
}

async function reconcileSeasons(series: any, targetSeasons: number[]): Promise<void> {
    const targetSet = new Set(targetSeasons);

    const updated = (series.seasons ?? []).map((s: any) => ({
        ...s,
        monitored: targetSet.has(s.seasonNumber),
    }));

    const changed = updated.some((s: any, i: number) => s.monitored !== series.seasons[i]?.monitored);

    if (changed) {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would update seasons for ${series.title}: [${targetSeasons.join(', ')}]`);
        } else {
            await http.put(`/api/v3/series/${series.id}`, { ...series, seasons: updated });
            logger.info(`Updated seasons for ${series.title}: [${targetSeasons.join(', ')}]`);
        }
    }

    // Delete episode files for unmonitored seasons when cleanup is on
    if (env.REMOVE_MISSING_ITEMS) {
        const toPrune = (series.seasons ?? [])
            .filter((s: any) => !targetSet.has(s.seasonNumber))
            .map((s: any) => s.seasonNumber);

        if (toPrune.length) {
            const files = await http.get('/api/v3/episodefile', { params: { seriesId: series.id } });
            const toDelete = (files.data ?? []).filter((f: any) => toPrune.includes(f.seasonNumber));

            await Promise.allSettled(toDelete.map((f: any) =>
                env.DRY_RUN
                    ? Promise.resolve(logger.info(`[DRY RUN] Would delete episode file ${f.id}`))
                    : http.delete(`/api/v3/episodefile/${f.id}`).catch((e: any) =>
                        logger.error(`Failed to delete episode file ${f.id}: ${e.message}`)
                    )
            ));
        }
    }
}

function buildSeasonMonitoring(available: any[], target?: number[]): { seasonNumber: number; monitored: boolean }[] {
    if (target?.length) {
        const set = new Set(target);
        return available.map(s => ({ seasonNumber: s.seasonNumber, monitored: set.has(s.seasonNumber) }));
    }

    const strategy = env.SONARR_SEASON_MONITORING;
    return available.map((s, i) => {
        let monitored = false;
        switch (strategy) {
            case 'all':    monitored = true; break;
            case 'first':  monitored = s.seasonNumber === 1; break;
            case 'latest': monitored = i === available.length - 1; break;
            case 'future': monitored = !s.statistics?.episodeCount; break;
            case 'none':   monitored = false; break;
        }
        return { seasonNumber: s.seasonNumber, monitored };
    });
}

