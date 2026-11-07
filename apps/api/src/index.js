import { isCopyAuthorized } from '../../../packages/config/src/security.js';
import { APP_CONFIG } from '../../../packages/config/src/app.js';
import { authenticateRequest } from './lib/auth.js';
import { authMode } from './lib/password-auth.js';
import { handleLogin, handleLogout } from './services/login.js';
import { errorResponse, getCorsHeaders, jsonResponse } from './lib/http.js';
import {
  CATALOG_ORDERS,
  getActiveThumbnailKey,
  getCatalogItem,
  getCatalogStats,
  getLatestScan,
  listCatalogItems,
  recordFirstClickAndGetShareUrl,
  requestEarlyDeletion,
} from './repositories/catalog-repository.js';
import { loadThumbnail, thumbnailBackend, thumbnailStorageReady } from './lib/thumbnail-store.js';
import { handleInternalCollector, handleInternalThumbnailUpload } from './services/internal-collector.js';

const API_PREFIX = '/api';
const HEALTH_PATH = '/health';

function hasDatabase(env) {
  return Boolean(env.DB && typeof env.DB.prepare === 'function');
}

function parseLimit(value) {
  if (value === null) return APP_CONFIG.catalog.defaultPageSize;
  if (!/^\d{1,3}$/u.test(value)) return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > APP_CONFIG.catalog.maxPageSize) return null;
  return limit;
}

function applyCors(response, corsHeaders) {
  if (!corsHeaders) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isTrustedMutationOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return typeof env.WEB_ORIGIN === 'string' && origin === env.WEB_ORIGIN;
}

async function authenticatePublicRequest(request, env, corsHeaders) {
  const auth = await authenticateRequest(request, env);
  if (!auth.ok) {
    return { response: applyCors(errorResponse(auth.code, 'Authentication is required.', auth.status), corsHeaders) };
  }
  return { auth };
}

async function handleOpenItem(request, env, itemId) {
  if (request.method !== 'POST') {
    return errorResponse('method_not_allowed', 'Opening an item requires POST.', 405, { Allow: 'POST' });
  }
  if (!isTrustedMutationOrigin(request, env)) {
    return errorResponse('origin_forbidden', 'Opening an item must originate from the configured application.', 403);
  }
  if (!hasDatabase(env)) {
    return errorResponse('database_unavailable', 'Database binding is not configured.', 503);
  }

  const auth = await authenticateRequest(request, env);
  if (!auth.ok) return errorResponse(auth.code, 'Authentication is required.', auth.status);

  try {
    const shareUrl = await recordFirstClickAndGetShareUrl(env.DB, itemId);
    if (!shareUrl) {
      return errorResponse('item_unavailable', 'This item is expired, unavailable, or has no valid MEGA link.', 410);
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: shareUrl,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return errorResponse('open_failed', 'Could not open this catalog item.', 503);
  }
}

async function handleDeleteItem(request, env, itemId) {
  if (request.method !== 'POST') {
    return errorResponse('method_not_allowed', 'Deleting an item requires POST.', 405, { Allow: 'POST' });
  }
  if (!isTrustedMutationOrigin(request, env)) {
    return errorResponse('origin_forbidden', 'Deleting an item must originate from the configured application.', 403);
  }
  if (!hasDatabase(env)) {
    return errorResponse('database_unavailable', 'Database binding is not configured.', 503);
  }
  const auth = await authenticateRequest(request, env);
  if (!auth.ok) return errorResponse(auth.code, 'Authentication is required.', auth.status);

  try {
    const deleted = await requestEarlyDeletion(env.DB, itemId);
    if (!deleted) return errorResponse('item_unavailable', 'This item is expired, unavailable or already being deleted.', 410);
    return jsonResponse({ data: { id: itemId, status: 'deleting' } }, 202);
  } catch {
    return errorResponse('delete_failed', 'Could not delete this catalog item.', 503);
  }
}

async function handleThumbnail(request, env, itemId, corsHeaders) {
  if (!thumbnailStorageReady(env)) {
    return applyCors(errorResponse('thumbnail_storage_unavailable', 'Thumbnail storage is not configured.', 503), corsHeaders);
  }
  const authResult = await authenticatePublicRequest(request, env, corsHeaders);
  if (authResult.response) return authResult.response;

  try {
    const key = await getActiveThumbnailKey(env.DB, itemId);
    if (!key || key !== `thumbnails/${itemId}.webp`) {
      return applyCors(errorResponse('thumbnail_not_found', 'Thumbnail not found.', 404), corsHeaders);
    }
    const object = await loadThumbnail(env, itemId);
    if (!object) return applyCors(errorResponse('thumbnail_not_found', 'Thumbnail not found.', 404), corsHeaders);

    return applyCors(new Response(object.body, {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(object.size),
        // The thumbnail of an asset never changes and the asset lives at most about
        // eight days, so the browser can keep it and skip the Worker + storage round trip.
        'Cache-Control': 'private, max-age=86400, immutable',
        ...(object.etag ? { ETag: object.etag } : {}),
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline; filename="thumbnail.webp"',
        'Referrer-Policy': 'no-referrer',
      },
    }), corsHeaders);
  } catch {
    return applyCors(errorResponse('thumbnail_read_failed', 'Could not load the thumbnail.', 503), corsHeaders);
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;

  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
    return errorResponse('not_found', 'Route not found.', 404);
  }

  const openMatch = pathname.match(/^\/api\/catalog\/([a-f0-9]{32})\/open$/u);
  if (openMatch) return handleOpenItem(request, env, openMatch[1]);
  const deleteMatch = pathname.match(/^\/api\/catalog\/([a-f0-9]{32})\/delete$/u);
  if (deleteMatch) return handleDeleteItem(request, env, deleteMatch[1]);
  if (pathname === '/api/login') return handleLogin(request, env);
  if (pathname === '/api/logout') return handleLogout(request, env);

  if (request.method === 'OPTIONS') {
    const corsHeaders = getCorsHeaders(request, env);
    if (!corsHeaders) return errorResponse('origin_forbidden', 'Origin is not allowed.', 403);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    return errorResponse('method_not_allowed', 'Only GET is available on this API route.', 405, {
      Allow: 'GET, POST, OPTIONS',
    });
  }

  const corsHeaders = getCorsHeaders(request, env);
  const origin = request.headers.get('Origin');
  if (origin && !corsHeaders) {
    return errorResponse('origin_forbidden', 'Origin is not allowed.', 403);
  }

  const thumbnailMatch = pathname.match(/^\/api\/thumbnails\/([a-f0-9]{32})$/u);
  if (thumbnailMatch) return handleThumbnail(request, env, thumbnailMatch[1], corsHeaders);

  const authResult = await authenticatePublicRequest(request, env, corsHeaders);
  if (authResult.response) return authResult.response;

  if (pathname === `${API_PREFIX}/status`) {
    if (!hasDatabase(env)) {
      return applyCors(errorResponse('database_unavailable', 'Database binding is not configured.', 503), corsHeaders);
    }

    try {
      const [latestScan, stats] = await Promise.all([getLatestScan(env.DB), getCatalogStats(env.DB)]);
      return applyCors(jsonResponse({
        stage: APP_CONFIG.stage,
        mode: 'catalog-and-retention',
        copyAuthorized: isCopyAuthorized(),
        thumbnailStore: thumbnailBackend(env),
        authMode: authMode(env),
        // Counters ride along so the page needs one request instead of two.
        stats,
        monitor: {
          intervalMinutes: APP_CONFIG.scan.intervalMinutes,
          listingPagesPerScan: APP_CONFIG.scan.maxListingPages,
          latestScan: latestScan ? {
            startedAt: latestScan.started_at,
            finishedAt: latestScan.finished_at,
            status: latestScan.status,
            pagesScanned: latestScan.pages_scanned,
          } : null,
        },
      }), corsHeaders);
    } catch {
      return applyCors(errorResponse('database_query_failed', 'Could not read system status.', 503), corsHeaders);
    }
  }

  if (pathname === `${API_PREFIX}/stats`) {
    if (!hasDatabase(env)) {
      return applyCors(errorResponse('database_unavailable', 'Database binding is not configured.', 503), corsHeaders);
    }
    try {
      const stats = await getCatalogStats(env.DB);
      return applyCors(jsonResponse({ data: stats }), corsHeaders);
    } catch {
      return applyCors(errorResponse('database_query_failed', 'Could not read catalog statistics.', 503), corsHeaders);
    }
  }

  if (pathname === `${API_PREFIX}/catalog`) {
    if (!hasDatabase(env)) {
      return applyCors(errorResponse('database_unavailable', 'Database binding is not configured.', 503), corsHeaders);
    }
    const limit = parseLimit(searchParams.get('limit'));
    if (limit === null) {
      return applyCors(errorResponse('invalid_limit', `limit must be between 1 and ${APP_CONFIG.catalog.maxPageSize}.`, 400), corsHeaders);
    }
    const query = searchParams.get('q') ?? '';
    if (query.length > APP_CONFIG.catalog.maxSearchLength) {
      return applyCors(errorResponse('query_too_long', 'Search query is too long.', 400), corsHeaders);
    }
    const order = searchParams.get('order') ?? 'recent';
    if (!Object.hasOwn(CATALOG_ORDERS, order)) {
      return applyCors(errorResponse('invalid_order', 'order must be recent, oldest, longest or shortest.', 400), corsHeaders);
    }
    try {
      const page = await listCatalogItems(env.DB, {
        limit,
        cursor: searchParams.get('cursor'),
        query,
        order,
      });
      if (page.invalidCursor) {
        return applyCors(errorResponse('invalid_cursor', 'Pagination cursor is invalid.', 400), corsHeaders);
      }
      return applyCors(jsonResponse({ data: page.items, page: {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      } }), corsHeaders);
    } catch {
      return applyCors(errorResponse('database_query_failed', 'Could not read the catalog.', 503), corsHeaders);
    }
  }

  const itemMatch = pathname.match(/^\/api\/catalog\/([a-f0-9]{32})$/u);
  if (itemMatch) {
    if (!hasDatabase(env)) {
      return applyCors(errorResponse('database_unavailable', 'Database binding is not configured.', 503), corsHeaders);
    }
    try {
      const item = await getCatalogItem(env.DB, itemMatch[1]);
      if (!item) return applyCors(errorResponse('not_found', 'Catalog item not found.', 404), corsHeaders);
      return applyCors(jsonResponse({ data: item }), corsHeaders);
    } catch {
      return applyCors(errorResponse('database_query_failed', 'Could not read the catalog item.', 503), corsHeaders);
    }
  }

  return applyCors(errorResponse('not_found', 'Route not found.', 404), corsHeaders);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/collector') {
      return handleInternalCollector(request, env);
    }
    const thumbnailUploadMatch = url.pathname.match(/^\/internal\/thumbnails\/([a-f0-9]{32})$/u);
    if (thumbnailUploadMatch) {
      return handleInternalThumbnailUpload(request, env, thumbnailUploadMatch[1]);
    }

    if (url.pathname === HEALTH_PATH && request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        service: 'ero-scrap-api',
        stage: APP_CONFIG.stage,
      });
    }

    return handleApi(request, env);
  },
};
