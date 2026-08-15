import { log, toStr } from "./log.ts";
import type { LbMovie } from "./letterboxd.ts";
import type { SdSeries } from "./serializd.ts";

interface ArrTag {
	id: number;
	label: string;
}
interface ArrQualityProfile {
	id: number;
	name: string;
}
interface ArrRootFolder {
	path: string;
}

export type RadarrMovie = {
	id: number;
	tmdbId: number;
	title: string;
	year: number;
	tags: number[];
	[key: string]: unknown;
};

export type SonarrSeries = {
	id: number;
	tmdbId?: number;
	tvdbId: number;
	title: string;
	year?: number;
	tags: number[];
	seasons: Array<{ seasonNumber: number; monitored: boolean; [key: string]: unknown }>;
	[key: string]: unknown;
};

export interface ArrSyncConfig {
	url: string;
	token: string;
	masterTag?: string;
	qualityProfile?: string;
	rootFolder?: string;
	dryRun: boolean;
	timeoutMs: number;
	deleteOrphans: boolean;
}

const radarrProfileCache = new Map<string | undefined, number>();
const radarrFolderCache = new Map<string | undefined, string>();
const radarrTagCache = new Map<string, number>();

const sonarrProfileCache = new Map<string | undefined, number>();
const sonarrFolderCache = new Map<string | undefined, string>();
const sonarrTagCache = new Map<string, number>();

function httpError(status: number): string {
	if (status === 401 || status === 403) return `${status} — check your API token`;
	if (status === 404) return `${status} — check your base URL`;
	if (status >= 500) return `${status} — server error`;
	return String(status);
}

async function arrGet<T>(baseUrl: string, token: string, path: string, signal: AbortSignal): Promise<T> {
	const res = await fetch(`${baseUrl}/api/v3${path}`, { headers: { "X-Api-Key": token }, signal });
	if (!res.ok) throw new Error(`GET ${path}: ${httpError(res.status)}`);
	return res.json() as Promise<T>;
}

async function arrPost<T>(
	baseUrl: string,
	token: string,
	path: string,
	body: unknown,
	signal: AbortSignal,
): Promise<{ ok: boolean; status: number; data: T; text: string }> {
	const res = await fetch(`${baseUrl}/api/v3${path}`, {
		method: "POST",
		headers: { "X-Api-Key": token, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const text = await res.text();
	let data: T;
	try {
		data = JSON.parse(text) as T;
	} catch {
		data = {} as T;
	}
	return { ok: res.ok, status: res.status, data, text };
}

async function arrPut(baseUrl: string, token: string, path: string, body: unknown, signal: AbortSignal): Promise<void> {
	const res = await fetch(`${baseUrl}/api/v3${path}`, {
		method: "PUT",
		headers: { "X-Api-Key": token, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`PUT ${path}: ${httpError(res.status)} — ${text.slice(0, 200)}`);
	}
}

async function arrDelete(baseUrl: string, token: string, path: string, signal: AbortSignal): Promise<void> {
	const res = await fetch(`${baseUrl}/api/v3${path}`, {
		method: "DELETE",
		headers: { "X-Api-Key": token },
		signal,
	});
	if (!res.ok) throw new Error(`DELETE ${path}: ${httpError(res.status)}`);
}

async function getProfileId(
	cache: Map<string | undefined, number>,
	baseUrl: string,
	token: string,
	name: string | undefined,
	timeoutMs: number,
): Promise<number> {
	if (cache.has(name)) return cache.get(name)!;
	const profiles = await arrGet<ArrQualityProfile[]>(baseUrl, token, "/qualityprofile", AbortSignal.timeout(timeoutMs));
	if (!profiles.length) throw new Error("no quality profiles found");
	let id: number;
	if (!name) {
		const first = profiles[0]!;
		log.info(`using default quality profile: "${first.name}"`);
		id = first.id;
	} else {
		const match = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
		if (!match) throw new Error(`quality profile "${name}" not found — available: ${profiles.map((p) => p.name).join(", ")}`);
		id = match.id;
	}
	cache.set(name, id);
	return id;
}

async function getFolderPath(
	cache: Map<string | undefined, string>,
	baseUrl: string,
	token: string,
	path: string | undefined,
	timeoutMs: number,
): Promise<string> {
	if (cache.has(path)) return cache.get(path)!;
	const folders = await arrGet<ArrRootFolder[]>(baseUrl, token, "/rootfolder", AbortSignal.timeout(timeoutMs));
	if (!folders.length) throw new Error("no root folders configured");
	let resolved: string;
	if (!path) {
		const first = folders[0]!;
		log.info(`using default root folder: "${first.path}"`);
		resolved = first.path;
	} else {
		const match = folders.find((f) => f.path === path);
		if (!match) throw new Error(`root folder "${path}" not found — available: ${folders.map((f) => f.path).join(", ")}`);
		resolved = match.path;
	}
	cache.set(path, resolved);
	return resolved;
}

async function getTagId(cache: Map<string, number>, baseUrl: string, token: string, name: string, timeoutMs: number): Promise<number> {
	const key = name.toLowerCase();
	if (cache.has(key)) return cache.get(key)!;
	const tags = await arrGet<ArrTag[]>(baseUrl, token, "/tag", AbortSignal.timeout(timeoutMs));
	const existing = tags.find((t) => t.label.toLowerCase() === key);
	let id: number;
	if (existing) {
		id = existing.id;
	} else {
		const result = await arrPost<ArrTag>(baseUrl, token, "/tag", { label: name }, AbortSignal.timeout(timeoutMs));
		if (!result.ok) throw new Error(`failed to create tag "${name}": ${result.text.slice(0, 200)}`);
		log.info(`created tag "${name}" (id: ${result.data.id})`);
		id = result.data.id;
	}
	cache.set(key, id);
	return id;
}

async function resolveTagIds(cache: Map<string, number>, names: string[], baseUrl: string, token: string, timeoutMs: number): Promise<number[]> {
	const ids: number[] = [];
	for (const name of names) {
		ids.push(await getTagId(cache, baseUrl, token, name, timeoutMs));
	}
	return ids;
}

export async function fetchRadarrMovies(url: string, token: string, timeoutMs: number): Promise<RadarrMovie[]> {
	return arrGet<RadarrMovie[]>(url, token, "/movie", AbortSignal.timeout(timeoutMs));
}

async function addToRadarr(movie: LbMovie, cfg: ArrSyncConfig): Promise<void> {
	const profileName = movie.profile ?? cfg.qualityProfile;
	const folderPath = movie.root_folder ?? cfg.rootFolder;
	const profileId = await getProfileId(radarrProfileCache, cfg.url, cfg.token, profileName, cfg.timeoutMs);
	const rootFolder = await getFolderPath(radarrFolderCache, cfg.url, cfg.token, folderPath, cfg.timeoutMs);

	const tagNames = [...(cfg.masterTag ? [cfg.masterTag] : []), ...(movie.tags ?? [])];
	const tagIds = tagNames.length ? await resolveTagIds(radarrTagCache, tagNames, cfg.url, cfg.token, cfg.timeoutMs) : [];

	const results = await arrGet<RadarrMovie[]>(cfg.url, cfg.token, `/movie/lookup/tmdb?tmdbId=${movie.tmdbId}`, AbortSignal.timeout(cfg.timeoutMs));
	const found = results[0];
	if (!found) throw new Error(`no Radarr lookup result for TMDb ID ${movie.tmdbId}`);

	if (cfg.dryRun) {
		log.info(`[dry-run] radarr: would add "${found.title}" (${found.year})`);
		return;
	}

	const result = await arrPost<{ id: number }>(
		cfg.url,
		cfg.token,
		"/movie",
		{
			...found,
			qualityProfileId: profileId,
			rootFolderPath: rootFolder,
			monitored: true,
			tags: tagIds,
			addOptions: { searchForMovie: true },
		},
		AbortSignal.timeout(cfg.timeoutMs),
	);

	if (!result.ok) throw new Error(`radarr add failed (${result.status}): ${result.text.slice(0, 200)}`);
	log.info(`radarr: added "${found.title}" (${found.year})`);
}

async function untagRadarrMovie(movie: RadarrMovie, tagId: number, cfg: ArrSyncConfig): Promise<void> {
	if (!movie.tags.includes(tagId)) return;
	if (cfg.dryRun) {
		log.info(`[dry-run] radarr: would remove managed tag from "${movie.title}"`);
		return;
	}
	await arrPut(cfg.url, cfg.token, `/movie/${movie.id}`, { ...movie, tags: movie.tags.filter((t) => t !== tagId) }, AbortSignal.timeout(cfg.timeoutMs));
	log.info(`radarr: removed managed tag from "${movie.title}"`);
}

async function deleteRadarrMovie(movie: RadarrMovie, cfg: ArrSyncConfig): Promise<void> {
	if (cfg.dryRun) {
		log.info(`[dry-run] radarr: would delete "${movie.title}" (${movie.year})`);
		return;
	}
	await arrDelete(cfg.url, cfg.token, `/movie/${movie.id}`, AbortSignal.timeout(cfg.timeoutMs));
	log.info(`radarr: deleted "${movie.title}" (${movie.year})`);
}

async function untagSonarrSeries(series: SonarrSeries, tagId: number, cfg: ArrSyncConfig): Promise<void> {
	if (!series.tags.includes(tagId)) return;
	if (cfg.dryRun) {
		log.info(`[dry-run] sonarr: would remove managed tag from "${series.title}"`);
		return;
	}
	await arrPut(cfg.url, cfg.token, `/series/${series.id}`, { ...series, tags: series.tags.filter((t) => t !== tagId) }, AbortSignal.timeout(cfg.timeoutMs));
	log.info(`sonarr: removed managed tag from "${series.title}"`);
}

async function deleteSonarrSeries(series: SonarrSeries, cfg: ArrSyncConfig): Promise<void> {
	if (cfg.dryRun) {
		log.info(`[dry-run] sonarr: would delete "${series.title}" (${series.year ?? "?"})`);
		return;
	}
	await arrDelete(cfg.url, cfg.token, `/series/${series.id}`, AbortSignal.timeout(cfg.timeoutMs));
	log.info(`sonarr: deleted "${series.title}" (${series.year ?? "?"})`);
}

export async function fetchSonarrSeries(url: string, token: string, timeoutMs: number): Promise<SonarrSeries[]> {
	return arrGet<SonarrSeries[]>(url, token, "/series", AbortSignal.timeout(timeoutMs));
}

async function addToSonarr(series: SdSeries, cfg: ArrSyncConfig): Promise<void> {
	const profileName = series.profile ?? cfg.qualityProfile;
	const folderPath = series.root_folder ?? cfg.rootFolder;
	const profileId = await getProfileId(sonarrProfileCache, cfg.url, cfg.token, profileName, cfg.timeoutMs);
	const rootFolder = await getFolderPath(sonarrFolderCache, cfg.url, cfg.token, folderPath, cfg.timeoutMs);

	const tagNames = [...(cfg.masterTag ? [cfg.masterTag] : []), ...(series.tags ?? [])];
	const tagIds = tagNames.length ? await resolveTagIds(sonarrTagCache, tagNames, cfg.url, cfg.token, cfg.timeoutMs) : [];

	const results = await arrGet<SonarrSeries[]>(cfg.url, cfg.token, `/series/lookup?term=tmdb:${series.tmdbId}`, AbortSignal.timeout(cfg.timeoutMs));
	const found = results[0];
	if (!found) throw new Error(`no Sonarr lookup result for TMDb ID ${series.tmdbId}`);

	const seasons = (found.seasons ?? []).map((s) => ({
		...s,
		monitored: series.seasons.length === 0 || series.seasons.includes(s.seasonNumber),
	}));

	if (cfg.dryRun) {
		const monitored = series.seasons.length === 0 ? "all seasons" : `seasons ${series.seasons.join(", ")}`;
		log.info(`[dry-run] sonarr: would add "${found.title}" (${found.year ?? "?"}) [${monitored}]`);
		return;
	}

	const result = await arrPost<{ id: number }>(
		cfg.url,
		cfg.token,
		"/series",
		{
			...found,
			qualityProfileId: profileId,
			rootFolderPath: rootFolder,
			monitored: true,
			tags: tagIds,
			seasons,
			addOptions: { searchForMissingEpisodes: true },
		},
		AbortSignal.timeout(cfg.timeoutMs),
	);

	if (!result.ok) throw new Error(`sonarr add failed (${result.status}): ${result.text.slice(0, 200)}`);
	log.info(`sonarr: added "${found.title}" (${found.year ?? "?"})`);
}

export async function syncRadarr(desired: LbMovie[], allMovies: RadarrMovie[], cfg: ArrSyncConfig): Promise<void> {
	const byTmdb = new Map(allMovies.map((m) => [m.tmdbId, m]));
	const desiredSet = new Set(desired.map((m) => m.tmdbId));

	let tagId: number | undefined;
	if (cfg.masterTag) {
		tagId = await getTagId(radarrTagCache, cfg.url, cfg.token, cfg.masterTag, cfg.timeoutMs).catch((err) => {
			log.warn("radarr: failed to resolve master tag:", toStr(err));
			return undefined;
		});
	}

	let added = 0;
	for (const movie of desired) {
		if (byTmdb.has(movie.tmdbId)) continue;
		try {
			await addToRadarr(movie, cfg);
			added++;
		} catch (err) {
			log.warn(`radarr: failed for "${movie.title}" (tmdb:${movie.tmdbId}):`, toStr(err));
		}
	}

	let orphans = 0;
	if (tagId !== undefined) {
		for (const movie of allMovies) {
			if (!movie.tags.includes(tagId) || desiredSet.has(movie.tmdbId)) continue;
			try {
				if (cfg.deleteOrphans) {
					await deleteRadarrMovie(movie, cfg);
				} else {
					await untagRadarrMovie(movie, tagId, cfg);
				}
				orphans++;
			} catch (err) {
				log.warn(`radarr: failed to handle orphan "${movie.title}":`, toStr(err));
			}
		}
	}

	log.info(`radarr: +${added} added${orphans ? `, ${orphans} orphans ${cfg.deleteOrphans ? "deleted" : "untagged"}` : ""}`);
}

export async function syncSonarr(desired: SdSeries[], allSeries: SonarrSeries[], cfg: ArrSyncConfig): Promise<void> {
	const byTmdb = new Map(allSeries.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s]));
	const desiredSet = new Set(desired.map((s) => s.tmdbId));

	let tagId: number | undefined;
	if (cfg.masterTag) {
		tagId = await getTagId(sonarrTagCache, cfg.url, cfg.token, cfg.masterTag, cfg.timeoutMs).catch((err) => {
			log.warn("sonarr: failed to resolve master tag:", toStr(err));
			return undefined;
		});
	}

	let added = 0;
	for (const series of desired) {
		if (byTmdb.has(series.tmdbId)) continue;
		try {
			await addToSonarr(series, cfg);
			added++;
		} catch (err) {
			log.warn(`sonarr: failed for "${series.title}" (tmdb:${series.tmdbId}):`, toStr(err));
		}
	}

	let orphans = 0;
	if (tagId !== undefined) {
		for (const series of allSeries) {
			if (!series.tmdbId) continue; // no identity — never treat as orphan
			if (!series.tags.includes(tagId) || desiredSet.has(series.tmdbId)) continue;
			try {
				if (cfg.deleteOrphans) {
					await deleteSonarrSeries(series, cfg);
				} else {
					await untagSonarrSeries(series, tagId, cfg);
				}
				orphans++;
			} catch (err) {
				log.warn(`sonarr: failed to handle orphan "${series.title}":`, toStr(err));
			}
		}
	}

	log.info(`sonarr: +${added} added${orphans ? `, ${orphans} orphans ${cfg.deleteOrphans ? "deleted" : "untagged"}` : ""}`);
}
