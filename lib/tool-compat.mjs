const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaValues = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

const pointer = (path, key) => path + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');

function compactSchema(schema, notes, path = '#') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  let changed = false;
  const entries = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') {
      notes.push({ path: pointer(path, key), description: value }); changed = true; continue;
    }
    let next = value;
    if (schemaMaps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const children = Object.entries(value).map(([name, child]) => [name, compactSchema(child, notes, pointer(pointer(path, key), name))]);
      // Property and definition names are data: "description" is a valid parameter name.
      if (children.some(([name, child]) => child !== value[name])) next = Object.fromEntries(children);
    } else if (schemaValues.has(key)) {
      if (Array.isArray(value)) {
        const children = value.map((child, index) => compactSchema(child, notes, pointer(pointer(path, key), index)));
        if (children.some((child, index) => child !== value[index])) next = children;
      } else next = compactSchema(value, notes, pointer(path, key));
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      const children = value.map((child, index) => compactSchema(child, notes, pointer(pointer(path, key), index)));
      if (children.some((child, index) => child !== value[index])) next = children;
    }
    // enum, const, default and extension values are literals, never schema nodes.
    changed ||= next !== value;
    entries.push([key, next]);
  }
  return changed ? Object.fromEntries(entries) : schema;
}

export function compactGemini4Tools(body, enabled = true) {
  const stats = { relocatedParameterDescriptions: 0 };
  if (!enabled || !/^antigravity\/gemini-4(?:[.-]|$)/.test(body.model ?? '') || !Array.isArray(body.tools)) return { body, ...stats };
  const tools = body.tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool;
    const declaration = tool.type === 'function' && tool.function ? tool.function : tool;
    if (declaration.description !== undefined && typeof declaration.description !== 'string') return tool;
    const field = Object.hasOwn(declaration, 'parameters') ? 'parameters' : Object.hasOwn(declaration, 'input_schema') ? 'input_schema' : undefined;
    if (!field) return tool;
    const notes = [];
    const schema = compactSchema(declaration[field], notes);
    if (schema === declaration[field]) return tool;
    const originalDescription = declaration.description ?? '';
    const reference = 'Parameter reference (all original descriptions, by JSON Schema path):\n' + JSON.stringify(notes);
    const description = originalDescription + (originalDescription ? '\n\n' : '') + reference;
    stats.relocatedParameterDescriptions += notes.length;
    const next = { ...declaration, [field]: schema, description };
    return declaration === tool ? next : { ...tool, function: next };
  });
  return { body: stats.relocatedParameterDescriptions ? { ...body, tools } : body, ...stats };
}
