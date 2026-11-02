import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const headers = readFileSync(new URL('../../apps/web/public/_headers', import.meta.url), 'utf8');
const rules = headers.split(/\n\s*\n/u).map((block) => {
  const [path, ...lines] = block.trim().split('\n');
  return { path: path.trim(), lines: lines.map((line) => line.trim()) };
});
const header = (rule, name) => rule.lines.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

// Verified in Chromium: with `Referrer-Policy: no-referrer` a same-origin form POST is sent
// with `Origin: null`, which the Worker (correctly) rejects, so "Abrir no MEGA" never worked.
test('the page keeps the Origin header on same-origin form posts', () => {
  const global = rules.find((rule) => rule.path === '/*');
  assert.equal(header(global, 'Referrer-Policy'), 'same-origin');
});

// Verified in Chromium: form-action also applies to the redirect that follows the POST.
test('the CSP lets the open form follow the 303 redirect to MEGA', () => {
  const csp = header(rules.find((rule) => rule.path === '/*'), 'Content-Security-Policy');
  const formAction = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('form-action'));
  assert.match(formAction, /'self'/u);
  assert.match(formAction, /https:\/\/mega\.nz/u);
  assert.doesNotMatch(csp, /\*/u, 'no wildcard hosts in the CSP');
});

test('no URL matches two Cache-Control rules (Pages merges matching rules)', () => {
  const withCache = rules.filter((rule) => header(rule, 'Cache-Control'));
  assert.ok(!withCache.some((rule) => rule.path === '/*'), 'global rule must not carry Cache-Control');
  assert.equal(header(rules.find((rule) => rule.path === '/assets/*'), 'Cache-Control').includes('no-cache'), false);
});
