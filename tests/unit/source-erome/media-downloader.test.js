import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EromeMediaDownloader, EromeDownloadError } from '../../../packages/source-erome/src/media-downloader.js';
import { COPY_AUTHORIZED } from '../../../packages/config/src/security.js';

const ASSET_ID = 'a'.repeat(32);
const ALBUM_URL = 'https://www.erome.com/a/AbCd1234';
const MEDIA_URL = 'https://v19.erome.com/1234/AbCd1234/VideoAbcd1234.mp4';

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-downloader-test-'));
  try { await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('downloader streams a public Erome video to a private temporary file and uses the normal site referrer', async () => {
  await temporaryDirectory(async (temporaryRoot) => {
    let request;
    const downloader = new EromeMediaDownloader({
      temporaryRoot,
      authorizeCopy() {},
      fetchImpl: async (url, options) => {
        request = { url: String(url), options };
        return new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': '6' },
        });
      },
    });

    const downloaded = await downloader.download({ mediaUrl: MEDIA_URL, albumUrl: ALBUM_URL, assetId: ASSET_ID });
    try {
      assert.equal(request.url, MEDIA_URL);
      assert.equal(request.options.redirect, 'manual');
      assert.equal(request.options.headers.Referer, 'https://www.erome.com/');
      assert.equal(request.options.headers.Cookie, undefined);
      assert.deepEqual(await readFile(downloaded.localPath), Buffer.from([0, 1, 2, 3, 4, 5]));
      assert.equal(downloaded.sizeBytes, 6);
      assert.equal((await readdir(temporaryRoot)).length, 1);
    } finally {
      await downloaded.cleanup();
    }
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test('downloader stops on HTTP 403 without trying credentials, redirects, or alternate hosts', async () => {
  await temporaryDirectory(async (temporaryRoot) => {
    let requestCount = 0;
    const downloader = new EromeMediaDownloader({
      temporaryRoot,
      authorizeCopy() {},
      fetchImpl: async () => { requestCount += 1; return new Response('denied', { status: 403 }); },
    });
    await assert.rejects(
      downloader.download({ mediaUrl: MEDIA_URL, albumUrl: ALBUM_URL, assetId: ASSET_ID }),
      (error) => error instanceof EromeDownloadError && error.code === 'source_access_restricted',
    );
    assert.equal(requestCount, 1);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test('downloader rejects redirects and foreign media destinations before following them', async () => {
  let requestCount = 0;
  const downloader = new EromeMediaDownloader({
    authorizeCopy() {},
    fetchImpl: async () => { requestCount += 1; return new Response(null, { status: 302, headers: { Location: 'https://outside.example/video.mp4' } }); },
  });
  await assert.rejects(
    downloader.download({ mediaUrl: MEDIA_URL, albumUrl: ALBUM_URL, assetId: ASSET_ID }),
    (error) => error instanceof EromeDownloadError && error.code === 'media_redirect_rejected',
  );
  await assert.rejects(
    downloader.download({ mediaUrl: 'https://outside.example/video.mp4', albumUrl: ALBUM_URL, assetId: ASSET_ID }),
    (error) => error instanceof EromeDownloadError && error.code === 'media_url_rejected',
  );
  assert.equal(requestCount, 1);
});


test('downloader hard gate blocks a direct call before URL validation or network access', async () => {
  assert.equal(COPY_AUTHORIZED, false);
  let requests = 0;
  const downloader = new EromeMediaDownloader({
    fetchImpl: async () => { requests += 1; return new Response(new Uint8Array([1]), { status: 200 }); },
  });
  await assert.rejects(
    downloader.download({ mediaUrl: MEDIA_URL, albumUrl: ALBUM_URL, assetId: ASSET_ID }),
    (error) => error.code === 'COPY_NOT_AUTHORIZED',
  );
  assert.equal(requests, 0);
});
