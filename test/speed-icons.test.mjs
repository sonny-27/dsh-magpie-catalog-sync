import test from 'node:test';
import assert from 'node:assert/strict';
import { speedIconSpec } from '../lib/speed-icons.mjs';

test('Fast has one bolt and Ultra Fast has two offset bolts', () => {
  assert.equal(speedIconSpec('priority').paths.length, 1);
  const ultra = speedIconSpec('ultrafast');
  assert.equal(ultra.paths.length, 2);
  assert.notEqual(ultra.paths[0].transform, ultra.paths[1].transform);
  assert.equal(speedIconSpec('default').paths.length, 1);
});
