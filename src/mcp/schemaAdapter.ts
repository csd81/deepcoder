/**
 * Adapt an MCP tool's JSON-Schema `inputSchema` into the shape our model layer
 * expects. We do not round-trip through zod; the server already provides JSON
 * Schema. We only sanitise the bits that have bitten us with providers before.
 */
export function adaptMcpInputSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = isObject(inputSchema) ? structuredClone(inputSchema) : { type: "object" };
  if (!("type" in schema)) (schema as Record<string, unknown>).type = "object";
  fixExclusiveBounds(schema);
  return schema as Record<string, unknown>;
}

/** DeepSeek/OpenAI reject boolean exclusiveMinimum/Maximum (draft-04 style). */
function fixExclusiveBounds(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(fixExclusiveBounds);
    return;
  }
  if (!isObject(node)) return;
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (typeof node[key] === "boolean") {
      // Best-effort: drop the boolean form; keep the paired minimum/maximum.
      delete node[key];
    }
  }
  for (const v of Object.values(node)) fixExclusiveBounds(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
