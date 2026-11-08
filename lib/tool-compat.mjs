const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaValues = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function compactSchema(schema, stats) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  let changed = false;
  const entries = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') {
      stats.removedParameterDescriptions++; changed = true; continue;
    }
    let next = value;
    if (schemaMaps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const children = Object.entries(value).map(([name, child]) => [name, compactSchema(child, stats)]);
      // Property and definition names are data: "description" is a valid parameter name.
      if (children.some(([name, child]) => child !== value[name])) next = Object.fromEntries(children);
    } else if (schemaValues.has(key)) {
      if (Array.isArray(value)) {
        const children = value.map(child => compactSchema(child, stats));
        if (children.some((child, index) => child !== value[index])) next = children;
      } else next = compactSchema(value, stats);
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      const children = value.map(child => compactSchema(child, stats));
      if (children.some((child, index) => child !== value[index])) next = children;
    }
    // enum, const, default and extension values are literals, never schema nodes.
    changed ||= next !== value;
    entries.push([key, next]);
  }
  return changed ? Object.fromEntries(entries) : schema;
}

export function compactGemini4Tools(body, enabled = true) {
  const stats = { removedParameterDescriptions: 0 };
  if (!enabled || !/^antigravity\/gemini-4(?:[.-]|$)/.test(body.model ?? '') || !Array.isArray(body.tools)) return { body, ...stats };
  const tools = body.tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool;
    const declaration = tool.type === 'function' && tool.function ? tool.function : tool;
    const field = Object.hasOwn(declaration, 'parameters') ? 'parameters' : Object.hasOwn(declaration, 'input_schema') ? 'input_schema' : undefined;
    if (!field) return tool;
    const schema = compactSchema(declaration[field], stats);
    if (schema === declaration[field]) return tool;
    const next = { ...declaration, [field]: schema };
    return declaration === tool ? next : { ...tool, function: next };
  });
  return { body: stats.removedParameterDescriptions ? { ...body, tools } : body, ...stats };
}
