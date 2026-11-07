import { APP_CONFIG } from '../../config/src/app.js';
import { isValidListingPage, MIN_LISTING_PAGES, MAX_LISTING_PAGES } from '../../config/src/scan-pages.js';
import { normalizeAlbumUrl } from './normalizers.js';

const BASE_URL = 'https://www.erome.com';
const USER_AGENT = 'Ero-Scrap/0.2 (read-only public metadata index)';

export class EromeSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'EromeSourceError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null; // HTTP status when the failure came from a response
  }
}

async function readTextLimited(body, maxBytes) {
  if (!body) throw new EromeSourceError('empty_response', 'The source returned an empty response body.');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('response_too_large');
        throw new EromeSourceError('response_too_large', 'The source page exceeded the configured size limit.');
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class EromeClient {
  #fetch;
  #lastRequestAt = 0;
  #minimumDelayMs;
  #timeoutMs;
  #maxHtmlBytes;

  constructor({
    fetchImpl = globalThis.fetch,
    minimumDelayMs = APP_CONFIG.scan.minimumRequestDelayMs,
    timeoutMs = APP_CONFIG.scan.requestTimeoutMs,
    maxHtmlBytes = APP_CONFIG.scan.maxHtmlBytes,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible implementation is required.');
    this.#fetch = fetchImpl;
    this.#minimumDelayMs = minimumDelayMs;
    this.#timeoutMs = timeoutMs;
    this.#maxHtmlBytes = maxHtmlBytes;
  }

  async #waitForRateLimit() {
    const elapsed = Date.now() - this.#lastRequestAt;
    const waitMs = Math.max(0, this.#minimumDelayMs - elapsed);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.#lastRequestAt = Date.now();
  }

  async #fetchHtml(url) {
    await this.#waitForRateLimit();

    let response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (error) {
      const code = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'request_timeout'
        : 'network_error';
      throw new EromeSourceError(code, 'Could not read the public Erome page.', { cause: error });
    }

    if (response.status === 429) {
      throw new EromeSourceError('rate_limited', 'Erome returned HTTP 429; the scan was stopped.', {
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        status: 429,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new EromeSourceError('redirect_rejected', 'Unexpected redirects are not followed by the collector.', { status: response.status });
    }
    if (response.status === 403 || response.status === 401) {
      throw new EromeSourceError('access_denied', `Erome returned HTTP ${response.status}; no access restriction will be bypassed.`, { status: response.status });
    }
    if (response.status === 404 || response.status === 410) {
      throw new EromeSourceError('source_post_gone', `Erome returned HTTP ${response.status}: the post was removed.`, { status: response.status });
    }
    if (!response.ok) {
      throw new EromeSourceError('http_error', `Erome returned HTTP ${response.status}.`, { status: response.status });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      throw new EromeSourceError('unexpected_content_type', 'The source response was not HTML.');
    }

    const announcedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(announcedLength) && announcedLength > this.#maxHtmlBytes) {
      throw new EromeSourceError('response_too_large', 'The source page exceeded the configured size limit.');
    }

    return readTextLimited(response.body, this.#maxHtmlBytes);
  }

  async fetchNewPage(pageNumber) {
    if (!isValidListingPage(pageNumber)) {
      throw new RangeError(`Only New pages ${MIN_LISTING_PAGES}-${MAX_LISTING_PAGES} may be fetched.`);
    }

    const url = new URL('/explore/new', BASE_URL);
    if (pageNumber > 1) url.searchParams.set('page', String(pageNumber));
    return this.#fetchHtml(url);
  }

  async fetchAlbum(canonicalUrl) {
    const album = normalizeAlbumUrl(canonicalUrl);
    if (!album) throw new TypeError('Only public Erome album URLs are accepted.');
    return this.#fetchHtml(album.canonicalUrl);
  }
}
