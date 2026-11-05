import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EromeMediaProcessingService } from '../../apps/runner/src/services/erome-media-processing-service.js';
import { COPY_AUTHORIZED } from '../../packages/config/src/security.js';

const ASSET_ID = 'a'.repeat(32);
const JOB = Object.freeze({
  jobId: 'd9a5f5d2-74ad-40f3-9e43-97c4adfbb9d2',
  leaseToken: 'b'.repeat(32),
  assetId: ASSET_ID,
  postId: 'AbCd1234',
  canonicalUrl: 'https://www.erome.com/a/AbCd1234',
  sourceVideoId: 'Video1234',
  durationMs: 599_000,
  attempts: 1,
});

const ALBUM_HTML = `<!doctype html><html><head><title>needle video</title></head><body>
  <h1>needle video</h1>
  <a class="tag" href="/tags/needle">needle</a>
  <video data-duration="09:59"><source src="https://v19.erome.com/1234/AbCd1234/Video1234.mp4"></video>
  <img src="https://s63.erome.com/1234/AbCd1234/photo.jpg">
</body></html>`;

async function withWorkspace(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-processing-test-'));
  try {
    const keywordFilePath = join(directory, 'search-keyword.txt');
    const localPath = join(directory, 'video.mp4');
    const thumbnailPath = join(directory, 'thumbnail.webp');
    await writeFile(keywordFilePath, 'needle', 'utf8');
    await writeFile(localPath, Buffer.from('fake-video-bytes'));
    await writeFile(thumbnailPath, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]));
    await run({ directory, keywordFilePath, localPath, thumbnailPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('media processing hard gate stops before claiming jobs or requesting album/media bytes', { skip: COPY_AUTHORIZED }, async () => {
  assert.equal(COPY_AUTHORIZED, false);
  let claimed = 0;
  let sourceCalls = 0;
  let downloads = 0;
  const service = new EromeMediaProcessingService({
    repository: {
      async claimProcessVideoJobs() { claimed += 1; return [JOB]; },
      async completeProcessVideoJob() {},
      async failProcessVideoJob() {},
    },
    sourceClient: { async fetchAlbum() { sourceCalls += 1; return ALBUM_HTML; } },
    downloader: { async download() { downloads += 1; throw new Error('must not run'); } },
    mediaInspector: { async inspect() { return { durationMs: 599_000 }; } },
    thumbnailGenerator: { async generate() { throw new Error('must not run'); } },
    storage: { async uploadLocalFile() { throw new Error('must not run'); } },
    keywordFilePath: '/unused/while-gate-closed.txt',
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(service.runOnce(), (error) => error.code === 'COPY_NOT_AUTHORIZED');
  assert.equal(claimed, 0);
  assert.equal(sourceCalls, 0);
  assert.equal(downloads, 0);
});

test('authorized processing revalidates keyword/duration, downloads one exact video, uploads MEGA and registers a 7-day item', async () => {
  await withWorkspace(async ({ keywordFilePath, localPath, thumbnailPath }) => {
    const calls = { claimed: 0, fetchedAlbum: [], downloads: [], inspected: [], generated: 0, uploaded: [], completed: [], thumbnails: [], cleanedDownload: 0, cleanedThumbnail: 0 };
    const now = () => new Date('2026-11-01T12:00:00.000Z');
    const service = new EromeMediaProcessingService({
      repository: {
        async claimProcessVideoJobs(args) { calls.claimed += 1; assert.deepEqual(args, { limit: 1, now: '2026-11-01T12:00:00.000Z' }); return [JOB]; },
        async completeProcessVideoJob(record) { calls.completed.push(record); },
        async failProcessVideoJob(record) { throw new Error(`Unexpected failure: ${record.errorCode}`); },
        async uploadThumbnail(assetId, bytes) { calls.thumbnails.push({ assetId, bytes: Buffer.from(bytes) }); },
      },
      sourceClient: { async fetchAlbum(url) { calls.fetchedAlbum.push(url); return ALBUM_HTML; } },
      downloader: { async download(options) { calls.downloads.push(options); return { localPath, sizeBytes: 16, async cleanup() { calls.cleanedDownload += 1; } }; } },
      mediaInspector: { async inspect(options) { calls.inspected.push(options); return { durationMs: 599_000 }; } },
      thumbnailGenerator: { async generate(options) { calls.generated += 1; assert.deepEqual(options, { localPath }); return { path: thumbnailPath, async cleanup() { calls.cleanedThumbnail += 1; } }; } },
      storage: { async uploadLocalFile(options) { calls.uploaded.push(options); return { objectId: `/Ero-Scrap/${ASSET_ID}/video.mp4`, shareUrl: 'https://mega.nz/file/AbCdEf#secretKey', uploadedAt: '2026-11-01T12:00:00.000Z' }; } },
      keywordFilePath,
      logger: { info() {}, warn() {}, error() {} },
      now,
      authorizeCopy() {}, // Explicitly injected test authorization; production uses the hard gate.
    });

    const result = await service.runOnce();
    assert.deepEqual(result, { claimed: 1, stored: 1, retried: 0, dead: 0, stale: 0 });
    assert.equal(calls.claimed, 1);
    assert.deepEqual(calls.fetchedAlbum, [JOB.canonicalUrl]);
    assert.deepEqual(calls.downloads, [{
      mediaUrl: 'https://v19.erome.com/1234/AbCd1234/Video1234.mp4',
      albumUrl: JOB.canonicalUrl,
      assetId: ASSET_ID,
    }]);
    assert.deepEqual(calls.uploaded, [{ assetId: ASSET_ID, localPath }]);
    assert.equal(calls.completed.length, 1);
    assert.equal(calls.completed[0].expiresAt, '2026-11-08T12:00:00.000Z');
    assert.equal(calls.completed[0].shareUrl, 'https://mega.nz/file/AbCdEf#secretKey');
    assert.equal(calls.thumbnails.length, 1);
    assert.equal(calls.thumbnails[0].assetId, ASSET_ID);
    assert.deepEqual(calls.thumbnails[0].bytes, await readFile(thumbnailPath));
    assert.equal(calls.cleanedDownload, 1);
    assert.equal(calls.cleanedThumbnail, 1);
  });
});

test('runBatch stores jobs one at a time and stops when the queue is empty', async () => {
  await withWorkspace(async ({ keywordFilePath, localPath, thumbnailPath }) => {
    const limits = [];
    let queue = 3;
    let completed = 0;
    const service = new EromeMediaProcessingService({
      repository: {
        async claimProcessVideoJobs(args) { limits.push(args.limit); return queue-- > 0 ? [JOB] : []; },
        async completeProcessVideoJob() { completed += 1; },
        async failProcessVideoJob(record) { throw new Error(`Unexpected failure: ${record.errorCode}`); },
        async uploadThumbnail() {},
      },
      sourceClient: { async fetchAlbum() { return ALBUM_HTML; } },
      downloader: { async download() { return { localPath, sizeBytes: 16, async cleanup() {} }; } },
      mediaInspector: { async inspect() { return { durationMs: 599_000 }; } },
      thumbnailGenerator: { async generate() { return { path: thumbnailPath, async cleanup() {} }; } },
      storage: { async uploadLocalFile() { return { objectId: '/Ero-Scrap/x/video.mp4', shareUrl: 'https://mega.nz/file/AbCdEf#k', uploadedAt: '2026-11-01T12:00:00.000Z' }; } },
      keywordFilePath, logger: { info() {}, warn() {}, error() {} }, authorizeCopy() {},
    });
    const result = await service.runBatch({ maxVideos: 4 });
    assert.equal(completed, 3);
    assert.equal(result.stored, 3);
    assert.equal(result.stoppedBy, 'queue_empty');
    assert.deepEqual(limits, [1, 1, 1, 1]);
  });
});

test('runBatch limits, budget and consecutive-failure stop', async () => {
  await withWorkspace(async ({ keywordFilePath }) => {
    let claimed = 0;
    const make = (failing) => new EromeMediaProcessingService({
      repository: {
        async claimProcessVideoJobs(args) { assert.equal(args.limit, 1); claimed += 1; return [JOB]; },
        async completeProcessVideoJob() {}, async uploadThumbnail() {},
        async failProcessVideoJob() { return { retry: true, dead: false, stale: false }; },
      },
      sourceClient: { async fetchAlbum() { if (failing) throw Object.assign(new Error('x'), { code: 'source_video_missing' }); return ALBUM_HTML; } },
      downloader: { async download() { throw Object.assign(new Error('x'), { code: 'media_download_failed' }); } },
      mediaInspector: { async inspect() {} }, thumbnailGenerator: { async generate() {} }, storage: { async uploadLocalFile() {} },
      keywordFilePath, logger: { info() {}, warn() {}, error() {} }, authorizeCopy() {},
    });

    // Two failures in a row stop the batch even though 4 were allowed.
    let result = await make(true).runBatch({ maxVideos: 4 });
    assert.equal(result.stoppedBy, 'repeated_failures');
    assert.equal(result.claimed, 2);

    // The time budget only blocks starting a *new* video, never the first.
    claimed = 0;
    let t = 0;
    result = await make(true).runBatch({ maxVideos: 4, startBudgetMs: 1000, clock: () => (t += 2000) });
    assert.equal(result.stoppedBy, 'time_budget');
    assert.equal(claimed, 1);

    await assert.rejects(make(true).runBatch({ maxVideos: 0 }), RangeError);
  });
});
