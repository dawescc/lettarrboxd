const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
type Level = keyof typeof LEVELS;

const envLevel = process.env["LOG_LEVEL"]?.toUpperCase() as Level | undefined;
const current = LEVELS[envLevel ?? "WARN"] ?? LEVELS.WARN;

function emit(level: Level, ...args: unknown[]): void {
	if (LEVELS[level] < current) return;
	const ts = new Date().toISOString();
	const line = `${ts} [${level}]`;
	if (level === "ERROR") console.error(line, ...args);
	else if (level === "WARN") console.warn(line, ...args);
	else console.log(line, ...args);
}

export const log = {
	debug: (...args: unknown[]) => emit("DEBUG", ...args),
	info: (...args: unknown[]) => emit("INFO", ...args),
	warn: (...args: unknown[]) => emit("WARN", ...args),
	error: (...args: unknown[]) => emit("ERROR", ...args),
};

export function toStr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
