import { normalizeText } from '../../../../packages/domain/src/normalization.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';

function mapCatalogRow(row) {
  return {
    id: row.id,
    title: row.title,
    durationMs: row.duration_ms,
    discoveredAt: row.discovered_at,
    uploadedAt: row.uploaded_at,
    expiresAt: row.expires_at,
    status: row.status,
    thumbnailUrl: row.thumbnail_key ? `/api/thumbnails/${encodeURIComponent(row.id)}` : null,
  };
}

export async function listCatalogItems(db, { limit, cursor, query }) {
  const safeLimit = Math.min(
    APP_CONFIG.catalog.maxPageSize,
    Math.max(1, Number.isInteger(limit) ? limit : APP_CONFIG.catalog.defaultPageSize),
  );
  const normalizedQuery = normalizeText(query).slice(0, APP_CONFIG.catalog.maxSearchLength);
  const decodedCursor = cursor ? decodeCursor(cursor) : null;
  if (cursor && !decodedCursor) {
    return { invalidCursor: true, items: [], nextCursor: null, hasMore: false };
  }

  const now = new Date().toISOString();
  const conditions = ["a.status IN ('stored', 'clicked')", 'a.uploaded_at IS NOT NULL', 'a.expires_at > ?'];
  const bindings = [now];

  if (normalizedQuery) {
    conditions.push(`(
      instr(p.normalized_title, ?) > 0
      OR EXISTS (
        SELECT 1
        FROM post_tags pt
        INNER JOIN tags t ON t.id = pt.tag_id
        WHERE pt.post_id = p.id AND instr(t.normalized_name, ?) > 0
      )
    )`);
    bindings.push(normalizedQuery, normalizedQuery);
  }

  if (decodedCursor) {
    conditions.push('(a.discovered_at < ? OR (a.discovered_at = ? AND a.id < ?))');
    bindings.push(decodedCursor.discoveredAt, decodedCursor.discoveredAt, decodedCursor.id);
  }

  const sql = `
    SELECT
      a.id,
      p.title,
      a.duration_ms,
      a.discovered_at,
      a.uploaded_at,
      a.expires_at,
      a.status,
      a.thumbnail_key
    FROM video_assets a INDEXED BY idx_video_assets_catalog
    INNER JOIN posts p ON p.id = a.post_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.discovered_at DESC, a.id DESC
    LIMIT ?
  `;

  const result = await db.prepare(sql).bind(...bindings, safeLimit + 1).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const items = pageRows.map(mapCatalogRow);
  const last = pageRows.at(-1);

  return {
    invalidCursor: false,
    items,
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({ discoveredAt: last.discovered_at, id: last.id })
      : null,
  };
}

export async function getCatalogItem(db, id) {
  const result = await db.prepare(`
    SELECT
      a.id,
      p.title,
      a.duration_ms,
      a.discovered_at,
      a.uploaded_at,
      a.expires_at,
      a.status,
      a.thumbnail_key
    FROM video_assets a
    INNER JOIN posts p ON p.id = a.post_id
    WHERE a.id = ?
      AND a.status IN ('stored', 'clicked')
      AND a.expires_at > ?
    LIMIT 1
  `).bind(id, new Date().toISOString()).first();

  return result ? mapCatalogRow(result) : null;
}

export async function getCatalogStats(db) {
  const result = await db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('stored', 'clicked') AND expires_at > ? THEN 1 ELSE 0 END) AS stored_count,
      SUM(CASE WHEN status = 'clicked' AND expires_at > ? THEN 1 ELSE 0 END) AS clicked_count,
      SUM(CASE WHEN status = 'stored' AND first_clicked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS unopened_count,
      SUM(CASE WHEN status = 'delete_pending' THEN 1 ELSE 0 END) AS deletion_pending_count
    FROM video_assets
    WHERE status IN ('stored', 'clicked', 'delete_pending')
  `).bind(...Array(3).fill(new Date().toISOString())).first();

  return {
    stored: Number(result?.stored_count ?? 0),
    clicked: Number(result?.clicked_count ?? 0),
    unopened: Number(result?.unopened_count ?? 0),
    deletionPending: Number(result?.deletion_pending_count ?? 0),
  };
}

export async function getLatestScan(db) {
  return db.prepare(`
    SELECT id, started_at, finished_at, status, pages_scanned,
           posts_seen, matching_posts, video_candidates, error_code
    FROM scan_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).first();
}


function isSafeMegaShareUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const modernFileLink = /^\/(?:file|folder)\/[A-Za-z0-9_-]+$/u.test(url.pathname);
    const legacyFileLink = url.pathname === '/' && /^#(?:F!)?[A-Za-z0-9!_-]+$/u.test(url.hash);
    return url.protocol === 'https:'
      && url.hostname === 'mega.nz'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && (modernFileLink || legacyFileLink)
      && url.hash.length > 1;
  } catch {
    return false;
  }
}

/**
 * Atomically records only the first opening. Subsequent clicks never extend
 * the 24-hour expiry. The MEGA URL stays server-side and is returned only to
 * the redirect handler after the active item has been verified.
 */
export async function recordFirstClickAndGetShareUrl(db, id, now = new Date().toISOString()) {
  // Validate the stored target before mutating retention. A malformed or
  // missing link must not consume the user's one-time 24-hour click window.
  const existing = await db.prepare(`
    SELECT share_url
    FROM video_assets
    WHERE id = ?
      AND status IN ('stored', 'clicked')
      AND expires_at > ?
    LIMIT 1
  `).bind(id, now).first();
  if (!existing || !isSafeMegaShareUrl(existing.share_url)) return null;

  const expiresAt = new Date(Date.parse(now) + APP_CONFIG.retention.afterFirstClickHours * 60 * 60 * 1_000).toISOString();
  await db.prepare(`
    UPDATE video_assets
    SET first_clicked_at = COALESCE(first_clicked_at, ?),
        expires_at = CASE WHEN first_clicked_at IS NULL THEN ? ELSE expires_at END,
        status = CASE WHEN status = 'stored' THEN 'clicked' ELSE status END,
        updated_at = ?
    WHERE id = ?
      AND status IN ('stored', 'clicked')
      AND expires_at > ?
      AND share_url = ?
  `).bind(now, expiresAt, now, id, now, existing.share_url).run();

  const row = await db.prepare(`
    SELECT share_url, status, expires_at
    FROM video_assets
    WHERE id = ?
      AND status = 'clicked'
      AND first_clicked_at IS NOT NULL
      AND expires_at > ?
    LIMIT 1
  `).bind(id, now).first();

  return row && isSafeMegaShareUrl(row.share_url) ? row.share_url : null;
}

export async function getActiveThumbnailKey(db, id, now = new Date().toISOString()) {
  const row = await db.prepare(`
    SELECT thumbnail_key
    FROM video_assets
    WHERE id = ?
      AND status IN ('stored', 'clicked')
      AND expires_at > ?
      AND thumbnail_key IS NOT NULL
    LIMIT 1
  `).bind(id, now).first();
  return typeof row?.thumbnail_key === 'string' ? row.thumbnail_key : null;
}
