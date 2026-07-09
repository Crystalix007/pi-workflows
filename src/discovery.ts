import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Resolved {
	code: string;
	path?: string;
}

const GLOBAL_DIR = join(homedir(), ".pi", "agent", "workflows");
const PROJECT_DIR = ".pi/workflows";

let fileCache: Map<string, string> | null = null;

function scan(): Map<string, string> {
	if (fileCache) return fileCache;
	fileCache = new Map();
	for (const dir of [PROJECT_DIR, GLOBAL_DIR]) {
		try {
			scanDir(dir, fileCache);
		} catch {
			/* dir may not exist — silently skip */
		}
	}
	return fileCache;
}

function scanDir(dir: string, map: Map<string, string>): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			scanDir(full, map);
		} else if (entry.isFile() && entry.name.endsWith(".lua")) {
			const name = entry.name.slice(0, -4); // strip ".lua"
			if (!map.has(name)) map.set(name, full); // first-found wins
		}
	}
}

/**
 * Resolve a workflow name to source code.
 * Priority: inline-bundle (sibling) → on-disk.
 */
export function resolve(
	name: string,
	inlineBundle?: Record<string, string>,
): Resolved {
	if (inlineBundle?.[name] !== undefined) {
		return { code: inlineBundle[name] };
	}
	const files = scan();
	const path = files.get(name);
	if (path) {
		return { code: readFileSync(path, "utf8"), path };
	}
	throw new Error(
		`Workflow not found: "${name}". Expected a .lua file in ${PROJECT_DIR}/ or ${GLOBAL_DIR}/.`,
	);
}

/** Return inline source directly (no resolution). */
export function resolveInline(code: string): Resolved {
	return { code };
}

/** Invalidate the file cache (call on /reload). */
export function invalidateCache(): void {
	fileCache = null;
}
