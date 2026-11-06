import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';
import { isCopyAuthorized } from '../../../../packages/config/src/security.js';
import { loadSearchKeyword } from '../../../../packages/config/src/keyword-file.js';
import { DURATION_STATUS, evaluateDuration, matchesSingleKeyword } from '../../../../packages/domain/src/index.js';
import { parseAlbumPage, parseNewListing } from '../../../../packages/source-erome/src/index.js';

function mergeListingPosts(pages) {
  const byId = new Map();
  for (const posts of pages) {
    for (const post of posts) {
      const previous = byId.get(post.id);
      if (!previous || post.title.length > previous.title.length) byId.set(post.id, post);
    }
  }
  return [...byId.values()];
}

function getErrorCode(error) {
  const allowed = new Set([
    'rate_limited', 'access_denied', 'redirect_rejected', 'request_timeout',
    'network_error', 'http_error', 'unexpected_content_type', 'response_too_large',
    'empty_response', 'parser_no_posts', 'parser_post_limit_exceeded', 'parser_listing_container_missing',
    'collector_timeout', 'collector_network_error', 'collector_invalid_response',
    'collector_request_failed', 'invalid_payload', 'collector_operation_failed',
    'unknown_operation',
  ]);
  return allowed.has(error?.code) ? error.code : 'scan_error';
}

// Rows in these states belong to the storage/retention pipeline; the scanner
// never changes them, so there is no reason to send them to the API.
const PIPELINE_STATUSES = new Set(['processing', 'error', 'stored', 'clicked', 'delete_pending', 'deleted']);

function evaluateVideo(post, video, keyword) {
  const matched = matchesSingleKeyword({
    title: post.title,
    tags: post.tags,
    keyword,
  });

  if (!matched) return { id: video.id, status: 'ignored' };

  const durationStatus = evaluateDuration(video.duration_ms);
  if (durationStatus === DURATION_STATUS.TOO_LONG) {
    return { id: video.id, status: 'too_long' };
  }
  if (durationStatus !== DURATION_STATUS.ACCEPTED) {
    return { id: video.id, status: 'duration_unknown' };
  }

  // This stage is metadata-only. No source media is fetched or copied.
  return {
    id: video.id,
    status: isCopyAuthorized() ? 'eligible' : 'copy_blocked',
  };
}

export class ScanService {
  #source;
  #repository;
  #keywordFilePath;
  #maxInspections;
  #logger;
  #now;

  constructor({
    sourceClient,
    repository,
    keywordFilePath,
    maxInspections = APP_CONFIG.scan.maxPostInspectionsPerRun,
    logger = console,
    now = () => new Date(),
  }) {
    if (!sourceClient || typeof sourceClient.fetchNewPage !== 'function' || typeof sourceClient.fetchAlbum !== 'function') {
      throw new TypeError('A public-source client is required.');
    }
    if (!repository) throw new TypeError('A collector repository is required.');
    if (!keywordFilePath) throw new TypeError('The search-keyword.txt path is required.');
    if (!Number.isSafeInteger(maxInspections) || maxInspections < 1 || maxInspections > 160) {
      throw new RangeError('maxInspections must be between 1 and 160.');
    }

    this.#source = sourceClient;
    this.#repository = repository;
    this.#keywordFilePath = keywordFilePath;
    this.#maxInspections = maxInspections;
    this.#logger = logger;
    this.#now = now;
  }

  async runOnce() {
    // Read on every run: editing config/search-keyword.txt takes effect on the
    // next scan without a dashboard, database setting, or process restart.
    const keyword = await loadSearchKeyword(this.#keywordFilePath);
    if (!keyword) {
      this.#logger.info?.('[ero-scrap] scan skipped: config/search-keyword.txt is empty.');
      return { status: 'skipped', reason: 'keyword_not_configured', pagesScanned: 0 };
    }

    const startedAt = this.#now().toISOString();
    const scanId = await this.#repository.createScanRun(startedAt);
    const pageResults = [];
    let pagesScanned = 0;
    let inspectionFailures = 0;
    let errorCode = null;

    try {
      // Hard-coded page list and source-client guard ensure pages >2 cannot be
      // requested accidentally through the collector.
      for (const pageNumber of [1, 2]) {
        try {
          const html = await this.#source.fetchNewPage(pageNumber);
          const posts = parseNewListing(html, pageNumber);
          // An existing #albums container with zero cards is a valid empty page.
          // The parser throws only when the expected container is missing.
          pageResults.push(posts);
          pagesScanned += 1;
        } catch (error) {
          errorCode = getErrorCode(error);
          if (pagesScanned === 0) throw error;
          break;
        }
      }

      const listingPosts = mergeListingPosts(pageResults);
      const listingIds = listingPosts.map((post) => post.id);

      // D1's free plan allows only 100,000 row writes per day, and every row costs one write
      // per index too. So the database receives ONLY posts that match the keyword. Which
      // albums were already looked at is remembered in one small row (a single write per scan,
      // and only when something new was checked), keyed by the keyword so changing it re-checks.
      const keywordKey = createHash('sha256').update(keyword.trim().toLowerCase()).digest('hex').slice(0, 16);
      const seen = new Set(await this.#repository.getSeenPosts(keywordKey));
      const pending = listingPosts.filter((post) => !seen.has(post.id)).slice(0, this.#maxInspections);
      const checked = new Set();

      for (const candidate of pending) {
        try {
          const html = await this.#source.fetchAlbum(candidate.canonicalUrl);
          const inspectedAt = this.#now().toISOString();
          const parsed = parseAlbumPage(html, candidate.canonicalUrl, { inspectedAt });
          const matched = matchesSingleKeyword({
            title: parsed.title || candidate.title,
            tags: parsed.tags.map((tag) => tag.name),
            keyword,
          });
          // Albums with only images, or that do not match, are never written to the database.
          if (matched && parsed.videos.length > 0) {
            await this.#repository.upsertListingPosts([candidate], inspectedAt);
            await this.#repository.savePostInspection(parsed, inspectedAt);
          }
          checked.add(candidate.id);
        } catch (error) {
          inspectionFailures += 1;
          errorCode ??= getErrorCode(error);
          if (error?.code === 'rate_limited' || error?.code === 'access_denied') break;
        }
      }

      if (checked.size > 0) {
        // Keep only ids still on pages 1-2; everything else can never be requested again.
        const nextSeen = listingIds.filter((id) => seen.has(id) || checked.has(id));
        await this.#repository.saveSeenPosts(keywordKey, nextSeen);
      }
      const inspectionBacklog = listingPosts.filter((post) => !seen.has(post.id) && !checked.has(post.id)).length;

      const snapshots = await this.#repository.getPostSnapshots(listingIds);
      const evaluations = [];
      let matchingPosts = 0;
      let videoCandidates = 0;
      let videosTooLong = 0;
      let videosWithUnknownDuration = 0;

      for (const snapshot of snapshots) {
        const matched = matchesSingleKeyword({
          title: snapshot.title,
          tags: snapshot.tags,
          keyword,
        });
        if (matched) matchingPosts += 1;

        for (const video of snapshot.videos) {
          const evaluation = evaluateVideo(snapshot, video, keyword);
          // Only changed rows travel to the API and reach D1. Without this the
          // whole visible window was rewritten every ten minutes.
          if (video.status !== evaluation.status && !PIPELINE_STATUSES.has(video.status)) {
            evaluations.push(evaluation);
          }
          if (evaluation.status === 'too_long') videosTooLong += 1;
          if (evaluation.status === 'duration_unknown') videosWithUnknownDuration += 1;
          if (matched && (evaluation.status === 'eligible' || evaluation.status === 'copy_blocked')) {
            videoCandidates += 1;
          }
        }
      }

      await this.#repository.updateEvaluations(evaluations, this.#now().toISOString());

      const status = errorCode || inspectionFailures > 0 || inspectionBacklog > 0 || pagesScanned < 2
        ? 'partial'
        : 'succeeded';
      const finishedAt = this.#now().toISOString();
      await this.#repository.finishScanRun(scanId, {
        finishedAt,
        status,
        pagesScanned,
        postsSeen: listingPosts.length,
        matchingPosts,
        videoCandidates,
        errorCode,
      });

      this.#logger.info?.('[ero-scrap] metadata scan completed', {
        status,
        pagesScanned,
        postsSeen: listingPosts.length,
        postsMatchingKeyword: matchingPosts,
        videosAcceptedByDuration: videoCandidates,
        videosTooLong,
        videosWithUnknownDuration,
        detailInspectionsAttempted: pending.length,
        inspectionFailures,
        inspectionBacklog,
        copyAuthorized: isCopyAuthorized(),
        mediaCopyPerformed: false,
      });

      return {
        scanId,
        status,
        pagesScanned,
        postsSeen: listingPosts.length,
        matchingPosts,
        videoCandidates,
        videosTooLong,
        videosWithUnknownDuration,
        detailInspectionsAttempted: pending.length,
        inspectionFailures,
        inspectionBacklog,
        errorCode,
        mediaCopyPerformed: false,
      };
    } catch (error) {
      const finishedAt = this.#now().toISOString();
      await this.#repository.finishScanRun(scanId, {
        finishedAt,
        status: 'failed',
        pagesScanned,
        postsSeen: pageResults.flat().length,
        matchingPosts: 0,
        videoCandidates: 0,
        errorCode: getErrorCode(error),
      }).catch(() => {});
      throw error;
    }
  }
}
