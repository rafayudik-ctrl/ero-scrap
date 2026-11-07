import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG } from '../../config/src/app.js';
import { assertCopyAuthorized } from '../../config/src/security.js';
import { classifyMediaUrl, normalizeAlbumUrl } from './normalizers.js';

const ASSET_ID_PATTERN = /^[a-f0-9]{32}$/u;
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv']);
const USER_AGENT = 'Ero-Scrap/0.5.0 (public media URL; authorized transfers only)';

export class EromeDownloadError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'EromeDownloadError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

function validateSourceUrl(mediaUrl) {
  if (typeof mediaUrl !== 'string' || mediaUrl.length > 4_096 || classifyMediaUrl(mediaUrl) !== 'video') {
    throw new EromeDownloadError('media_url_rejected', 'The page did not expose a supported public Erome video URL.');
  }
  const url = new URL(mediaUrl);
  if (url.username || url.password || url.port || url.hash) {
    throw new EromeDownloadError('media_url_rejected', 'The media URL contains unsupported URL components.');
  }
  const extension = extname(url.pathname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new EromeDownloadError('media_extension_unsupported', 'The media extension is not supported.');
  }
  return { url, extension };
}

function validateResponse(response, maxBytes) {
  if ([401, 403, 429].includes(response.status)) {
    const rateLimited = response.status === 429;
    throw new EromeDownloadError(rateLimited ? 'source_rate_limited' : 'source_access_restricted',
      rateLimited
        ? 'The source rate-limited the media request; it will be retried later without changing access controls.'
        : 'The source refused the media request; no access-control bypass will be attempted.', {
        status: response.status,
        retryable: rateLimited,
      });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new EromeDownloadError('media_redirect_rejected', 'Media redirects are rejected to prevent following untrusted destinations.', { status: response.status });
  }
  if (response.status !== 200) {
    throw new EromeDownloadError('media_http_error', 'The media server did not return HTTP 200.', {
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!(contentType.startsWith('video/') || contentType === 'application/octet-stream' || contentType === 'binary/octet-stream')) {
    throw new EromeDownloadError('media_content_type_rejected', 'The response is not identified as video or binary media.');
  }
  const rawLength = response.headers.get('content-length');
  if (rawLength !== null) {
    if (!/^\d+$/u.test(rawLength)) throw new EromeDownloadError('media_length_invalid', 'The source returned an invalid Content-Length.');
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) {
      throw new EromeDownloadError('media_size_rejected', 'The video exceeds the configured download size limit.');
    }
  }
}

export class EromeMediaDownloader {
  #fetch;
  #timeoutMs;
  #maxBytes;
  #temporaryRoot;
  #authorizeCopy;

  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 12 * 60_000,
    maxBytes = APP_CONFIG.media.maxFileBytes, temporaryRoot = tmpdir(), authorizeCopy = assertCopyAuthorized } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible implementation is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 30 * 60_000) {
      throw new RangeError('Media download timeout must be between 5 and 30 minutes.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > APP_CONFIG.media.maxFileBytes) {
      throw new RangeError('Media maxBytes is outside the configured limit.');
    }
    if (typeof temporaryRoot !== 'string' || !temporaryRoot.trim()) throw new TypeError('A temporary directory is required.');
    if (typeof authorizeCopy !== 'function') throw new TypeError('authorizeCopy must be a function.');
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxBytes = maxBytes;
    this.#temporaryRoot = temporaryRoot;
    this.#authorizeCopy = authorizeCopy;
  }

  async download({ mediaUrl, albumUrl, assetId }) {
    // The downloader protects its own public API, not only the service caller.
    // With the committed gate closed, it must not validate/fetch any media URL.
    this.#authorizeCopy();
    if (typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId)) throw new TypeError('assetId is invalid.');
    const album = normalizeAlbumUrl(albumUrl);
    if (!album) throw new TypeError('A canonical public Erome album URL is required.');
    const { url, extension } = validateSourceUrl(mediaUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('media_download_timeout')), this.#timeoutMs);
    timeout.unref?.();
    let directory = null;

    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'video/*, application/octet-stream;q=0.9',
          // Match the origin sent by the public site player. This is a normal
          // browser referrer, not an access-control workaround. 403/401/429
          // remain hard failures and no proxy/credential fallback is attempted.
          Referer: 'https://www.erome.com/',
          'User-Agent': USER_AGENT,
        },
      });
      validateResponse(response, this.#maxBytes);
      if (!response.body) throw new EromeDownloadError('media_body_missing', 'The source returned an empty media body.');

      directory = await mkdtemp(join(this.#temporaryRoot, 'ero-scrap-media-'));
      const filename = `${assetId}${extension}`;
      const localPath = join(directory, filename);
      let receivedBytes = 0;
      const maxBytes = this.#maxBytes;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxBytes) {
            callback(new EromeDownloadError('media_size_rejected', 'The video exceeded the configured size limit while streaming.'));
            return;
          }
          callback(null, chunk);
        },
      });

      try {
        await pipeline(Readable.fromWeb(response.body), limiter,
          createWriteStream(localPath, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new EromeDownloadError('media_download_timeout', 'The video download exceeded its time limit.', { cause: error, retryable: true });
        if (error instanceof EromeDownloadError) throw error;
        throw new EromeDownloadError('media_stream_failed', 'The video stream could not be completed.', { cause: error, retryable: true });
      }

      const fileStat = await lstat(localPath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size <= 0 || fileStat.size !== receivedBytes) {
        throw new EromeDownloadError('media_file_invalid', 'The downloaded file failed its size and file-type checks.');
      }
      if (fileStat.size > this.#maxBytes) throw new EromeDownloadError('media_size_rejected', 'The video exceeds the configured size limit.');

      return Object.freeze({
        localPath,
        filename: basename(localPath),
        sizeBytes: fileStat.size,
        cleanup: async () => rm(directory, { recursive: true, force: true }),
      });
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof EromeDownloadError) throw error;
      if (controller.signal.aborted) throw new EromeDownloadError('media_download_timeout', 'The video download exceeded its time limit.', { cause: error, retryable: true });
      throw new EromeDownloadError('media_network_error', 'The video could not be retrieved from the public media URL.', { cause: error, retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }
}
