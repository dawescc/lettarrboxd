import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log, toStr } from "./log.ts";

let db: Database | undefined;

export function initCache(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	db = new Database(path);
	db.run(`
    CREATE TABLE IF NOT EXISTS film_tmdb (
      slug    TEXT PRIMARY KEY,
      tmdb_id INTEGER NOT NULL,
      title   TEXT NOT NULL DEFAULT ''
    )
  `);
}

export function getCachedFilm(slug: string): { tmdbId: number; title: string } | undefined {
	if (!db) throw new Error("cache not initialized");
	try {
		const row = db.query<{ tmdb_id: number; title: string }, [string]>("SELECT tmdb_id, title FROM film_tmdb WHERE slug = ?").get(slug);
		if (!row) return undefined;
		return { tmdbId: row.tmdb_id, title: row.title || slug };
	} catch (err) {
		log.warn(`cache read failed for ${slug}:`, toStr(err));
	}
}

export function setCachedFilm(slug: string, tmdbId: number, title: string): void {
	if (!db) throw new Error("cache not initialized");
	try {
		db.run("INSERT OR REPLACE INTO film_tmdb (slug, tmdb_id, title) VALUES (?, ?, ?)", [slug, tmdbId, title]);
	} catch (err) {
		log.warn(`cache write failed for ${slug}:`, toStr(err));
	}
}
