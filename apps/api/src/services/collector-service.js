import { isCopyAuthorized } from '../../../../packages/config/src/security.js';
import { isValidUnopenedExpiry, MAX_UNOPENED_DAYS } from '../../../../packages/config/src/retention-days.js';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';
import { isValidListingPage, MIN_LISTING_PAGES, MAX_LISTING_PAGES, MAX_LISTED_POSTS } from '../../../../packages/config/src/scan-pages.js';
import { CollectorRepository } from '../repositories/collector-repository.js';

const MAX_IDS = MAX_LISTED_POSTS;
const MAX_POST_BATCH = 160;
const MAX_VIDEO_BATCH = 5_000;
const POST_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/u;
const VIDEO_SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/u;
const VIDEO_ROW_ID_PATTERN = /^[a-f0-9]{32}$/u;
const VIDEO_STATUSES = new Set(['ignored', 'eligible', 'copy_blocked', 'too_long', 'duration_unknown', 'error']);
const SCAN_STATUSES = new Set(['succeeded', 'partial', 'failed', 'skipped']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}

function requireIsoDate(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid ISO date string.`);
  }
  return value;
}

function requireNonNegativeInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer between zero and ${max}.`);
  }
  return value;
}

function requireIds(value) {
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    throw new RangeError(`postIds must be an array with at most ${MAX_IDS} values.`);
  }
  if (value.some((id) => typeof id !== 'string' || !POST_ID_PATTERN.test(id))) {
    throw new TypeError('postIds contains an invalid post identifier.');
  }
  return [...new Set(value)];
}

function requireKeywordKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/u.test(value)) throw new TypeError('keywordKey is invalid.');
  return value;
}

function sanitizeListingPosts(value) {
  if (!Array.isArray(value) || value.length > MAX_POST_BATCH) {
    throw new RangeError(`posts must contain at most ${MAX_POST_BATCH} records.`);
  }

  return value.map((rawPost) => {
    const post = requireObject(rawPost, 'post');
    if (typeof post.id !== 'string' || !POST_ID_PATTERN.test(post.id)) {
      throw new TypeError('post.id is invalid.');
    }
    const canonicalUrl = `https://www.erome.com/a/${post.id}`;
    if (post.canonicalUrl !== canonicalUrl) {
      throw new TypeError('post.canonicalUrl must be the canonical public Erome album URL.');
    }
    if (typeof post.title !== 'string' || post.title.length < 1 || post.title.length > 300) {
      throw new TypeError('post.title must contain between 1 and 300 characters.');
    }
    if (!isValidListingPage(post.pageNumber)) {
      throw new RangeError(`post.pageNumber must be between ${MIN_LISTING_PAGES} and ${MAX_LISTING_PAGES}.`);
    }

    return {
      id: post.id,
      canonicalUrl,
      title: post.title.trim(),
      publishedAt: post.publishedAt == null ? null : requireIsoDate(post.publishedAt, 'post.publishedAt'),
    };
  });
}

function sanitizeInspection(value) {
  const inspection = requireObject(value, 'inspection');
  if (typeof inspection.postId !== 'string' || !POST_ID_PATTERN.test(inspection.postId)) {
    throw new TypeError('inspection.postId is invalid.');
  }
  if (typeof inspection.title !== 'string' || inspection.title.length > 300) {
    throw new TypeError('inspection.title must be a string of at most 300 characters.');
  }
  if (!Array.isArray(inspection.videos) || inspection.videos.length > 100) {
    throw new RangeError('inspection.videos must contain at most 100 video metadata records.');
  }
  if (!Array.isArray(inspection.tags) || inspection.tags.length > 40) {
    throw new RangeError('inspection.tags must contain at most 40 tags.');
  }

  const tags = inspection.tags.map((tag) => {
    requireObject(tag, 'inspection tag');
    if (typeof tag.name !== 'string' || tag.name.trim().length === 0 || tag.name.length > 80) {
      throw new TypeError('Tag name must contain between 1 and 80 characters.');
    }
    if (tag.normalizedName != null
      && (typeof tag.normalizedName !== 'string' || tag.normalizedName.length > 120)) {
      throw new TypeError('Tag normalizedName must be a string of at most 120 characters.');
    }
    return {
      name: tag.name.trim(),
      normalizedName: tag.normalizedName,
    };
  });

  const videos = inspection.videos.map((video) => {
    requireObject(video, 'inspection video');
    if (typeof video.sourceVideoId !== 'string' || !VIDEO_SOURCE_ID_PATTERN.test(video.sourceVideoId)) {
      throw new TypeError('Video sourceVideoId is invalid.');
    }
    if (video.durationMs != null && (!Number.isSafeInteger(video.durationMs) || video.durationMs <= 0)) {
      throw new TypeError('Video durationMs must be a positive safe integer or null.');
    }
    return {
      sourceVideoId: video.sourceVideoId,
      durationMs: video.durationMs ?? null,
    };
  });

  return {
    postId: inspection.postId,
    title: inspection.title.trim(),
    inspectedAt: requireIsoDate(inspection.inspectedAt, 'inspection.inspectedAt'),
    tags,
    // Source media URLs and any unexpected metadata are discarded at this boundary.
    videos,
  };
}

function sanitizeEvaluations(value) {
  if (!Array.isArray(value) || value.length > MAX_VIDEO_BATCH) {
    throw new RangeError(`evaluations must contain at most ${MAX_VIDEO_BATCH} records.`);
  }
  return value.map((raw) => {
    const item = requireObject(raw, 'video evaluation');
    if (typeof item.id !== 'string' || !VIDEO_ROW_ID_PATTERN.test(item.id)) {
      throw new TypeError('Video evaluation ID is invalid.');
    }
    if (!VIDEO_STATUSES.has(item.status)) {
      throw new TypeError('Video evaluation status is invalid.');
    }
    if (item.status === 'eligible' && !isCopyAuthorized()) {
      throw new TypeError('Video cannot be marked eligible while COPY_AUTHORIZED is false.');
    }
    return { id: item.id, status: item.status };
  });
}

/**
 * Narrow internal command surface used only by the external metadata runner.
 * No generic SQL execution is exposed through HTTP.
 */
export async function executeCollectorCommand(db, operation, rawPayload, { thumbnails = null } = {}) {
  const payload = requireObject(rawPayload, 'payload');
  const repository = new CollectorRepository(db);

  switch (operation) {
    case 'scan.create':
      return { scanId: await repository.createScanRun(requireIsoDate(payload.startedAt, 'startedAt')) };

    case 'scan.finish': {
      if (typeof payload.id !== 'string' || !/^[a-f0-9-]{36}$/iu.test(payload.id)) {
        throw new TypeError('scan.id must be a UUID.');
      }
      if (!SCAN_STATUSES.has(payload.status)) throw new TypeError('scan.status is invalid.');
      await repository.finishScanRun(payload.id, {
        finishedAt: requireIsoDate(payload.finishedAt, 'finishedAt'),
        status: payload.status,
        pagesScanned: requireNonNegativeInteger(payload.pagesScanned, 'pagesScanned', MAX_LISTING_PAGES),
        postsSeen: requireNonNegativeInteger(payload.postsSeen, 'postsSeen', MAX_LISTED_POSTS),
        matchingPosts: requireNonNegativeInteger(payload.matchingPosts, 'matchingPosts', MAX_LISTED_POSTS),
        videoCandidates: requireNonNegativeInteger(payload.videoCandidates, 'videoCandidates', MAX_VIDEO_BATCH),
        errorCode: payload.errorCode == null ? null : String(payload.errorCode).slice(0, 80),
      });
      return { ok: true };
    }

    case 'posts.upsert':
      await repository.upsertListingPosts(sanitizeListingPosts(payload.posts), requireIsoDate(payload.now, 'now'));
      return { ok: true };

    case 'scan.seen.get': {
      return { ids: await repository.getSeenPosts(requireKeywordKey(payload.keywordKey)) };
    }

    case 'scan.seen.save':
      await repository.saveSeenPosts(requireKeywordKey(payload.keywordKey), requireIds(payload.ids));
      return { ok: true };

    case 'posts.pending': {
      const postIds = requireIds(payload.postIds);
      if (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > MAX_IDS) {
        throw new RangeError(`limit must be between 1 and ${MAX_IDS}.`);
      }
      if (typeof payload.keyword !== 'string' || payload.keyword.trim().length === 0 || payload.keyword.length > 80) {
        throw new TypeError('keyword must be a non-empty string of at most 80 characters.');
      }
      return { posts: await repository.getPendingInspection(postIds, payload.limit, payload.keyword) };
    }

    case 'post.inspect':
      await repository.savePostInspection(sanitizeInspection(payload.inspection), requireIsoDate(payload.now, 'now'));
      return { ok: true };

    case 'posts.snapshots':
      return { posts: await repository.getPostSnapshots(requireIds(payload.postIds)) };

    case 'videos.evaluate':
      await repository.updateEvaluations(sanitizeEvaluations(payload.evaluations), requireIsoDate(payload.now, 'now'));
      return { ok: true };

    case 'process.hasDue': {
      if (!isCopyAuthorized()) return { due: false };
      const now = requireIsoDate(payload.now, 'now');
      return { due: await repository.hasDueProcessVideoJobs({ now }) };
    }

    case 'process.claim': {
      if (!isCopyAuthorized()) throw new TypeError('Video processing is blocked while COPY_AUTHORIZED is false.');
      const now = requireIsoDate(payload.now, 'now');
      const limit = requireNonNegativeInteger(payload.limit ?? 1, 'limit', 2);
      if (limit < 1) throw new RangeError('limit must be at least 1.');
      return { jobs: await repository.claimProcessVideoJobs({ now, limit }) };
    }

    case 'process.complete': {
      if (!isCopyAuthorized()) throw new TypeError('Video completion is blocked while COPY_AUTHORIZED is false.');
      if (typeof payload.jobId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(payload.jobId)) throw new TypeError('jobId must be a UUID.');
      if (typeof payload.assetId !== 'string' || !VIDEO_ROW_ID_PATTERN.test(payload.assetId)) throw new TypeError('assetId is invalid.');
      if (typeof payload.leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(payload.leaseToken)) throw new TypeError('leaseToken is invalid.');
      if (typeof payload.objectId !== 'string' || payload.objectId.length > 512 || !payload.objectId.startsWith('/')) throw new TypeError('objectId is invalid.');
      const segments = payload.objectId.split('/').filter(Boolean);
      const filename = segments.at(-1) ?? '';
      if (segments.length < 3 || segments.at(-2) !== payload.assetId
        || segments.some((part) => part === '.' || part === '..' || /[\\\u0000-\u001f]/u.test(part))
        || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}\.(?:mp4|m4v|mov|mkv|webm|ogv)$/iu.test(filename)) {
        throw new TypeError('objectId must be a video file inside the matching asset folder.');
      }
      if (typeof payload.shareUrl !== 'string' || payload.shareUrl.length > 2_048) throw new TypeError('shareUrl is invalid.');
      const shareUrl = new URL(payload.shareUrl);
      const modernLink = /^\/file\/[A-Za-z0-9_-]+$/u.test(shareUrl.pathname);
      const legacyLink = shareUrl.pathname === '/' && /^#[A-Za-z0-9!_-]+$/u.test(shareUrl.hash);
      if (shareUrl.protocol !== 'https:' || shareUrl.hostname !== 'mega.nz' || shareUrl.username || shareUrl.password
        || shareUrl.port || shareUrl.search || (!modernLink && !legacyLink) || shareUrl.hash.length < 2) {
        throw new TypeError('shareUrl must be a valid MEGA file link.');
      }
      const durationMs = requireNonNegativeInteger(payload.durationMs, 'durationMs', APP_CONFIG.media.maxDurationMs);
      if (durationMs < 1) throw new RangeError('durationMs must be at least 1.');
      const uploadedAt = requireIsoDate(payload.uploadedAt, 'uploadedAt');
      const expiresAt = requireIsoDate(payload.expiresAt, 'expiresAt');
      if (!isValidUnopenedExpiry(uploadedAt, expiresAt)) {
        throw new TypeError('Unopened media expiry must be a whole number of days (1 to 7) after upload.');
      }
      return repository.completeProcessVideoJob({
        jobId: payload.jobId,
        assetId: payload.assetId,
        leaseToken: payload.leaseToken,
        objectId: payload.objectId,
        shareUrl: shareUrl.toString(),
        durationMs,
        uploadedAt,
        expiresAt,
      });
    }

    case 'process.fail': {
      if (typeof payload.jobId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(payload.jobId)) throw new TypeError('jobId must be a UUID.');
      if (typeof payload.assetId !== 'string' || !VIDEO_ROW_ID_PATTERN.test(payload.assetId)) throw new TypeError('assetId is invalid.');
      if (typeof payload.leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(payload.leaseToken)) throw new TypeError('leaseToken is invalid.');
      const attempts = requireNonNegativeInteger(payload.attempts, 'attempts', 100);
      if (attempts < 1) throw new RangeError('attempts must be at least 1.');
      const errorCode = typeof payload.errorCode === 'string' && /^[a-z0-9_-]{1,80}$/u.test(payload.errorCode)
        ? payload.errorCode : 'media_processing_failed';
      return repository.failProcessVideoJob({
        jobId: payload.jobId,
        assetId: payload.assetId,
        leaseToken: payload.leaseToken,
        attempts,
        errorCode,
        now: requireIsoDate(payload.now, 'now'),
      });
    }

    case 'media.register': {
      if (!isCopyAuthorized()) throw new TypeError('Media registration is blocked while COPY_AUTHORIZED is false.');
      if (typeof payload.assetId !== 'string' || !VIDEO_ROW_ID_PATTERN.test(payload.assetId)) {
        throw new TypeError('assetId is invalid.');
      }
      if (typeof payload.objectId !== 'string' || payload.objectId.length < 16 || payload.objectId.length > 512
        || !payload.objectId.startsWith('/') || payload.objectId.includes('\\') || /[\u0000-\u001f]/u.test(payload.objectId)) {
        throw new TypeError('MEGA objectId is invalid.');
      }
      const objectSegments = payload.objectId.split('/').filter(Boolean);
      const filename = objectSegments.at(-1) ?? '';
      const assetFolder = objectSegments.at(-2) ?? '';
      if (objectSegments.length < 3 || assetFolder !== payload.assetId
        || objectSegments.some((segment) => segment === '.' || segment === '..' || segment.length > 160)
        || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}$/u.test(filename)
        || !/\.(?:mp4|m4v|mov|mkv|webm)$/iu.test(filename)) {
        throw new TypeError('MEGA objectId must identify a video file inside the matching asset folder.');
      }
      if (typeof payload.shareUrl !== 'string' || payload.shareUrl.length > 2_048) {
        throw new TypeError('shareUrl is invalid.');
      }
      const shareUrl = new URL(payload.shareUrl);
      const modernFileLink = /^\/(?:file|folder)\/[A-Za-z0-9_-]+$/u.test(shareUrl.pathname);
      const legacyFileLink = shareUrl.pathname === '/' && /^#(?:F!)?[A-Za-z0-9!_-]+$/u.test(shareUrl.hash);
      if (shareUrl.protocol !== 'https:' || shareUrl.hostname !== 'mega.nz'
        || shareUrl.username || shareUrl.password || shareUrl.port || shareUrl.search
        || (!modernFileLink && !legacyFileLink) || shareUrl.hash.length < 2) {
        throw new TypeError('shareUrl must be a valid HTTPS MEGA file/folder share link.');
      }
      const durationMs = requireNonNegativeInteger(payload.durationMs, 'durationMs', APP_CONFIG.media.maxDurationMs);
      if (durationMs < 1) throw new RangeError('durationMs must be at least 1.');
      const uploadedAt = requireIsoDate(payload.uploadedAt, 'uploadedAt');
      const expiresAt = requireIsoDate(payload.expiresAt, 'expiresAt');
      if (!isValidUnopenedExpiry(uploadedAt, expiresAt)) {
        throw new TypeError('Unopened media expiry must be a whole number of days (1 to 7) after upload.');
      }
      await repository.registerStoredMedia({
        assetId: payload.assetId,
        objectId: payload.objectId,
        shareUrl: shareUrl.toString(),
        durationMs,
        uploadedAt,
        expiresAt,
      });
      return { registered: true };
    }

    case 'maintenance.prune': {
      const { staleMetadataDays, discardedMetadataDays, finishedJobDays, batchSize } = APP_CONFIG.maintenance;
      return repository.pruneStale({
        now: requireIsoDate(payload.now, 'now'),
        continuation: payload.continuation === true,
        unopenedDays: Number.isInteger(payload.unopenedDays) && payload.unopenedDays >= 1 && payload.unopenedDays <= MAX_UNOPENED_DAYS ? payload.unopenedDays : null,
        retainDays: staleMetadataDays,
        discardedDays: discardedMetadataDays,
        jobRetainDays: finishedJobDays,
        batchSize,
      });
    }

    case 'retention.hasDue': {
      const now = requireIsoDate(payload.now, 'now');
      return { due: await repository.hasDueDeletionJobs({ now }) };
    }

    case 'retention.claim': {
      const now = requireIsoDate(payload.now, 'now');
      const limit = requireNonNegativeInteger(payload.limit ?? 20, 'limit', 50);
      if (limit < 1) throw new RangeError('limit must be at least 1.');
      return { jobs: await repository.claimDueDeletionJobs({ now, limit }) };
    }

    case 'retention.complete': {
      const jobId = payload.jobId;
      const assetId = payload.assetId;
      if (typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(jobId)) throw new TypeError('jobId must be a UUID.');
      if (typeof assetId !== 'string' || !VIDEO_ROW_ID_PATTERN.test(assetId)) throw new TypeError('assetId is invalid.');
      const leaseToken = payload.leaseToken;
      if (typeof leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(leaseToken)) {
        throw new TypeError('leaseToken must be a 32-character hexadecimal token.');
      }
      const key = await repository.getDeletionThumbnailKey({ assetId, jobId, leaseToken });
      if (key) {
        if (!thumbnails || typeof thumbnails.delete !== 'function') {
          throw new Error('Thumbnail storage is unavailable; catalog deletion is deferred.');
        }
        await thumbnails.delete(key);
      }
      return repository.completeDeletion({ jobId, assetId, leaseToken, now: requireIsoDate(payload.now, 'now') });
    }

    case 'retention.fail': {
      if (typeof payload.jobId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(payload.jobId)) {
        throw new TypeError('jobId must be a UUID.');
      }
      const leaseToken = payload.leaseToken;
      if (typeof leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(leaseToken)) {
        throw new TypeError('leaseToken must be a 32-character hexadecimal token.');
      }
      const attempts = requireNonNegativeInteger(payload.attempts, 'attempts', 100);
      if (attempts < 1) throw new RangeError('attempts must be at least 1.');
      const errorCode = typeof payload.errorCode === 'string' && /^[a-z0-9_-]{1,80}$/u.test(payload.errorCode)
        ? payload.errorCode : 'storage_delete_failed';
      return repository.failDeletion({ jobId: payload.jobId, leaseToken, attempts, errorCode, now: requireIsoDate(payload.now, 'now') });
    }

    default:
      throw Object.assign(new Error('Unknown collector operation.'), { code: 'unknown_operation' });
  }
}
