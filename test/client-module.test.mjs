import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('distributed client loads through the actual classic-script module contract', () => {
  let registered;
  const context = vm.createContext({ window: { __ModuleLoader__: { load: entry => { registered = entry; } } } });
  vm.runInContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context);
  assert.equal(registered.id, 'dsh-magpie-catalog-sync');
  const exports = registered.factory(name => { assert.equal(name, 'react'); return { createElement() {} }; });
  assert.equal(typeof exports.apply, 'function');
  assert.ok(Array.isArray(exports.inject));
  assert.equal(Object.prototype.toString.call(exports), '[object Module]');
});
