import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoginURL } from '../lib/login-url.mjs';

test('login management links support local tunnels and HTTPS without embedding credentials', () => {
  assert.equal(normalizeLoginURL('http://127.0.0.1:58627/setup'), 'http://127.0.0.1:58627/setup');
  assert.equal(normalizeLoginURL('https://admin.example/gemini-login'), 'https://admin.example/gemini-login');
  assert.equal(normalizeLoginURL(''), '');
  for (const value of ['javascript:alert(1)', 'file:///private', 'http://remote.example/login', 'https://user:secret@example.com/login', 'https://example.com/?key=private', 'https://example.com/#private']) assert.throws(() => normalizeLoginURL(value));
});
