import { writeFileSync } from "node:fs";
import { log, toStr } from "./log.ts";

export const HEALTH_FILE = "/tmp/lettarrboxd.health";

export function markHealthy(staleAfterMs: number): void {
	try {
		const now = Date.now();
		const stale = now + staleAfterMs;
		writeFileSync(HEALTH_FILE, `${stale}`);
	} catch (err) {
		log.warn("failed to write health file:", toStr(err));
	}
}
