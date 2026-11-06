import { executeCollectorCommand } from './collector-service.js';
import { isCopyAuthorized } from '../../../../packages/config/src/security.js';
import { errorResponse, jsonResponse } from '../lib/http.js';
import { describeError, hintFor } from '../../../../packages/config/src/diagnostics.js';
import { saveThumbnail, thumbnailDeleter, thumbnailStorageReady } from '../lib/thumbnail-store.js';

const MAX_BODY_BYTES = 512 * 1024;
const MIN_TOKEN_LENGTH = 32;
const MAX_THUMBNAIL_BYTES = 256 * 1024;
const ASSET_ID_PATTERN = /^[a-f0-9]{32}$/u;

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function readJsonLimited(request) {
  const announcedLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body is too large.'), { code: 'body_too_large', status: 413 });
  }
  if (!request.body) {
    throw Object.assign(new Error('JSON request body is required.'), { code: 'invalid_body', status: 400 });
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel('body_too_large');
        throw Object.assign(new Error('Request body is too large.'), { code: 'body_too_large', status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Object.assign(new Error('Request body must contain valid JSON.'), { code: 'invalid_json', status: 400 });
  }
}

export function isInternalRunnerAuthorized(request, env) {
  const expectedToken = typeof env.RUNNER_API_TOKEN === 'string' ? env.RUNNER_API_TOKEN : '';
  if (expectedToken.length < MIN_TOKEN_LENGTH) return false;
  const authorization = request.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/iu);
  return constantTimeEqual(match?.[1] ?? '', expectedToken);
}

export async function handleInternalCollector(request, env) {
  if (request.method !== 'POST') {
    return errorResponse('method_not_allowed', 'Only POST is accepted.', 405, { Allow: 'POST' });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return errorResponse('unsupported_media_type', 'Content-Type must be application/json.', 415);
  }

  const expectedToken = typeof env.RUNNER_API_TOKEN === 'string' ? env.RUNNER_API_TOKEN : '';
  if (expectedToken.length < MIN_TOKEN_LENGTH) {
    return errorResponse('internal_auth_not_configured', 'The internal collector API is not configured.', 503);
  }
  if (!isInternalRunnerAuthorized(request, env)) {
    return errorResponse('internal_auth_required', 'Internal authentication is required.', 401);
  }

  if (!env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') {
    return errorResponse('database_unavailable', 'Database binding is not configured.', 503);
  }

  let body;
  try {
    body = await readJsonLimited(request);
  } catch (error) {
    return errorResponse(error?.code ?? 'invalid_body', error?.message ?? 'Invalid request body.', error?.status ?? 400);
  }

  if (!body || typeof body.operation !== 'string' || !body.operation) {
    return errorResponse('invalid_operation', 'An operation is required.', 400);
  }

  try {
    const data = await executeCollectorCommand(env.DB, body.operation, body.payload, { thumbnails: thumbnailDeleter(env) });
    return jsonResponse({ ok: true, data });
  } catch (error) {
    const knownCode = new Set(['unknown_operation']).has(error?.code);
    const isValidation = error instanceof TypeError || error instanceof RangeError;
    if (knownCode || isValidation) {
      return errorResponse(knownCode ? error.code : 'invalid_payload', error.message, knownCode ? 404 : 400);
    }
    // Unexpected failure: tell the (token-authenticated) runner exactly what happened.
    // Only sanitized text is returned and logged: no URLs, tokens or payload values.
    const causes = describeError(error);
    const hint = hintFor(causes.map((item) => item.message).join(' '));
    console.error('[collector] operation failed', { operation: body.operation, causes, hint });
    return errorResponse('collector_operation_failed', 'The collector operation could not be completed.', 500, {}, {
      operation: String(body.operation).slice(0, 40),
      causes,
      ...(hint ? { hint } : {}),
    });
  }
}


async function readThumbnailBody(request) {
  const announcedLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_THUMBNAIL_BYTES) {
    throw Object.assign(new Error('Thumbnail exceeds the 256 KiB limit.'), { code: 'thumbnail_too_large', status: 413 });
  }
  if (!request.body) throw Object.assign(new Error('Thumbnail body is required.'), { code: 'thumbnail_missing', status: 400 });
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_THUMBNAIL_BYTES) {
        await reader.cancel('thumbnail_too_large');
        throw Object.assign(new Error('Thumbnail exceeds the 256 KiB limit.'), { code: 'thumbnail_too_large', status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF'
    || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP') {
    throw Object.assign(new Error('Thumbnail must be a valid WebP file.'), { code: 'invalid_webp', status: 415 });
  }
  return bytes;
}

export async function handleInternalThumbnailUpload(request, env, assetId) {
  if (request.method !== 'PUT') {
    return errorResponse('method_not_allowed', 'Only PUT is accepted.', 405, { Allow: 'PUT' });
  }
  if (!ASSET_ID_PATTERN.test(assetId)) return errorResponse('invalid_asset_id', 'Asset ID is invalid.', 400);
  if (!isInternalRunnerAuthorized(request, env)) {
    const configured = typeof env.RUNNER_API_TOKEN === 'string' && env.RUNNER_API_TOKEN.length >= MIN_TOKEN_LENGTH;
    return errorResponse(configured ? 'internal_auth_required' : 'internal_auth_not_configured', 'Internal authentication is required.', configured ? 401 : 503);
  }
  if (!isCopyAuthorized()) {
    return errorResponse('copy_not_authorized', 'Thumbnail extraction and storage are disabled by the project authorization gate.', 403);
  }
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'image/webp') {
    return errorResponse('unsupported_media_type', 'Thumbnail must use image/webp.', 415);
  }
  if (!thumbnailStorageReady(env)) {
    return errorResponse('thumbnail_storage_unavailable', 'Thumbnail storage is not configured.', 503);
  }

  let bytes;
  try { bytes = await readThumbnailBody(request); }
  catch (error) { return errorResponse(error?.code ?? 'invalid_thumbnail', error?.message ?? 'Invalid thumbnail.', error?.status ?? 400); }

  try {
    const saved = await saveThumbnail(env, assetId, bytes, new Date().toISOString());
    if (!saved) {
      return errorResponse('asset_not_stored', 'Thumbnail can only be attached to an active stored item.', 404);
    }
    return jsonResponse({ ok: true, data: { stored: true } });
  } catch {
    return errorResponse('thumbnail_store_failed', 'Could not store the thumbnail.', 503);
  }
}
