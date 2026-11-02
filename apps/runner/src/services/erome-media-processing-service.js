import { readFile } from 'node:fs/promises';
import { assertCopyAuthorized } from '../../../../packages/config/src/security.js';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';
import { loadSearchKeyword } from '../../../../packages/config/src/keyword-file.js';
import { matchesSingleKeyword } from '../../../../packages/domain/src/keywords.js';
import { parseAlbumPage } from '../../../../packages/source-erome/src/album-parser.js';

const SAFE_ERROR_CODE = /^[a-z0-9_-]{1,80}$/u;
const PERMANENT_ERROR_CODES = new Set([
  'source_access_restricted', 'media_redirect_rejected', 'media_url_rejected',
  'media_extension_unsupported', 'media_content_type_rejected', 'media_size_rejected',
  'media_length_invalid', 'media_metadata_incomplete', 'media_duration_mismatch',
  'media_duration_unknown', 'media_too_long', 'source_video_missing',
  'keyword_no_longer_matches', 'media_lease_stale', 'media_registration_rejected',
]);

function safeErrorCode(error) {
  const code = String(error?.code ?? 'media_processing_failed').toLowerCase();
  return SAFE_ERROR_CODE.test(code) ? code : 'media_processing_failed';
}

function toExpiresAt(uploadedAt) {
  return new Date(Date.parse(uploadedAt) + APP_CONFIG.retention.unopenedDays * 86_400_000).toISOString();
}

export class EromeMediaProcessingService {
  #repository;
  #source;
  #downloader;
  #inspector;
  #thumbnailGenerator;
  #storage;
  #keywordFilePath;
  #logger;
  #now;
  #maxJobs;
  #authorizeCopy;

  constructor({ repository, sourceClient, downloader, mediaInspector, thumbnailGenerator, storage,
    keywordFilePath, logger = console, now = () => new Date(), maxJobs = 1, authorizeCopy = assertCopyAuthorized }) {
    if (!repository || typeof repository.claimProcessVideoJobs !== 'function'
      || typeof repository.completeProcessVideoJob !== 'function'
      || typeof repository.failProcessVideoJob !== 'function') throw new TypeError('A media-job repository is required.');
    if (!sourceClient || typeof sourceClient.fetchAlbum !== 'function') throw new TypeError('An Erome source client is required.');
    if (!downloader || typeof downloader.download !== 'function') throw new TypeError('An Erome media downloader is required.');
    if (!mediaInspector || typeof mediaInspector.inspect !== 'function') throw new TypeError('A media inspector is required.');
    if (!thumbnailGenerator || typeof thumbnailGenerator.generate !== 'function') throw new TypeError('A thumbnail generator is required.');
    if (!storage || typeof storage.uploadLocalFile !== 'function') throw new TypeError('A MEGA storage provider is required.');
    if (typeof keywordFilePath !== 'string' || !keywordFilePath) throw new TypeError('The keyword file path is required.');
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 2) throw new RangeError('maxJobs must be 1 or 2.');
    this.#repository = repository;
    this.#source = sourceClient;
    this.#downloader = downloader;
    this.#inspector = mediaInspector;
    this.#thumbnailGenerator = thumbnailGenerator;
    this.#storage = storage;
    this.#keywordFilePath = keywordFilePath;
    this.#logger = logger;
    this.#now = now;
    if (typeof authorizeCopy !== 'function') throw new TypeError('authorizeCopy must be a function.');
    this.#authorizeCopy = authorizeCopy;
    this.#maxJobs = maxJobs;
  }

  async runOnce() {
    // This is deliberately the first operation: with the hard gate closed, the
    // service does not claim jobs, fetch album pages, or request media bytes.
    this.#authorizeCopy();
    const keyword = await loadSearchKeyword(this.#keywordFilePath);
    if (!keyword) return { claimed: 0, stored: 0, retried: 0, dead: 0, skipped: 'keyword_not_configured' };

    const jobs = await this.#repository.claimProcessVideoJobs({
      limit: this.#maxJobs,
      now: this.#now().toISOString(),
    });
    const results = { claimed: jobs.length, stored: 0, retried: 0, dead: 0, stale: 0 };

    for (const job of jobs) {
      let downloaded = null;
      let generated = null;
      try {
        if (typeof job.leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(job.leaseToken)) {
          throw Object.assign(new Error('Media lease token is invalid.'), { code: 'media_lease_invalid' });
        }
        if (!Number.isSafeInteger(job.durationMs) || job.durationMs <= 0 || job.durationMs > APP_CONFIG.media.maxDurationMs) {
          throw Object.assign(new Error('Stored metadata does not prove a duration within ten minutes.'), { code: 'media_duration_unknown' });
        }

        const html = await this.#source.fetchAlbum(job.canonicalUrl);
        const inspectedAt = this.#now().toISOString();
        const album = parseAlbumPage(html, job.canonicalUrl, { inspectedAt });
        if (!matchesSingleKeyword({ title: album.title, tags: album.tags.map((tag) => tag.name), keyword })) {
          throw Object.assign(new Error('The post no longer matches the configured keyword.'), { code: 'keyword_no_longer_matches' });
        }
        const media = album.videos.find((item) => item.sourceVideoId === job.sourceVideoId);
        if (!media || typeof media.mediaUrl !== 'string') {
          throw Object.assign(new Error('The identified video is no longer exposed by the public album page.'), { code: 'source_video_missing' });
        }
        if (!Number.isSafeInteger(media.durationMs) || media.durationMs <= 0) {
          throw Object.assign(new Error('The current public album page does not expose a confirmed video duration.'), { code: 'media_duration_unknown' });
        }
        if (media.durationMs > APP_CONFIG.media.maxDurationMs) {
          throw Object.assign(new Error('The current public album page reports a video longer than ten minutes.'), { code: 'media_too_long' });
        }
        if (Math.abs(media.durationMs - job.durationMs) > APP_CONFIG.media.durationMatchToleranceMs) {
          throw Object.assign(new Error('The video duration changed since discovery.'), { code: 'media_duration_mismatch' });
        }

        downloaded = await this.#downloader.download({
          mediaUrl: media.mediaUrl,
          albumUrl: job.canonicalUrl,
          assetId: job.assetId,
        });
        const actual = await this.#inspector.inspect({ localPath: downloaded.localPath });
        if (!Number.isSafeInteger(actual?.durationMs) || actual.durationMs <= 0) {
          throw Object.assign(new Error('FFprobe could not confirm the video duration.'), { code: 'media_duration_unknown' });
        }
        if (actual.durationMs > APP_CONFIG.media.maxDurationMs) {
          throw Object.assign(new Error('FFprobe confirmed a video longer than ten minutes.'), { code: 'media_too_long' });
        }
        if (Math.abs(actual.durationMs - job.durationMs) > APP_CONFIG.media.durationMatchToleranceMs
          || Math.abs(actual.durationMs - media.durationMs) > APP_CONFIG.media.durationMatchToleranceMs) {
          throw Object.assign(new Error('FFprobe duration does not match the current and stored metadata.'), { code: 'media_duration_mismatch' });
        }

        generated = await this.#thumbnailGenerator.generate({ localPath: downloaded.localPath });
        const thumbnailBytes = await readFile(generated.path);
        if (thumbnailBytes.byteLength < 12 || thumbnailBytes.byteLength > APP_CONFIG.media.thumbnailMaxBytes) {
          throw Object.assign(new Error('The generated WebP thumbnail is outside the configured size limit.'), { code: 'thumbnail_size_invalid' });
        }

        const uploaded = await this.#storage.uploadLocalFile({ assetId: job.assetId, localPath: downloaded.localPath });
        const uploadedAt = uploaded.uploadedAt ?? this.#now().toISOString();
        const expiresAt = toExpiresAt(uploadedAt);
        await this.#repository.completeProcessVideoJob({
          jobId: job.jobId,
          assetId: job.assetId,
          leaseToken: job.leaseToken,
          objectId: uploaded.objectId,
          shareUrl: uploaded.shareUrl,
          durationMs: actual.durationMs,
          uploadedAt,
          expiresAt,
        });

        let thumbnailStored = false;
        // The video is already registered, so a lost thumbnail only costs the
        // preview. One retry covers a transient network error without a new job.
        for (let attempt = 1; attempt <= 2 && !thumbnailStored; attempt += 1) {
          try {
            await this.#repository.uploadThumbnail(job.assetId, new Uint8Array(thumbnailBytes));
            thumbnailStored = true;
          } catch (error) {
            if (attempt === 2) {
              this.#logger.warn?.('[ero-scrap] media stored but thumbnail upload failed', {
                assetId: job.assetId,
                code: safeErrorCode(error),
              });
            }
          }
        }
        results.stored += 1;
        this.#logger.info?.('[ero-scrap] authorized Erome media stored', {
          assetId: job.assetId,
          durationMs: actual.durationMs,
          sizeBytes: downloaded.sizeBytes,
          expiresAt,
          thumbnailStored,
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        const attempts = PERMANENT_ERROR_CODES.has(errorCode) ? 8 : job.attempts;
        const outcome = await this.#repository.failProcessVideoJob({
          jobId: job.jobId,
          assetId: job.assetId,
          leaseToken: job.leaseToken,
          attempts,
          errorCode,
          now: this.#now().toISOString(),
        }).catch(() => ({ retry: true, dead: false, stale: false }));
        if (outcome.stale) results.stale += 1;
        else if (outcome.dead) results.dead += 1;
        else results.retried += 1;
        this.#logger.error?.('[ero-scrap] Erome media processing failed', {
          assetId: job.assetId,
          errorCode,
          attempt: job.attempts,
          dead: Boolean(outcome.dead),
        });
      } finally {
        if (generated?.cleanup) await generated.cleanup().catch(() => {});
        if (downloaded?.cleanup) await downloaded.cleanup().catch(() => {});
      }
    }

    this.#logger.info?.('[ero-scrap] Erome media processing pass completed', results);
    return results;
  }
}
