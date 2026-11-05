import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_AUTHORIZED,
  isCopyAuthorized,
  assertCopyAuthorized,
  CopyAuthorizationError,
} from '../../packages/config/src/security.js';

test('copy authorization is disabled in the committed default configuration', { skip: COPY_AUTHORIZED }, () => {
  assert.equal(COPY_AUTHORIZED, false);
  assert.equal(isCopyAuthorized(), false);
});

test('copy operations fail closed while authorization is disabled', { skip: COPY_AUTHORIZED }, () => {
  assert.throws(assertCopyAuthorized, CopyAuthorizationError);
  assert.throws(() => assertCopyAuthorized(), (error) => error.code === 'COPY_NOT_AUTHORIZED');
});

test('isCopyAuthorized mirrors the source constant and nothing else', () => {
  assert.equal(isCopyAuthorized(), COPY_AUTHORIZED === true);
  if (COPY_AUTHORIZED) assert.doesNotThrow(assertCopyAuthorized);
});
