import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizedLocalMediaService } from '../../apps/runner/src/services/authorized-local-media-service.js';
import { CopyAuthorizationError } from '../../packages/config/src/security.js';
import { evaluateDuration, DURATION_STATUS } from '../../packages/domain/src/duration.js';

const ASSET_ID = 'a'.repeat(32);

test('authorized local media service blocks before invoking storage while the copy gate is false', async () => {
  let uploadCalls = 0;
  let thumbnailCalls = 0;
  const service = new AuthorizedLocalMediaService({
    storage: {
      async uploadLocalFile() { uploadCalls += 1; },
      async deleteObject() {},
    },
    repository: { async registerStoredMedia() {}, async uploadThumbnail() {} },
    mediaInspector: { async inspect() { throw new Error('Inspector should not run while copy is blocked.'); } },
    thumbnailGenerator: { async generate() { thumbnailCalls += 1; } },
    logger: { warn() {}, error() {} },
  });
  await assert.rejects(service.storeLocalVideo({ assetId: ASSET_ID, localPath: '/tmp/authorized.mp4' }), CopyAuthorizationError);
  assert.equal(uploadCalls, 0);
  assert.equal(thumbnailCalls, 0);
});

test('shared duration rule accepts exactly 600 seconds and rejects longer files', () => {
  assert.equal(evaluateDuration(600_000), DURATION_STATUS.ACCEPTED);
  assert.equal(evaluateDuration(600_001), DURATION_STATUS.TOO_LONG);
  assert.equal(evaluateDuration(null), DURATION_STATUS.UNKNOWN);
});
