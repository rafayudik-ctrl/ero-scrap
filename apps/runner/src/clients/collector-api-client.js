import { sanitizeDiagnostic } from '../../../../packages/config/src/diagnostics.js';

export class CollectorApiError extends Error {
  constructor(message, { status = null, code = 'collector_api_error', cause, operation = null, detail = null, hint = null } = {}) {
    super(message, { cause });
    this.name = 'CollectorApiError';
    this.status = status;
    this.code = code;
    this.operation = operation;
    this.detail = detail;
    this.hint = hint;
  }
}

/**
 * Minimal HTTP client for the private Worker command API. The runner never
 * receives a Cloudflare account token or sends SQL over the network.
 */
export class CollectorApiClient {
  #endpoint;
  #token;
  #timeoutMs;
  #fetch;
  #accessClientId;
  #accessClientSecret;

  constructor({ endpoint, token, accessClientId = null, accessClientSecret = null, timeoutMs = 15_000, fetchImpl = globalThis.fetch }) {
    const url = new URL(endpoint);
    const isLocalHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocalHttp) {
      throw new TypeError('Collector API URL must use HTTPS (HTTP is allowed only for localhost).');
    }
    if (url.pathname.replace(/\/$/u, '') !== '/internal/collector') {
      throw new TypeError('Collector API URL must end exactly in /internal/collector.');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new TypeError('Collector API URL must not contain credentials, query parameters, or a fragment.');
    }
    if (typeof token !== 'string' || token.length < 32) {
      throw new TypeError('COLLECTOR_API_TOKEN must contain at least 32 characters.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new RangeError('Collector API timeout must be between 1000 and 60000 ms.');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible implementation is required.');

    this.#endpoint = url.toString().replace(/\/$/u, '');
    this.#token = token;
    if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
      throw new TypeError('Cloudflare Access service-token credentials must be provided together.');
    }
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
    this.#accessClientId = accessClientId;
    this.#accessClientSecret = accessClientSecret;
  }

  async #command(operation, payload) {
    let response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.#accessClientId ? {
            'CF-Access-Client-Id': this.#accessClientId,
            'CF-Access-Client-Secret': this.#accessClientSecret,
          } : {}),
        },
        body: JSON.stringify({ operation, payload }),
      });
    } catch (error) {
      throw new CollectorApiError('Could not reach the private collector API.', {
        code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'collector_timeout' : 'collector_network_error',
        cause: error,
        operation,
      });
    }

    let body;
    let rawText = '';
    try {
      rawText = await response.text();
      body = JSON.parse(rawText);
    } catch (error) {
      // Typically an HTML error page from Cloudflare (limits, outage, wrong URL): show its text.
      throw new CollectorApiError('The private collector API returned invalid JSON.', {
        status: response.status,
        code: 'collector_invalid_response',
        cause: error,
        operation,
        detail: `content-type=${sanitizeDiagnostic(response.headers?.get?.('content-type') ?? '', 60)} body="${sanitizeDiagnostic(rawText, 300)}"`,
      });
    }

    if (!response.ok || body?.ok !== true) {
      const failure = body?.error ?? {};
      const causes = Array.isArray(failure.causes)
        ? failure.causes.slice(0, 3).map((item) => `${sanitizeDiagnostic(item?.name, 40)}${item?.code ? `(${sanitizeDiagnostic(item.code, 40)})` : ''}: ${sanitizeDiagnostic(item?.message, 300)}`).join(' <- ')
        : null;
      throw new CollectorApiError(failure.message ?? 'The private collector operation failed.', {
        status: response.status,
        code: failure.code ?? 'collector_request_failed',
        operation: sanitizeDiagnostic(failure.operation ?? operation, 40),
        detail: causes,
        hint: failure.hint ? sanitizeDiagnostic(failure.hint, 200) : null,
      });
    }
    return body.data;
  }

  async createScanRun(startedAt) {
    const result = await this.#command('scan.create', { startedAt });
    return result.scanId;
  }

  async finishScanRun(id, values) {
    await this.#command('scan.finish', { id, ...values });
  }

  async upsertListingPosts(posts, now) {
    await this.#command('posts.upsert', { posts, now });
  }

  async getPendingInspection(postIds, limit, keyword) {
    const result = await this.#command('posts.pending', { postIds, limit, keyword });
    return result.posts;
  }

  async getSeenPosts(keywordKey) {
    const result = await this.#command('scan.seen.get', { keywordKey });
    return result.ids;
  }

  async saveSeenPosts(keywordKey, ids) {
    await this.#command('scan.seen.save', { keywordKey, ids });
  }

  async savePostInspection(inspection, now) {
    await this.#command('post.inspect', { inspection, now });
  }

  async getPostSnapshots(postIds) {
    const result = await this.#command('posts.snapshots', { postIds });
    return result.posts;
  }

  async updateEvaluations(evaluations, now) {
    if (!Array.isArray(evaluations)) throw new TypeError('Video evaluations must be an array.');
    // Keep each JSON body small and bounded even for albums with many videos.
    for (let offset = 0; offset < evaluations.length; offset += 500) {
      await this.#command('videos.evaluate', { evaluations: evaluations.slice(offset, offset + 500), now });
    }
  }

  async registerStoredMedia(record) {
    return this.#command('media.register', record);
  }

  async hasDueProcessVideoJobs({ now = new Date().toISOString() } = {}) {
    const result = await this.#command('process.hasDue', { now });
    return result.due === true;
  }

  async claimProcessVideoJobs({ limit = 1, now = new Date().toISOString() } = {}) {
    const result = await this.#command('process.claim', { limit, now });
    return result.jobs;
  }

  async completeProcessVideoJob(record) {
    return this.#command('process.complete', record);
  }

  async failProcessVideoJob(record) {
    return this.#command('process.fail', record);
  }


  async hasDueDeletionJobs({ now = new Date().toISOString() } = {}) {
    const result = await this.#command('retention.hasDue', { now });
    return result.due === true;
  }

  async claimDueDeletionJobs({ limit = 20, now = new Date().toISOString() } = {}) {
    const result = await this.#command('retention.claim', { limit, now });
    return result.jobs;
  }

  async completeDeletion({ jobId, assetId, leaseToken, now = new Date().toISOString() }) {
    return this.#command('retention.complete', { jobId, assetId, leaseToken, now });
  }

  async failDeletion({ jobId, leaseToken, attempts, errorCode, now = new Date().toISOString() }) {
    return this.#command('retention.fail', { jobId, leaseToken, attempts, errorCode, now });
  }

  async pruneStale({ now = new Date().toISOString(), continuation = false } = {}) {
    return this.#command('maintenance.prune', { now, continuation });
  }

  async uploadThumbnail(assetId, bytes) {
    if (!/^[a-f0-9]{32}$/u.test(assetId)) throw new TypeError('assetId is invalid.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12 || bytes.byteLength > 256 * 1024) {
      throw new RangeError('Thumbnail must be a Uint8Array no larger than 256 KiB.');
    }
    const endpoint = new URL(this.#endpoint);
    endpoint.pathname = `/internal/thumbnails/${assetId}`;
    endpoint.search = '';
    endpoint.hash = '';
    let response;
    try {
      response = await this.#fetch(endpoint, {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'image/webp',
          ...(this.#accessClientId ? {
            'CF-Access-Client-Id': this.#accessClientId,
            'CF-Access-Client-Secret': this.#accessClientSecret,
          } : {}),
        },
        body: bytes,
      });
    } catch (error) {
      throw new CollectorApiError('Could not upload the thumbnail to the private API.', {
        code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'thumbnail_timeout' : 'thumbnail_network_error',
        cause: error,
      });
    }
    let payload;
    try { payload = await response.json(); }
    catch (error) {
      throw new CollectorApiError('The thumbnail API returned invalid JSON.', { status: response.status, code: 'thumbnail_invalid_response', cause: error });
    }
    if (!response.ok || payload?.ok !== true) {
      throw new CollectorApiError(payload?.error?.message ?? 'Thumbnail upload was rejected.', {
        status: response.status,
        code: payload?.error?.code ?? 'thumbnail_upload_failed',
      });
    }
    return payload.data;
  }
}
