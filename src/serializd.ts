import { log, toStr } from "./log.ts";
import type { ListConfig } from "./config.ts";

export interface SdListInput extends ListConfig {
	path: string;
}

export interface SdSeries extends ListConfig {
	tmdbId: number;
	title: string;
	seasons: number[]; // empty = all seasons; otherwise specific season numbers to monitor
}

const SD_API = "https://serializd.onrender.com";
const SD_HEADERS = {
	"X-Requested-With": "serializd_vercel",
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function retry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i < retries; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < retries - 1) {
				const delay = Math.min(2000 * Math.pow(2, i), 15000);
				log.warn(`serializd: ${label} failed, retrying in ${delay / 1000}s (attempt ${i + 2}/${retries})`);
				await Bun.sleep(delay);
			}
		}
	}
	throw lastErr;
}

// In-process cache: showId → (serializdSeasonId → seasonNumber)
const showSeasonCache = new Map<number, Map<number, number>>();

interface WatchlistPage {
	items: SerializdItem[];
	totalPages: number;
}

interface SerializdItem {
	showId?: number;
	show_id?: number;
	showName?: string;
	show_name?: string;
	name?: string;
	title?: string;
	seasonIds?: number[];
	season_ids?: number[];
	seasonId?: number;
}

interface ShowDetails {
	seasons: Array<{ id: number; seasonNumber: number }>;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
	const res = await fetch(url, { headers: SD_HEADERS, signal });
	if (!res.ok) {
		if (res.status === 404) throw new Error(`not found: ${url}`);
		if (res.status === 401 || res.status === 403) throw new Error(`auth error: ${url}`);
		throw new Error(`HTTP ${res.status}: ${url}`);
	}
	return res.json() as Promise<T>;
}

function extractItems(data: unknown, fields: string[]): SerializdItem[] {
	if (Array.isArray(data)) return data as SerializdItem[];
	if (!data || typeof data !== "object") return [];
	const d = data as Record<string, unknown>;
	for (const f of fields) {
		const v = d[f];
		if (Array.isArray(v)) return v as SerializdItem[];
	}
	return [];
}

function mapItem(raw: SerializdItem): { showId: number; showName: string; seasonIds: number[] } | null {
	const showId = raw.showId ?? raw.show_id;
	if (!showId) return null;
	const seasonIds = raw.seasonIds ?? raw.season_ids ?? (raw.seasonId != null ? [raw.seasonId] : []);
	return {
		showId,
		showName: raw.showName ?? raw.show_name ?? raw.name ?? raw.title ?? "Unknown",
		seasonIds,
	};
}

async function resolveSeasons(showId: number, seasonIds: number[], timeoutMs: number): Promise<number[]> {
	if (!seasonIds.length) return [];

	let cache = showSeasonCache.get(showId);
	if (!cache) {
		try {
			const details = await retry(
				() => fetchJson<ShowDetails>(`${SD_API}/api/show/${showId}`, AbortSignal.timeout(timeoutMs)),
				`show details for ${showId}`,
			);
			cache = new Map(details.seasons.map((s) => [s.id, s.seasonNumber]));
			showSeasonCache.set(showId, cache);
		} catch (err) {
			log.warn(`serializd: failed to fetch show details for ${showId}:`, toStr(err));
			return [];
		}
	}

	return seasonIds.flatMap((sid) => {
		const n = cache!.get(sid);
		return n !== undefined ? [n] : [];
	});
}

async function fetchWatchlist(username: string, timeoutMs: number): Promise<SerializdItem[]> {
	const base = `${SD_API}/api/user/${username}/watchlistpage_v2`;
	const all: SerializdItem[] = [];
	let page = 1;
	let totalPages = 1;

	do {
		const data = await retry(
			() => fetchJson<WatchlistPage>(`${base}/${page}?sort_by=date_added_desc`, AbortSignal.timeout(timeoutMs)),
			`watchlist page ${page} for ${username}`,
		);
		totalPages = data.totalPages;
		if (data.items) all.push(...data.items);
		page++;
		if (page <= totalPages) await Bun.sleep(500);
	} while (page <= totalPages);

	return all;
}

async function fetchUserList(username: string, slug: string, timeoutMs: number): Promise<SerializdItem[]> {
	const data = await retry(
		() => fetchJson<unknown>(`${SD_API}/api/user/${username}/list/${slug}`, AbortSignal.timeout(timeoutMs)),
		`user list ${username}/${slug}`,
	);
	return extractItems(data, ["shows", "items", "entries"]);
}

async function fetchPublicList(slug: string, timeoutMs: number): Promise<SerializdItem[]> {
	const idMatch = /(\d+)$/.exec(slug);
	const listId = idMatch?.[1] ?? slug;
	const data = await retry(
		() => fetchJson<unknown>(`${SD_API}/api/list/${listId}`, AbortSignal.timeout(timeoutMs)),
		`public list ${listId}`,
	);
	return extractItems(data, ["listItems", "shows", "items", "entries"]);
}

export async function scrapeSerializd(lists: SdListInput[], timeoutMs: number): Promise<SdSeries[]> {
	const seriesMap = new Map<number, SdSeries>();

	for (const list of lists) {
		const { profile, root_folder, tags } = list;
		log.info(`serializd: fetching "${list.path}"`);

		let path: string;
		try {
			path = new URL(list.path).pathname;
		} catch {
			log.warn(`serializd: invalid URL "${list.path}" — skipping`);
			continue;
		}

		const watchlistMatch = /\/user\/([^/]+)\/watchlist/.exec(path);
		const userListMatch = /\/user\/([^/]+)\/lists\/([^/?]+)/.exec(path);
		const publicListMatch = /\/list\/([^/?]+)/.exec(path);

		let rawItems: SerializdItem[];
		try {
			if (watchlistMatch) {
				rawItems = await fetchWatchlist(watchlistMatch[1]!, timeoutMs);
			} else if (userListMatch) {
				rawItems = await fetchUserList(userListMatch[1]!, userListMatch[2]!, timeoutMs);
			} else if (publicListMatch) {
				rawItems = await fetchPublicList(publicListMatch[1]!, timeoutMs);
			} else {
				log.warn(`serializd: unrecognised URL "${list.path}" — expected /user/{u}/watchlist, /user/{u}/lists/{slug}, or /list/{slug}`);
				continue;
			}
			log.debug(`serializd: ${rawItems.length} items in "${path}"`);
		} catch (err) {
			log.warn(`serializd: failed fetching "${path}":`, toStr(err));
			continue;
		}

		for (const raw of rawItems) {
			const item = mapItem(raw);
			if (!item) continue;

			const tmdbId = item.showId;
			const seasons = await resolveSeasons(tmdbId, item.seasonIds, timeoutMs);

			const existing = seriesMap.get(tmdbId);
			if (existing) {
				// First list wins for profile/root_folder; seasons and tags are merged across lists.
				const mergedSeasons = [...new Set([...existing.seasons, ...seasons])];
				const mergedTags = [...new Set([...(existing.tags ?? []), ...(tags ?? [])])];
				seriesMap.set(tmdbId, {
					...existing,
					seasons: mergedSeasons,
					tags: mergedTags.length ? mergedTags : undefined,
				});
			} else {
				seriesMap.set(tmdbId, { tmdbId, title: item.showName, seasons, profile, root_folder, tags });
			}
		}
	}

	const result = [...seriesMap.values()];
	log.info(`serializd: ${result.length} unique series total`);
	return result;
}
