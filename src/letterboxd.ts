import * as cheerio from "cheerio";
import { log, toStr } from "./log.ts";
import { getCachedFilm, setCachedFilm } from "./cache.ts";
import type { ListConfig } from "./config.ts";

export interface LbListInput extends ListConfig {
	url: string;
}

export interface LbMovie extends ListConfig {
	tmdbId: number;
	title: string;
}

const LB_BASE = "https://letterboxd.com";
const FETCH_DELAY_MS = 600;

async function fetchHtml(url: string, signal: AbortSignal): Promise<string> {
	const res = await fetch(url, {
		signal,
		headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
	return res.text();
}

function prepareUrl(url: string): string {
	const clean = url.replace(/\/$/, "");
	if (clean.includes("/films/in/")) return clean.replace("/films/in/", "/films/ajax/in/") + "/";
	if (clean.endsWith("/films/popular")) return `${LB_BASE}/films/ajax/popular/`;
	return clean + "/";
}

function extractFilmPaths(html: string): string[] {
	const $ = cheerio.load(html);
	const paths: string[] = [];

	$(".react-component[data-target-link]").each((_, el) => {
		const link = $(el).attr("data-target-link");
		if (link) paths.push(link);
	});

	if (!paths.length) {
		$(".poster-container div[data-target-link], .posteritem div[data-target-link]").each((_, el) => {
			const link = $(el).attr("data-target-link");
			if (link) paths.push(link);
		});
	}

	return paths;
}

function nextPageUrl(html: string): string | null {
	const $ = cheerio.load(html);
	const href = $(".paginate-nextprev .next").attr("href");
	return href ? new URL(href, LB_BASE).toString() : null;
}

async function resolveFilmDetails(filmPath: string, signal: AbortSignal): Promise<{ tmdbId: number; title: string } | undefined> {
	const slug = filmPath.replace(/^\/film\//, "").replace(/\/$/, "");
	const html = await fetchHtml(new URL(filmPath, LB_BASE).toString(), signal);
	const $ = cheerio.load(html);

	const title = $(".primaryname").first().text().trim() || slug;
	const tmdbHref = $('a[data-track-action="TMDB"]').attr("href") ?? "";
	const match = /\/movie\/(\d+)/.exec(tmdbHref);
	if (!match?.[1]) {
		log.debug(`letterboxd: no TMDb link on "${filmPath}"`);
		return undefined;
	}

	const tmdbId = parseInt(match[1], 10);
	setCachedFilm(slug, tmdbId, title);
	return { tmdbId, title };
}

export async function scrapeLetterboxd(lists: LbListInput[], timeoutMs: number): Promise<LbMovie[]> {
	// Keyed by tmdbId. First list wins for profile/root_folder; tags are merged across lists.
	const movieMap = new Map<number, LbMovie>();

	for (const list of lists) {
		const startUrl = prepareUrl(list.url);
		log.info(`letterboxd: scraping "${list.url}"`);

		const filmPaths = new Set<string>();
		let pageUrl: string | null = startUrl;
		let page = 0;

		while (pageUrl) {
			page++;
			try {
				const html = await fetchHtml(pageUrl, AbortSignal.timeout(timeoutMs));
				const found = extractFilmPaths(html);
				for (const p of found) filmPaths.add(p);
				log.debug(`letterboxd: page ${page} → ${found.length} films (total: ${filmPaths.size})`);
				pageUrl = nextPageUrl(html);
			} catch (err) {
				log.warn(`letterboxd: failed on page ${page} of "${list.url}":`, toStr(err));
				break;
			}
		}

		log.info(`letterboxd: ${filmPaths.size} films in "${list.url}", resolving TMDb IDs…`);

		const { profile, root_folder, tags } = list;

		for (const filmPath of filmPaths) {
			const slug = filmPath.replace(/^\/film\//, "").replace(/\/$/, "");
			const cached = getCachedFilm(slug);

			let resolved: { tmdbId: number; title: string } | undefined;
			if (cached) {
				resolved = cached;
			} else {
				await Bun.sleep(FETCH_DELAY_MS);
				try {
					resolved = (await resolveFilmDetails(filmPath, AbortSignal.timeout(timeoutMs))) ?? undefined;
					if (!resolved) {
						log.debug(`letterboxd: no TMDb ID for "${filmPath}" — skipping`);
						continue;
					}
				} catch (err) {
					log.warn(`letterboxd: failed resolving "${filmPath}":`, toStr(err));
					continue;
				}
			}

			const existing = movieMap.get(resolved.tmdbId);
			if (existing) {
				// Merge tags; first-seen list keeps profile/root_folder
				const merged = [...new Set([...(existing.tags ?? []), ...(tags ?? [])])];
				movieMap.set(resolved.tmdbId, { ...existing, tags: merged.length ? merged : undefined });
			} else {
				movieMap.set(resolved.tmdbId, { ...resolved, profile, root_folder, tags });
			}
		}
	}

	const movies = [...movieMap.values()];
	log.info(`letterboxd: ${movies.length} unique movies total`);
	return movies;
}
