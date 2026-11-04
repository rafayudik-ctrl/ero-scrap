/**
 * Thumbnail storage with two interchangeable backends, chosen by the
 * THUMBNAIL_STORE variable in wrangler.jsonc:
 *   "d1" (default) - previews live in the D1 `thumbnails` table. No extra
 *                    service, no credit card, one fewer binding to maintain.
 *   "r2"           - previews live in a private R2 bucket (binding THUMBNAILS).
 * Either way `video_assets.thumbnail_key` marks "this item has a preview", so
 * the catalog code does not care which backend is active.
 */

export const THUMBNAIL_BACKENDS = Object.freeze(['d1', 'r2']);

export function thumbnailBackend(env) {
  const value = String(env?.THUMBNAIL_STORE ?? 'd1').trim().toLowerCase();
  return THUMBNAIL_BACKENDS.includes(value) ? value : null;
}

const hasD1 = (env) => Boolean(env?.DB && typeof env.DB.prepare === 'function');

/** True when the selected backend has everything it needs to work. */
export function thumbnailStorageReady(env) {
  const backend = thumbnailBackend(env);
  if (backend === 'd1') return hasD1(env) && typeof env.DB.batch === 'function';
  if (backend === 'r2') return hasD1(env) && typeof env.THUMBNAILS?.put === 'function' && typeof env.THUMBNAILS?.get === 'function';
  return false;
}

export const thumbnailKey = (assetId) => `thumbnails/${assetId}.webp`;

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Attach a preview to an item that is currently stored and not expired.
 * Returns true when saved, false when the item is not eligible.
 */
export async function saveThumbnail(env, assetId, bytes, now = new Date().toISOString()) {
  const key = thumbnailKey(assetId);
  const activeAsset = `id = ? AND status IN ('stored', 'clicked') AND expires_at > ?`;
  const backend = thumbnailBackend(env);

  if (backend === 'd1') {
    // One transaction: the preview row and the flag appear together or not at all.
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR REPLACE INTO thumbnails (asset_id, data_b64, size_bytes, created_at)
        SELECT id, ?, ?, ? FROM video_assets WHERE ${activeAsset}
      `).bind(toBase64(bytes), bytes.byteLength, now, assetId, now),
      env.DB.prepare(`
        UPDATE video_assets
        SET thumbnail_key = ?, thumbnail_content_type = 'image/webp', updated_at = ?
        WHERE ${activeAsset}
      `).bind(key, now, assetId, now),
    ]);
    return Number(results?.[1]?.meta?.changes ?? 0) === 1;
  }

  let objectStored = false;
  try {
    await env.THUMBNAILS.put(key, bytes, {
      httpMetadata: { contentType: 'image/webp', cacheControl: 'private, max-age=300' },
      customMetadata: { assetId },
    });
    objectStored = true;
    const result = await env.DB.prepare(`
      UPDATE video_assets
      SET thumbnail_key = ?, thumbnail_content_type = 'image/webp', updated_at = ?
      WHERE ${activeAsset}
    `).bind(key, now, assetId, now).run();
    if (Number(result?.meta?.changes ?? 0) === 1) return true;
    await env.THUMBNAILS.delete(key);
    return false;
  } catch (error) {
    if (objectStored) await env.THUMBNAILS.delete(key).catch(() => {});
    throw error;
  }
}

/** Read a preview. Returns { body, size, etag? } or null when it does not exist. */
export async function loadThumbnail(env, assetId) {
  if (thumbnailBackend(env) === 'd1') {
    const row = await env.DB.prepare('SELECT data_b64, size_bytes FROM thumbnails WHERE asset_id = ? LIMIT 1')
      .bind(assetId).first();
    if (!row || typeof row.data_b64 !== 'string') return null;
    const bytes = fromBase64(row.data_b64);
    return { body: bytes, size: bytes.byteLength, etag: `"${assetId}"` };
  }
  const object = await env.THUMBNAILS.get(thumbnailKey(assetId));
  if (!object) return null;
  return { body: object.body, size: object.size, etag: object.httpEtag };
}

/**
 * What retention uses to remove a preview object. With D1 nothing is needed:
 * the row disappears with the catalog row (ON DELETE CASCADE).
 */
export function thumbnailDeleter(env) {
  const backend = thumbnailBackend(env);
  if (backend === 'd1') return { async delete() {} };
  if (backend === 'r2' && typeof env.THUMBNAILS?.delete === 'function') return env.THUMBNAILS;
  return undefined;
}
