import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanService } from '../../apps/runner/src/services/scan-service.js';
import { COPY_AUTHORIZED } from '../../packages/config/src/security.js';

const listingPage1 = `<!doctype html><html><body><div id="albums">
  <div class="album"><a class="album-link" href="/a/Title1234"></a><a class="album-title">needle appears in title</a></div>
  <div class="album"><a class="album-link" href="/a/Tagg5678"></a><a class="album-title">ordinary title</a></div>
  <div class="album"><a class="album-link" href="/a/ImgOnly1"></a><a class="album-title">needle images only</a></div>
</div></body></html>`;
const listingPage2 = `<!doctype html><html><body><div id="albums">
  <div class="album"><a class="album-link" href="/a/Other1234"></a><a class="album-title">unrelated title</a></div>
</div></body></html>`;

const albumPages = new Map([
  ['/a/Title1234', `<!doctype html><html><body>
    <h1>needle appears in title</h1>
    <video data-duration="10:00"><source src="https://v19.erome.com/1234/Title1234/VideoOne.mp4"></video>
    <video data-duration="10:01"><source src="https://v19.erome.com/1234/Title1234/VideoTwo.mp4"></video>
    <video><source src="https://v19.erome.com/1234/Title1234/VideoThree.mp4"></video>
    <img src="https://s63.erome.com/1234/Title1234/PhotoOne.jpg">
  </body></html>`],
  ['/a/Tagg5678', `<!doctype html><html><body>
    <h1>ordinary title</h1>
    <a class="tag" href="/tags/needle">#needle</a>
    <video data-duration="09:59"><source src="https://v19.erome.com/1234/Tagg5678/VideoFour.mp4"></video>
  </body></html>`],
  ['/a/ImgOnly1', `<!doctype html><html><body>
    <h1>needle images only</h1>
    <img src="https://s63.erome.com/1234/ImgOnly1/PhotoOne.jpg">
    <img src="https://s63.erome.com/1234/ImgOnly1/PhotoTwo.jpg">
  </body></html>`],
  ['/a/Other1234', `<!doctype html><html><body>
    <h1>unrelated title</h1>
    <video data-duration="01:00"><source src="https://v19.erome.com/1234/Other1234/VideoFive.mp4"></video>
  </body></html>`],
]);

class FakeRepository {
  posts = new Map();
  details = new Map();
  evaluations = [];
  scan = null;
  seen = { keywordKey: null, ids: [] };
  seenWrites = 0;

  async getSeenPosts(keywordKey) { return this.seen.keywordKey === keywordKey ? this.seen.ids : []; }
  async saveSeenPosts(keywordKey, ids) { this.seen = { keywordKey, ids: [...ids] }; this.seenWrites += 1; }

  async createScanRun(startedAt) {
    this.scan = { id: 'scan-test', startedAt };
    return this.scan.id;
  }

  async finishScanRun(id, values) {
    assert.equal(id, 'scan-test');
    this.scan = { ...this.scan, ...values };
  }

  async upsertListingPosts(posts) {
    for (const post of posts) {
      this.posts.set(post.id, {
        id: post.id,
        canonical_url: post.canonicalUrl,
        title: post.title,
        discovered_at: '2026-11-01T00:00:00.000Z',
        details_checked_at: null,
      });
    }
  }

  async getPendingInspection(postIds, limit) {
    return postIds
      .filter((id) => this.posts.has(id) && !this.details.has(id))
      .slice(0, limit)
      .map((id) => this.posts.get(id));
  }

  async savePostInspection(inspection) {
    // This repository mock stores structured metadata only, never source URLs.
    this.details.set(inspection.postId, {
      title: inspection.title,
      tags: inspection.tags.map((tag) => tag.name),
      details_checked_at: inspection.inspectedAt,
      videos: inspection.videos.map((video, index) => ({
        id: `${inspection.postId}-video-${index}`,
        duration_ms: video.durationMs,
        status: 'discovered',
      })),
    });
  }

  async getPostSnapshots(postIds) {
    return postIds.filter((id) => this.posts.has(id)).map((id) => {
      const post = this.posts.get(id);
      const details = this.details.get(id);
      return {
        id,
        title: details?.title ?? post.title,
        tags: details?.tags ?? [],
        details_checked_at: details?.details_checked_at ?? post.details_checked_at,
        videos: details?.videos ?? [],
      };
    });
  }

  async updateEvaluations(items) {
    this.evaluations.push(...items);
  }
}

async function withKeyword(contents, run) {
  const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-scan-'));
  const filePath = join(directory, 'search-keyword.txt');
  try {
    await writeFile(filePath, contents, 'utf8');
    await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// A matching, short-enough video is 'eligible' when the gate is open and 'copy_blocked' when closed.
const CANDIDATE = COPY_AUTHORIZED ? 'eligible' : 'copy_blocked';

test('scan reads exactly the configured New pages and matches title OR tags', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const fetchedPages = [];
    const fetchedAlbums = [];
    const sourceClient = {
      async fetchNewPage(pageNumber) {
        fetchedPages.push(pageNumber);
        return pageNumber === 1 ? listingPage1 : listingPage2;
      },
      async fetchAlbum(url) {
        const path = new URL(url).pathname;
        fetchedAlbums.push(path);
        const html = albumPages.get(path);
        if (!html) throw new Error(`Unexpected album fetch: ${path}`);
        return html;
      },
    };
    const repository = new FakeRepository();
    const logs = [];
    const service = new ScanService({
      sourceClient,
      listingPages: 2,
      repository,
      keywordFilePath,
      logger: { info: (...values) => logs.push(values), error() {} },
      now: () => new Date('2026-11-01T00:00:00.000Z'),
    });

    const result = await service.runOnce();

    assert.deepEqual(fetchedPages, [1, 2]);
    assert.deepEqual(fetchedAlbums.sort(), ['/a/ImgOnly1', '/a/Other1234', '/a/Tagg5678', '/a/Title1234'].sort());
    assert.equal(result.pagesScanned, 2);
    assert.equal(result.postsSeen, 4);
    assert.equal(result.matchingPosts, 2); // Only stored posts count: the title match and the tag-only match.
    assert.equal(result.videoCandidates, 2); // Exactly 10:00 and 09:59.
    assert.equal(result.videosTooLong, 1);
    assert.equal(result.videosWithUnknownDuration, 1);
    assert.equal(result.mediaCopyPerformed, false); // The scan never copies media itself.

    const statuses = new Map(repository.evaluations.map((item) => [item.id, item.status]));
    assert.equal(statuses.get('Title1234-video-0'), CANDIDATE);
    assert.equal(statuses.get('Title1234-video-1'), 'too_long');
    assert.equal(statuses.get('Title1234-video-2'), 'duration_unknown');
    assert.equal(statuses.get('Tagg5678-video-0'), CANDIDATE);
    // Posts that do not match, and albums with only images, never reach the database.
    assert.equal(repository.posts.has('Other1234'), false);
    assert.equal(repository.posts.has('ImgOnly1'), false);
    assert.equal(repository.details.has('Other1234'), false);
    assert.equal(repository.seenWrites, 1);
    assert.deepEqual([...repository.seen.ids].sort(), ['ImgOnly1', 'Other1234', 'Tagg5678', 'Title1234']);
    assert.equal(result.status, 'succeeded');
    assert.equal(repository.scan.status, 'succeeded');
    assert.ok(logs.length > 0);
  });
});

test('empty keyword disables the scan before any source or database operation', async () => {
  await withKeyword('', async (keywordFilePath) => {
    let sourceCalls = 0;
    let repositoryCalls = 0;
    const service = new ScanService({
      sourceClient: {
        async fetchNewPage() { sourceCalls += 1; return listingPage1; },
        async fetchAlbum() { sourceCalls += 1; return ''; },
      },
      repository: {
        async createScanRun() { repositoryCalls += 1; },
      },
      keywordFilePath,
      logger: { info() {} },
    });

    const result = await service.runOnce();
    assert.equal(result.status, 'skipped');
    assert.equal(sourceCalls, 0);
    assert.equal(repositoryCalls, 0);
  });
});

test('keyword is reloaded from the same file at each run', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const repository = new FakeRepository();
    let titleFetches = 0;
    const sourceClient = {
      async fetchNewPage(pageNumber) { return pageNumber === 1 ? listingPage1 : listingPage2; },
      async fetchAlbum(url) { titleFetches += 1; return albumPages.get(new URL(url).pathname); },
    };
    const service = new ScanService({ sourceClient, repository, keywordFilePath, logger: { info() {} } });
    await service.runOnce();
    const firstCandidates = repository.evaluations.filter((item) => item.status === CANDIDATE).length;

    await writeFile(keywordFilePath, 'ordinary', 'utf8');
    await service.runOnce();
    const latestStatuses = new Map(repository.evaluations.map((item) => [item.id, item.status]));
    const latestCandidates = [...latestStatuses.values()].filter((status) => status === CANDIDATE).length;

    assert.ok(firstCandidates > 0);
    assert.equal(latestCandidates, 1); // The tag/title match changes without a restart.
    assert.equal(titleFetches, 8); // A new keyword re-checks every album once.

    await service.runOnce();
    assert.equal(titleFetches, 8); // The same keyword never fetches an examined album again.
  });
});


test('scan accepts a valid empty second New page', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const repository = new FakeRepository();
    const requestedPages = [];
    const service = new ScanService({
      sourceClient: {
        async fetchNewPage(pageNumber) {
          requestedPages.push(pageNumber);
          return pageNumber === 1 ? listingPage1 : '<div id="albums"></div>';
        },
        async fetchAlbum(url) { return albumPages.get(new URL(url).pathname); },
      },
      repository,
      listingPages: 2,
      keywordFilePath,
      logger: { info() {} },
    });

    const result = await service.runOnce();
    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(result.pagesScanned, 2);
    assert.equal(result.postsSeen, 3);
    assert.equal(result.status, 'succeeded');
  });
});


test('scan sends only evaluations that change a video status', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const repository = new FakeRepository();
    const sent = [];
    repository.updateEvaluations = async (items) => { sent.push(...items); };
    repository.getPostSnapshots = async () => [{
      id: 'AAAA1111', title: 'needle post', tags: [], details_checked_at: '2026-11-01T00:00:00.000Z',
      videos: [
        { id: 'v-unchanged', duration_ms: 30_000, status: CANDIDATE },
        { id: 'v-changed', duration_ms: 900_000, status: CANDIDATE },
        { id: 'v-stored', duration_ms: 30_000, status: 'stored' },
        { id: 'v-clicked', duration_ms: 900_000, status: 'clicked' },
        { id: 'v-processing', duration_ms: 30_000, status: 'processing' },
        { id: 'v-error', duration_ms: 30_000, status: 'error' },
      ],
    }];
    const sourceClient = { async fetchNewPage() { return listingPage1; }, async fetchAlbum() { throw new Error('no album'); } };
    const service = new ScanService({ sourceClient, repository, keywordFilePath, logger: { info() {}, error() {} } });
    await service.runOnce();
    assert.deepEqual(sent, [{ id: 'v-changed', status: 'too_long' }]);
  });
});


test('a quiet scan writes nothing to the database besides the scan record', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const repository = new FakeRepository();
    const writes = [];
    for (const method of ['upsertListingPosts', 'savePostInspection', 'updateEvaluations']) {
      const original = repository[method].bind(repository);
      repository[method] = async (...args) => { writes.push(method); return original(...args); };
    }
    const sourceClient = {
      async fetchNewPage(pageNumber) { return pageNumber === 1 ? listingPage1 : listingPage2; },
      async fetchAlbum(url) { return albumPages.get(new URL(url).pathname); },
    };
    const service = new ScanService({ sourceClient, repository, keywordFilePath, logger: { info() {} } });
    await service.runOnce();
    writes.length = 0;
    const seenWritesBefore = repository.seenWrites;
    await service.runOnce();
    assert.deepEqual(writes.filter((name) => name !== 'updateEvaluations'), []);
    assert.equal(repository.seenWrites, seenWritesBefore);
  });
});


test('scan reads 4 New pages by default and stops cleanly at the configured depth', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const run = async (listingPages) => {
      const requestedPages = [];
      const service = new ScanService({
        sourceClient: {
          async fetchNewPage(pageNumber) {
            requestedPages.push(pageNumber);
            return pageNumber === 1 ? listingPage1 : '<div id="albums"></div>';
          },
          async fetchAlbum(url) { return albumPages.get(new URL(url).pathname); },
        },
        repository: new FakeRepository(),
        keywordFilePath,
        logger: { info() {} },
        ...(listingPages ? { listingPages } : {}),
      });
      const result = await service.runOnce();
      return { requestedPages, result };
    };

    const byDefault = await run();
    assert.deepEqual(byDefault.requestedPages, [1, 2, 3, 4]);
    assert.equal(byDefault.result.pagesScanned, 4);
    assert.equal(byDefault.result.status, 'succeeded');

    const three = await run(3);
    assert.deepEqual(three.requestedPages, [1, 2, 3]);
    assert.equal(three.result.pagesScanned, 3);
  });
});

test('scan is partial when a later page fails, and rejects an invalid page depth', async () => {
  await withKeyword('needle', async (keywordFilePath) => {
    const warnings = [];
    const service = new ScanService({
      sourceClient: {
        async fetchNewPage(pageNumber) {
          if (pageNumber === 3) throw Object.assign(new Error('boom'), { code: 'http_error', status: 503 });
          return pageNumber === 1 ? listingPage1 : '<div id="albums"></div>';
        },
        async fetchAlbum(url) { return albumPages.get(new URL(url).pathname); },
      },
      repository: new FakeRepository(),
      keywordFilePath,
      logger: { info() {}, warn(message, details) { warnings.push(details); } },
    });
    const result = await service.runOnce();
    assert.equal(result.pagesScanned, 2);
    assert.equal(result.status, 'partial');
    assert.deepEqual(warnings.find((entry) => entry.page === 3)?.httpStatus, 503);

    for (const listingPages of [0, 7, 2.5]) {
      assert.throws(() => new ScanService({
        sourceClient: { fetchNewPage() {}, fetchAlbum() {} },
        repository: new FakeRepository(),
        keywordFilePath,
        listingPages,
      }), RangeError);
    }
  });
});
