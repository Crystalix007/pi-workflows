/**
 * Lua schema DSL compiler.
 *
 * The Lua side produces plain tables (via enableProxy) using the helpers
 * defined in the preamble below. The TS side converts those tables to a
 * JSON Schema subset consumed by `structured_output` / `outputSchema`.
 */
import type { JsonSchema } from "./driver.ts";

interface LuaSchemaField {
	type?: string;
	items?: LuaSchemaField;
	properties?: Record<string, LuaSchemaField>;
	required?: string[];
	_optional?: boolean;
	description?: string;
	enum?: unknown[];
}

function fieldToJsonSchema(f: LuaSchemaField): Record<string, unknown> {
	const out: Record<string, unknown> = { type: f.type ?? "string" };
	if (f.description) out.description = f.description;
	if (f.type === "array" && f.items) out.items = fieldToJsonSchema(f.items);
	if (f.type === "object" && f.properties) {
		const props: Record<string, unknown> = {};
		const req: string[] = [];
		for (const [k, v] of Object.entries(f.properties)) {
			props[k] = fieldToJsonSchema(v);
			if (!v._optional) req.push(k);
		}
		out.properties = props;
		if (req.length > 0) out.required = req;
	}
	if (f.enum) out.enum = f.enum;
	return out;
}

/**
 * Convert a Lua schema table (built by the preamble) to a JSON Schema object.
 * Every key whose value lacks the `_optional` marker becomes required.
 */
export function luaSchemaToJsonSchema(
	table: Record<string, LuaSchemaField>,
): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	for (const [k, v] of Object.entries(table)) {
		properties[k] = fieldToJsonSchema(v) as unknown as JsonSchema;
		if (!v._optional) required.push(k);
	}
	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	};
}

/**
 * Preamble injected into every workflow Lua VM so `schema{…}` and the type
 * helpers are globally available by default.
 */
export const LUA_SCHEMA_PREAMBLE = `
-- Schema DSL
str = { type = "string" }
bool = { type = "boolean" }
num  = { type = "number" }
function list(t)   return { type = "array", items = t } end
function enum(...) return { type = "string", enum = {...} } end
function optional(t)
  local c = {}; for k,v in pairs(t) do c[k]=v end; c._optional = true; return c
end
function describe(t, desc) t.description = desc; return t end
schema = function(t) return t end
`;
