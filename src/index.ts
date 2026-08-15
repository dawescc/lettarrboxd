import { scrapeLetterboxd } from "./letterboxd.ts";
import { scrapeSerializd } from "./serializd.ts";
import { fetchRadarrMovies, fetchSonarrSeries, syncRadarr, syncSonarr } from "./arr.ts";
import type { RadarrMovie, SonarrSeries } from "./arr.ts";
import type { LbMovie } from "./letterboxd.ts";
import type { SdSeries } from "./serializd.ts";
import { initCache } from "./cache.ts";
import { loadRuntimeConfig } from "./config.ts";
import { markHealthy } from "./health.ts";
import { log, toStr as baseToStr } from "./log.ts";

const cfg = loadRuntimeConfig();
const HEALTH_STALE_AFTER_MS = cfg.intervalMs * 2 + 5 * 60_000;

log.info("starting lettarrboxd");
if (cfg.radarr) log.info(`radarr: ${cfg.radarr.url} (token: configured)`);
if (cfg.sonarr) log.info(`sonarr: ${cfg.sonarr.url} (token: configured)`);
if (cfg.movieLists.length) log.info(`movie lists (${cfg.movieLists.length}): ${cfg.movieLists.map((l) => l.url).join(", ")}`);
if (cfg.tvLists.length) log.info(`tv lists    (${cfg.tvLists.length}): ${cfg.tvLists.map((l) => l.path).join(", ")}`);
if (cfg.radarr?.masterTag) log.info(`master tag: "${cfg.radarr.masterTag}"`);
if (cfg.radarr?.deleteOrphans || cfg.sonarr?.deleteOrphans) log.info("delete orphans: enabled");
log.info(`sync every ${cfg.intervalMs / 60_000}m, timeout ${cfg.timeoutMs / 1000}s${cfg.dryRun ? ", DRY RUN" : ""}`);

try {
	initCache(cfg.dbPath);
} catch (err) {
	log.error("failed to initialize cache:", err);
	process.exit(1);
}

function toStr(err: unknown): string {
	if (err instanceof DOMException && err.name === "TimeoutError") return `request timed out after ${cfg.timeoutMs / 1000}s`;
	return baseToStr(err);
}

async function run(): Promise<void> {
	log.info("sync started");

	const [lbResult, sdResult, radarrResult, sonarrResult] = await Promise.allSettled([
		cfg.movieLists.length ? scrapeLetterboxd(cfg.movieLists, cfg.timeoutMs) : Promise.resolve<LbMovie[]>([]),
		cfg.tvLists.length ? scrapeSerializd(cfg.tvLists, cfg.timeoutMs) : Promise.resolve<SdSeries[]>([]),
		cfg.radarr ? fetchRadarrMovies(cfg.radarr.url, cfg.radarr.token, cfg.timeoutMs) : Promise.resolve<RadarrMovie[]>([]),
		cfg.sonarr ? fetchSonarrSeries(cfg.sonarr.url, cfg.sonarr.token, cfg.timeoutMs) : Promise.resolve<SonarrSeries[]>([]),
	]);

	if (lbResult.status === "rejected") log.warn("letterboxd scrape failed:", toStr(lbResult.reason));
	if (sdResult.status === "rejected") log.warn("serializd scrape failed:", toStr(sdResult.reason));
	if (cfg.radarr && radarrResult.status === "rejected") log.warn("radarr fetch failed:", toStr(radarrResult.reason));
	if (cfg.sonarr && sonarrResult.status === "rejected") log.warn("sonarr fetch failed:", toStr(sonarrResult.reason));

	const desiredMovies = lbResult.status === "fulfilled" ? lbResult.value : [];
	const desiredSeries = sdResult.status === "fulfilled" ? sdResult.value : [];
	const allMovies = radarrResult.status === "fulfilled" ? radarrResult.value : undefined;
	const allSeries = sonarrResult.status === "fulfilled" ? sonarrResult.value : undefined;

	log.info(`desired: ${desiredMovies.length} movies, ${desiredSeries.length} series`);

	await Promise.all([
		cfg.radarr && allMovies ? syncRadarr(desiredMovies, allMovies, cfg.radarr) : Promise.resolve(),
		cfg.sonarr && allSeries ? syncSonarr(desiredSeries, allSeries, cfg.sonarr) : Promise.resolve(),
	]);

	log.info("sync complete");
	log.info(`next sync at ${new Date(Date.now() + cfg.intervalMs).toISOString()}`);
	markHealthy(HEALTH_STALE_AFTER_MS);
}

const tick = () => run().catch((err) => log.error("sync failed:", toStr(err)));

tick();
setInterval(tick, cfg.intervalMs);
