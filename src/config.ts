import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { log, toStr } from "./log.ts";
import type { ArrSyncConfig } from "./arr.ts";
import type { LbListInput } from "./letterboxd.ts";
import type { SdListInput } from "./serializd.ts";

// --- Per-list overrides (from YAML) ---

export interface ListConfig {
	profile?: string;
	root_folder?: string;
	tags?: string[];
}

// Flat URL → overrides map. Domain determines which service the URL belongs to.
export type AppConfig = Record<string, ListConfig>;

function parseListConfig(raw: unknown): ListConfig {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;

	const rawTags = r["tags"];
	const tags: string[] =
		typeof rawTags === "string"
			? rawTags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: Array.isArray(rawTags)
				? rawTags.map((t) => String(t).trim()).filter(Boolean)
				: [];

	return {
		...(typeof r["profile"] === "string" && r["profile"] ? { profile: r["profile"] } : {}),
		...(typeof r["root_folder"] === "string" && r["root_folder"] ? { root_folder: r["root_folder"] } : {}),
		...(tags.length ? { tags } : {}),
	};
}

function loadYamlConfig(configPath: string): AppConfig | undefined {
	let content: string;
	try {
		content = readFileSync(configPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn(`config: cannot read "${configPath}":`, toStr(err));
		}
		return undefined;
	}

	try {
		const raw = load(content);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			log.warn(`config: "${configPath}" must be a YAML mapping — ignored`);
			return undefined;
		}
		const out: AppConfig = {};
		for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
			const host = getHostname(key);
			if (!host) {
				log.warn(`config: invalid source URL "${key}" — skipping`);
				continue;
			}
			if (host === "letterboxd.com" || host === "serializd.com") {
				out[key] = parseListConfig(val);
			} else {
				log.warn(`config: unsupported source URL "${key}" — expected letterboxd.com or serializd.com, skipping`);
			}
		}
		return out;
	} catch (err) {
		log.warn(`config: failed to parse "${configPath}":`, toStr(err));
		return undefined;
	}
}

// --- Full runtime config ---

export interface RuntimeConfig {
	movieLists: LbListInput[];
	tvLists: SdListInput[];
	radarr: ArrSyncConfig | undefined;
	sonarr: ArrSyncConfig | undefined;
	dbPath: string;
	intervalMs: number;
	timeoutMs: number;
	dryRun: boolean;
}

function getHostname(url: string): string | undefined {
	try {
		const host = new URL(url).hostname;
		return host.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

function parseMinutesToMs(raw: string | undefined, fallback: number, min: number): number {
	const n = parseInt(raw ?? "");
	return (isNaN(n) || n < min ? fallback : n) * 60_000;
}

function parseSecondsToMs(raw: string | undefined, fallback: number, min: number): number {
	const n = parseInt(raw ?? "");
	return (isNaN(n) || n < min ? fallback : n) * 1000;
}

export function loadRuntimeConfig(): RuntimeConfig {
	const env = process.env;

	const configPath = env["CONFIG_PATH"] ?? "/data/config.yaml";
	const dbPath = env["DB_PATH"] ?? "/data/lettarrboxd.db";
	const dryRun = env["DRY_RUN"] === "true";
	const intervalMs = parseMinutesToMs(env["SYNC_INTERVAL"], 60, 1);
	const timeoutMs = parseSecondsToMs(env["FETCH_TIMEOUT"], 30, 5);

	const masterTag = env["MASTER_TAG"] || undefined;
	const deleteOrphans = env["DELETE_ORPHANS"] === "true";

	const radarrUrl = env["RADARR_URL"];
	const radarrToken = env["RADARR_TOKEN"];
	const sonarrUrl = env["SONARR_URL"];
	const sonarrToken = env["SONARR_TOKEN"];

	const yaml = loadYamlConfig(configPath);
	if (yaml) log.info(`config: loaded "${configPath}" (${Object.keys(yaml).length} lists)`);

	// If config.yaml is present its URLs are the source of truth; domain determines service.
	// Otherwise fall back to the LETTERBOXD_LISTS / SERIALIZD_LISTS env vars.
	function parseMovieListUrls(raw: string | undefined): LbListInput[] {
		if (!raw) return [];
		const urls = raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const out: LbListInput[] = [];
		for (const url of urls) {
			const host = getHostname(url);
			if (!host) {
				log.warn(`config: invalid movie list URL "${url}" — skipping`);
				continue;
			}
			if (host !== "letterboxd.com") {
				log.warn(`config: unsupported movie list URL "${url}" — expected letterboxd.com, skipping`);
				continue;
			}
			out.push({ url });
		}
		return out;
	}

	function parseTvListUrls(raw: string | undefined): SdListInput[] {
		if (!raw) return [];
		const urls = raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const out: SdListInput[] = [];
		for (const url of urls) {
			const host = getHostname(url);
			if (!host) {
				log.warn(`config: invalid TV list URL "${url}" — skipping`);
				continue;
			}
			if (host !== "serializd.com") {
				log.warn(`config: unsupported TV list URL "${url}" — expected serializd.com, skipping`);
				continue;
			}
			out.push({ path: url });
		}
		return out;
	}

	const movieLists: LbListInput[] = yaml
		? Object.entries(yaml)
				.filter(([url]) => getHostname(url) === "letterboxd.com")
				.map(([url, cfg]) => ({ url, ...cfg }))
		: parseMovieListUrls(env["LETTERBOXD_LISTS"]);

	const tvLists: SdListInput[] = yaml
		? Object.entries(yaml)
				.filter(([url]) => getHostname(url) === "serializd.com")
				.map(([url, cfg]) => ({ path: url, ...cfg }))
		: parseTvListUrls(env["SERIALIZD_LISTS"]);

	const radarr: ArrSyncConfig | undefined =
		radarrUrl && radarrToken
			? {
					url: radarrUrl,
					token: radarrToken,
					masterTag,
					qualityProfile: env["QUAL_PROF_MOVIES"] || undefined,
					rootFolder: env["RADARR_ROOT_FOLDER"] || undefined,
					dryRun,
					timeoutMs,
					deleteOrphans,
				}
			: undefined;

	const sonarr: ArrSyncConfig | undefined =
		sonarrUrl && sonarrToken
			? {
					url: sonarrUrl,
					token: sonarrToken,
					masterTag,
					qualityProfile: env["QUAL_PROF_SERIES"] || undefined,
					rootFolder: env["SONARR_ROOT_FOLDER"] || undefined,
					dryRun,
					timeoutMs,
					deleteOrphans,
				}
			: undefined;

	// Emit configuration warnings
	if (radarrUrl && !radarrToken) log.warn("RADARR_URL set but RADARR_TOKEN missing — Radarr skipped");
	if (radarrToken && !radarrUrl) log.warn("RADARR_TOKEN set but RADARR_URL missing — Radarr skipped");
	if (sonarrUrl && !sonarrToken) log.warn("SONARR_URL set but SONARR_TOKEN missing — Sonarr skipped");
	if (sonarrToken && !sonarrUrl) log.warn("SONARR_TOKEN set but SONARR_URL missing — Sonarr skipped");
	if (movieLists.length && !radarr) log.warn("movie lists configured but Radarr not enabled — movies will not be added");
	if (tvLists.length && !sonarr) log.warn("TV lists configured but Sonarr not enabled — series will not be added");
	if (!movieLists.length && !tvLists.length) log.warn("no lists configured — nothing to scrape");

	return { movieLists, tvLists, radarr, sonarr, dbPath, intervalMs, timeoutMs, dryRun };
}
