import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_AUTHORIZED,
  isCopyAuthorized,
  assertCopyAuthorized,
  CopyAuthorizationError,
} from '../../packages/config/src/security.js';

test('copy authorization is disabled in the committed default configuration', () => {
  assert.equal(COPY_AUTHORIZED, false);
  assert.equal(isCopyAuthorized(), false);
});

test('copy operations fail closed while authorization is disabled', () => {
  assert.throws(assertCopyAuthorized, CopyAuthorizationError);
  assert.throws(() => assertCopyAuthorized(), (error) => error.code === 'COPY_NOT_AUTHORIZED');
});
