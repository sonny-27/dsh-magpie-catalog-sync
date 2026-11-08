import test from 'node:test';
import assert from 'node:assert/strict';
import { compactGemini4Tools } from '../lib/tool-compat.mjs';
import { createRelay } from '../lib/relay.mjs';
import { buildCatalog } from '../lib/catalog.mjs';

function schema() {
  return {
    type: 'object', description: 'Parameter documentation',
    properties: {
      description: { type: 'string', description: 'Help for the real description parameter', minLength: 2 },
      title: { type: 'string', enum: ['description', 'title'] },
      examples: { const: { description: 'literal value', title: 'literal title' } },
      value: { anyOf: [{ type: 'string', description: 'A string' }, { type: 'null' }], default: { description: 'default data' } },
      rows: { type: 'array', prefixItems: [{ type: 'integer', minimum: 0, description: 'Row' }], items: false },
      linked: { $ref: '#/$defs/description' },
    },
    required: ['description', 'title'], additionalProperties: false,
    $defs: { description: { type: 'object', description: 'Definition help', properties: { description: { type: 'string', description: 'Definition property help' } } } },
    allOf: [{ if: { required: ['title'] }, then: { minProperties: 2, description: 'Conditional help' } }],
    'x-literal': { description: 'Extension data must stay intact' },
  };
}

test('compacts schema annotations without deleting real parameter names, references or validation rules', () => {
  const input = { model: 'antigravity/gemini-4-argon', input: 'Synthetic test', reasoning: { effort: 'high' }, max_output_tokens: 65536,
    tools: [{ type: 'function', name: 'fixture', description: 'Tool instructions and permission rules stay intact', parameters: schema() }] };
  const snapshot = structuredClone(input);
  const result = compactGemini4Tools(input);
  assert.ok(result.removedParameterDescriptions > 0);
  assert.deepEqual(input, snapshot);
  assert.equal(result.body.input, input.input);
  assert.equal(result.body.reasoning, input.reasoning);
  assert.equal(result.body.max_output_tokens, 65536);
  assert.equal(result.body.tools[0].description, input.tools[0].description);
  const output = result.body.tools[0].parameters;
  assert.equal(output.description, undefined);
  assert.deepEqual(Object.keys(output.properties), Object.keys(input.tools[0].parameters.properties));
  assert.deepEqual(output.properties.description, { type: 'string', minLength: 2 });
  assert.deepEqual(output.required, ['description', 'title']);
  assert.equal(output.additionalProperties, false);
  assert.deepEqual(output.properties.examples.const, { description: 'literal value', title: 'literal title' });
  assert.deepEqual(output.properties.value.default, { description: 'default data' });
  assert.deepEqual(output.properties.value.anyOf, [{ type: 'string' }, { type: 'null' }]);
  assert.deepEqual(output.properties.rows.prefixItems, [{ type: 'integer', minimum: 0 }]);
  assert.equal(output.properties.rows.items, false);
  assert.deepEqual(output.properties.linked, { $ref: '#/$defs/description' });
  assert.ok(output.$defs.description.properties.description);
  assert.deepEqual(output.allOf, [{ if: { required: ['title'] }, then: { minProperties: 2 } }]);
  assert.deepEqual(output['x-literal'], { description: 'Extension data must stay intact' });
});

test('supports Responses, Chat and Messages tool declarations and preserves built-in tools', () => {
  for (const declaration of [
    { type: 'function', name: 'fixture', parameters: schema() },
    { type: 'function', function: { name: 'fixture', parameters: schema() } },
    { name: 'fixture', input_schema: schema() },
  ]) {
    const builtIn = { type: 'web_search_preview' };
    const result = compactGemini4Tools({ model: 'antigravity/gemini-4-argon', tools: [declaration, builtIn] });
    assert.equal(result.body.tools.length, 2);
    const tool = result.body.tools[0].function ?? result.body.tools[0];
    assert.equal((tool.parameters ?? tool.input_schema).description, undefined);
    assert.equal(result.body.tools[1], builtIn);
  }
});

test('other models, disabled compatibility and annotation-free schemas pass through unchanged', () => {
  for (const model of ['codex/gpt-6.1-sol', 'antigravity/gemini-3.8-flash', 'other/gemini-4-argon']) {
    const body = { model, tools: [{ type: 'function', name: 'fixture', parameters: schema() }] };
    assert.equal(compactGemini4Tools(body).body, body);
  }
  const body = { model: 'antigravity/gemini-4-argon', tools: [{ type: 'function', name: 'fixture', parameters: schema() }] };
  assert.equal(compactGemini4Tools(body, false).body, body);
  const plain = { model: body.model, tools: [{ type: 'function', name: 'fixture', parameters: { type: 'object', properties: {} } }] };
  assert.equal(compactGemini4Tools(plain).body, plain);
});

test('the real relay applies the compatibility switch, keeps High and 64K output, and streams normally', async t => {
  const config = { gemini4CompactTools: true }, seen = [], records = [];
  const catalog = buildCatalog({ data: [{ id: 'antigravity/gemini-4-argon', reasoning_levels: ['low', 'high'] }] });
  const relay = await createRelay({ getConnection: async () => ({ baseURL: 'https://gateway.example/v1', key: 'fixture-relay-key', config }), getCatalog: () => catalog,
    onRequest: value => records.push(value), fetchImpl: async (url, options) => {
      assert.equal(url, 'https://gateway.example/v1/responses');
      assert.equal(options.headers.authorization, 'Bearer fixture-relay-key');
      seen.push(JSON.parse(options.body));
      return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(() => relay.close());
  for (const enabled of [true, false]) {
    config.gemini4CompactTools = enabled;
    const response = await fetch(relay.baseURL + '/responses', { method: 'POST', headers: { authorization: 'Bearer fixture-relay-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'antigravity/gemini-4-argon', input: 'Synthetic test', reasoning: { effort: 'high' }, max_output_tokens: 65536, stream: true,
        tools: [{ type: 'function', name: 'fixture', description: 'Required instructions', parameters: schema() }] }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
    assert.equal(seen.at(-1).tools[0].parameters.description, enabled ? undefined : 'Parameter documentation');
    assert.equal(Boolean(records.at(-1).removedParameterDescriptions), enabled);
    assert.deepEqual(seen.at(-1).reasoning, { effort: 'high' });
    assert.equal(seen.at(-1).max_output_tokens, 65536);
    assert.equal(seen.at(-1).tools[0].description, 'Required instructions');
  }
});
