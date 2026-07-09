/**
 * Optional pi-todo integration — a self-contained SQLite wrapper that uses the
 * same todo.db as the pi-todo extension.
 *
 * If pi-todo is installed, the todo() Lua primitive becomes available in
 * workflows.  If not, or if node:sqlite is unavailable, todo() returns a
 * helpful error message.
 */
import { homedir } from "node:os";
import { join } from "node:path";

// node:sqlite is built-in from Node 22.5+.
let DatabaseSync: any;
try {
	const mod = await import("node:sqlite");
	DatabaseSync = (mod as any).DatabaseSync;
} catch {
	// node:sqlite not available — todo() will be a stub.
}

const DB_PATH = join(homedir(), ".pi", "agent", "todo.db");

// ---- known-schema SQL helpers (mirror pi-todo's schema) ----

function requireDb(): any {
	if (!DatabaseSync) throw new Error("node:sqlite is not available (Node ≥22.5 required).");
	const db = new DatabaseSync(DB_PATH);
	db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
	return db;
}

function ensureList(db: any, scope: string | undefined, name: string, title?: string): number {
	const s = scope != null && scope.length > 0 ? scope : "";
	const existing = db.prepare("SELECT id FROM lists WHERE scope=? AND name=?").get(s, name);
	if (existing) return (existing as any).id;
	const ts = Date.now();
	const row = db.prepare(
		"INSERT INTO lists (scope, name, title, created_at, updated_at) VALUES (?,?,?,?,?)",
	).run(s, name, title ?? null, ts, ts);
	return Number(row.lastInsertRowid);
}

function getListId(db: any, scope: string, name: string): number {
	const s = scope != null && scope.length > 0 ? scope : "";
	const row = db.prepare("SELECT id FROM lists WHERE scope=? AND name=?").get(s, name);
	if (!row) throw new Error(`Todo list '${s ? `${s}/` : ""}${name}' not found.`);
	return (row as any).id;
}

// ---- public API (each returns a details object, mirroring pi-todo's shape) ----

export interface TodoResult {
	details: Record<string, unknown>;
	action: string;
}

export async function callTodo(action: string, params: Record<string, unknown> = {}): Promise<TodoResult> {
	if (!DatabaseSync) throw new Error("pi-todo is not installed or node:sqlite is unavailable. Install pi-todo to use the todo() primitive.");
	const db = requireDb();
	try {
		switch (action) {
			case "lists": return listLists(db);
			case "create": return createList(db, params);
			case "add": return addTasks(db, params);
			case "next": return nextTask(db, params);
			case "update": return updateTask(db, params);
			case "show": return showList(db, params);
			case "purge": return purgeDone(db, params);
			case "move": return moveTask(db, params);
			case "delete": return deleteTask(db, params);
			default: throw new Error(`Unknown todo action '${action}'. Supported: lists, create, add, next, update, show, purge, move, delete.`);
		}
	} finally {
		try { db.close(); } catch { /* noop */ }
	}
}

function listLists(db: any): TodoResult {
	const lists = db.prepare("SELECT scope, name, title, created_at FROM lists ORDER BY updated_at DESC").all();
	return {
		action: "lists",
		details: { action: "lists", lists: (lists as any[]).map(l => ({ ...l, path: l.scope ? `${l.scope}/${l.name}` : l.name })) },
	};
}

function createList(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const id = ensureList(db, scope, name, p.title as string | undefined);
	const tasks = fetchTree(db, id);
	const counts = countsOf(tasks);
	return {
		action: "create",
		details: { action: "create", list: { scope: scope ?? "", name, path, title: p.title ?? null }, tree: tasks, counts, affected: { created_list: true } },
	};
}

function addTasks(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const listId = ensureList(db, scope, name, undefined);
	const items = p.items as any[] | undefined;
	if (!items || items.length === 0) throw new Error("'items' is required for todo add.");
	const underRoot = (p.under as number) ?? null;

	// Resolve ref → id ordering (mirror pi-todo's resolveItemOrder)
	const byRef = new Map<string, number>();
	const order = resolveOrder(items);
	let added = 0;
	for (const it of order) {
		let parentId: number | null;
		if (it.underRef && byRef.has(it.underRef)) {
			parentId = byRef.get(it.underRef)!;
		} else {
			parentId = underRoot;
		}
		const ts = Date.now();
		const row = db.prepare(
			"INSERT INTO tasks (list_id, text, status, priority, note, tags, description, parent_id, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			listId,
			it.text,
			it.status ?? "pending",
			it.priority ?? "medium",
			it.note ?? null,
			it.tags ? it.tags.join(",") : null,
			it.description ?? null,
			parentId,
			0, // position
			ts,
			ts,
		);
		const newId = Number(row.lastInsertRowid);
		if (it.ref) byRef.set(it.ref, newId);
		added++;
	}
	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "add",
		details: { action: "add", list: { scope: scope ?? "", name, path, title: null }, tree: tasks, counts, affected: { added } },
	};
}

function nextTask(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string | undefined;
	const wantedStatus = (p.status as string) ?? "pending";
	let task: any;
	let scope: string;
	let name: string;
	let listId: number;

	if (rawList) {
		const parsed = parseListPath(rawList);
		scope = parsed.scope ?? "";
		name = parsed.name;
		listId = getListId(db, scope, name);
		task = db.prepare(
			`SELECT id, text, status, priority, note, tags FROM tasks
       WHERE list_id=? AND status=? AND parent_id IS NULL
       ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 END DESC, id ASC
       LIMIT 1`,
		).get(listId, wantedStatus);
	} else {
		// global search across all lists
		task = db.prepare(
			`SELECT t.id, t.text, t.status, t.priority, t.note, t.tags, l.scope, l.name, l.id as list_id
       FROM tasks t JOIN lists l ON t.list_id = l.id
       WHERE t.status=? AND t.parent_id IS NULL
       ORDER BY CASE t.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 END DESC, t.id ASC
       LIMIT 1`,
		).get(wantedStatus);
		if (!task) throw new Error(`No '${wantedStatus}' tasks found.`);
		scope = (task as any).scope ?? "";
		name = (task as any).name;
		listId = (task as any).list_id;
	}
	if (!task) throw new Error(`No '${wantedStatus}' tasks found in '${rawList}'.`);

	const t = task as any;
	const path = scope ? `${scope}/${name}` : name;
	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "next",
		details: {
			action: "next",
			list: { scope, name, path, title: null },
			tree: tasks,
			counts,
			next_task: {
				id: t.id,
				text: t.text,
				status: t.status,
				priority: t.priority,
				note: t.note,
				tags: t.tags ? t.tags.split(",").filter(Boolean) : undefined,
			},
		},
	};
}

function updateTask(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const listId = getListId(db, scope, name);
	const id = p.id as number;
	if (id == null) throw new Error("'id' is required for todo update.");

	const sets: string[] = [];
	const values: any[] = [];
	if (p.text !== undefined) { sets.push("text=?"); values.push(p.text); }
	if (p.status !== undefined) { sets.push("status=?"); values.push(p.status); }
	if (p.priority !== undefined) { sets.push("priority=?"); values.push(p.priority); }
	if (p.note !== undefined) { sets.push("note=?"); values.push(p.note); }
	if (p.tags !== undefined) { sets.push("tags=?"); values.push(Array.isArray(p.tags) ? (p.tags as string[]).join(",") : ""); }
	if (p.description !== undefined) { sets.push("description=?"); values.push(p.description); }
	if (sets.length === 0) throw new Error("todo update needs at least one of: text, status, priority, note, tags, description.");
	sets.push("updated_at=?"); values.push(Date.now());
	values.push(id, listId);
	db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=? AND list_id=?`).run(...values);

	// Cascade status to descendants if requested
	if (p.status !== undefined && p.cascade) {
		cascadeStatus(db, id, listId, p.status as string);
	}

	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "update",
		details: { action: "update", list: { scope, name, path, title: null }, tree: tasks, counts, affected: { updated: 1 } },
	};
}

function cascadeStatus(db: any, parentId: number, listId: number, status: string): void {
	const children = db.prepare("SELECT id FROM tasks WHERE list_id=? AND parent_id=?").all(listId, parentId) as any[];
	for (const c of children) {
		db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), c.id);
		cascadeStatus(db, c.id, listId, status);
	}
}

function showList(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const listId = getListId(db, scope, name);
	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "show",
		details: { action: "show", list: { scope: scope ?? "", name, path, title: null }, tree: tasks, counts },
	};
}

function purgeDone(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const listId = getListId(db, scope, name);

	// Recursively delete tasks whose entire subtree is "done"
	const removed = db.prepare(
		`DELETE FROM tasks WHERE list_id=? AND status='done'
     AND id NOT IN (SELECT DISTINCT parent_id FROM tasks WHERE list_id=? AND parent_id IS NOT NULL AND status!='done')`,
	).run(listId, listId).changes;

	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "purge",
		details: { action: "purge", list: { scope: scope ?? "", name, path, title: null }, tree: tasks, counts, affected: { deleted: removed } },
	};
}

function moveTask(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const listId = getListId(db, scope, name);
	const id = p.id as number;
	if (id == null) throw new Error("'id' is required for todo move.");
	const under = (p.under as number | undefined) ?? null;
	// Simple re-parent (no after ordering for v1)
	db.prepare("UPDATE tasks SET parent_id=?, updated_at=? WHERE id=? AND list_id=?").run(under, Date.now(), id, listId);
	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "move",
		details: { action: "move", list: { scope: scope ?? "", name, path, title: null }, tree: tasks, counts, affected: { moved: true } },
	};
}

function deleteTask(db: any, p: Record<string, unknown>): TodoResult {
	const rawList = p.list as string;
	const { scope, name, path } = parseListPath(rawList);
	const listId = getListId(db, scope, name);
	const id = p.id as number;
	if (id == null) throw new Error("'id' is required for todo delete.");
	// Delete task and all descendants recursively
	const delRec = db.prepare(
		`WITH RECURSIVE del(id) AS (
      VALUES(?)
      UNION ALL
      SELECT t.id FROM tasks t JOIN del ON t.parent_id=del.id WHERE t.list_id=?
    )
    DELETE FROM tasks WHERE id IN (SELECT id FROM del)`,
	);
	delRec.run(id, listId);
	const tasks = fetchTree(db, listId);
	const counts = countsOf(tasks);
	return {
		action: "delete",
		details: { action: "delete", list: { scope: scope ?? "", name, path, title: null }, tree: tasks, counts, affected: { deleted: 1 } },
	};
}

// ---- helpers ----

function parseListPath(raw: string): { scope: string; name: string; path: string; rootTaskId?: number } {
	const trimmed = raw.trim();
	// strip subtree ref: scope/name#123
	const hashIdx = trimmed.indexOf("#");
	const rootTaskId = hashIdx >= 0 ? Number(trimmed.slice(hashIdx + 1)) : undefined;
	const listPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
	const slash = listPart.indexOf("/");
	let scope: string;
	let name: string;
	if (slash >= 0 && !listPart.startsWith("/")) {
		scope = listPart.slice(0, slash);
		name = listPart.slice(slash + 1);
	} else {
		scope = "";
		name = listPart.startsWith("/") ? listPart.slice(1) : listPart;
	}
	return { scope, name, path: scope ? `${scope}/${name}` : name, rootTaskId: rootTaskId && !Number.isNaN(rootTaskId) ? rootTaskId : undefined };
}

function resolveOrder(items: any[]): any[] {
	// Topological sort: parents before children
	const byRef = new Map<string, any>();
	const refs = new Set<string>();
	for (const it of items) {
		if (it.ref) {
			if (refs.has(it.ref)) throw new Error(`Duplicate ref '${it.ref}'.`);
			refs.add(it.ref);
			byRef.set(it.ref, it);
		}
	}
	// Check all underRef references exist
	for (const it of items) {
		if (it.underRef && !refs.has(it.underRef)) {
			throw new Error(`underRef '${it.underRef}' does not reference any item's ref.`);
		}
	}
	// DFS topological sort
	const order: any[] = [];
	const state = new Map<any, number>(); // 0=unvisited, 1=visiting, 2=done
	function visit(it: any) {
		const st = state.get(it) ?? 0;
		if (st === 2) return;
		if (st === 1) throw new Error("Cycle detected in items underRef chain.");
		state.set(it, 1);
		if (it.underRef) {
			const parent = byRef.get(it.underRef);
			if (parent) visit(parent);
		}
		state.set(it, 2);
		order.push(it);
	}
	for (const it of items) visit(it);
	return order;
}

interface TreeNode {
	id: number;
	text: string;
	status: string;
	priority: string;
	note?: string | null;
	tags?: string[] | null;
	description?: string | null;
	children: TreeNode[];
}

function fetchTree(db: any, listId: number): TreeNode[] {
	const rows = db.prepare(
		"SELECT id, text, status, priority, note, tags, description, parent_id FROM tasks WHERE list_id=? ORDER BY id",
	).all(listId) as any[];
	const byParent = new Map<number | null, TreeNode[]>();
	for (const r of rows) {
		const node: TreeNode = {
			id: r.id,
			text: r.text,
			status: r.status,
			priority: r.priority,
			note: r.note,
			tags: r.tags ? r.tags.split(",").filter(Boolean) : null,
			description: r.description,
			children: [],
		};
		const key = r.parent_id ?? (null as unknown as number);
		let arr = byParent.get(key);
		if (!arr) { arr = []; byParent.set(key, arr); }
		arr.push(node);
	}
	function build(parentId: number | null): TreeNode[] {
		const nodes = byParent.get(parentId ?? (null as unknown as number)) ?? [];
		for (const node of nodes) node.children = build(node.id);
		return nodes;
	}
	return build(null);
}

function countsOf(nodes: TreeNode[]): Record<string, number> {
	let total = 0, pending = 0, inProgress = 0, done = 0;
	function walk(list: TreeNode[]) {
		for (const n of list) { total++; if (n.status === "pending") pending++; else if (n.status === "in_progress") inProgress++; else if (n.status === "done") done++; walk(n.children); }
	}
	walk(nodes);
	return { total, pending, in_progress: inProgress, done };
}

/** True if the todo DB is reachable. */
export function todoAvailable(): boolean {
	try {
		const db = requireDb();
		db.prepare("SELECT 1").get();
		db.close();
		return true;
	} catch {
		return false;
	}
}
