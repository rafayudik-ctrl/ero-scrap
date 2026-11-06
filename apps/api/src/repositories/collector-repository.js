import { normalizeText, normalizeTag } from '../../../../packages/domain/src/normalization.js';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';

const D1_MAX_BOUND_PARAMETERS = 100;
const POSTS_PER_INSERT = 12; // 12 × 8 bound values = 96.
const TAGS_PER_INSERT = 30; // 30 × 3 bound values = 90.
const VIDEOS_PER_INSERT = 12; // 12 × 8 bound values = 96.
const IDS_PER_QUERY = 90; // Leaves room for keyword/limit parameters.

async function localVideoId(postId, sourceVideoId) {
  const input = new TextEncoder().encode(`${postId}:${sourceVideoId}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function chunks(values, size) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function isValidPostId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,64}$/u.test(value);
}

class D1BindingAdapter {
  #db;

  constructor(db) {
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
      throw new TypeError('A Cloudflare D1 binding is required.');
    }
    this.#db = db;
  }

  async query(sql, params = []) {
    const statement = this.#db.prepare(sql);
    const bound = params.length > 0 ? statement.bind(...params) : statement;
    const result = await bound.all();
    return Array.isArray(result?.results) ? result.results : [];
  }

  async run(sql, params = []) {
    const statement = this.#db.prepare(sql);
    const bound = params.length > 0 ? statement.bind(...params) : statement;
    return bound.run();
  }

  async batch(statements) {
    if (!Array.isArray(statements) || statements.length === 0) return [];
    const prepared = statements.map(({ sql, params = [] }) => {
      const statement = this.#db.prepare(sql);
      return params.length > 0 ? statement.bind(...params) : statement;
    });
    return this.#db.batch(prepared);
  }
}

export class CollectorRepository {
  #db;

  constructor(databaseBinding) {
    this.#db = new D1BindingAdapter(databaseBinding);
  }

  /**
   * Ids of albums already examined for this keyword (one row, replaced as a whole).
   * A different keyword key yields an empty list, which restarts the check.
   */
  async getSeenPosts(keywordKey) {
    await this.#ensureStateTable();
    const rows = await this.#db.query('SELECT value FROM scan_state WHERE key = ?', ['seen_posts']);
    try {
      const stored = JSON.parse(rows[0]?.value ?? 'null');
      return stored?.keywordKey === keywordKey && Array.isArray(stored.ids) ? stored.ids.filter(isValidPostId) : [];
    } catch {
      return [];
    }
  }

  async saveSeenPosts(keywordKey, ids, now = new Date().toISOString()) {
    await this.#ensureStateTable();
    const value = JSON.stringify({ keywordKey, ids: ids.filter(isValidPostId).slice(0, 400) });
    await this.#db.run(`
      INSERT INTO scan_state (key, value, updated_at) VALUES ('seen_posts', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, [value, now]);
  }

  // Zero-friction upgrade: creating an existing table writes no rows.
  async #ensureStateTable() {
    await this.#db.run('CREATE TABLE IF NOT EXISTS scan_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }

  async createScanRun(startedAt = new Date().toISOString()) {
    const id = crypto.randomUUID();
    await this.#db.run(`
      INSERT INTO scan_runs (id, started_at, status, pages_scanned, created_at)
      VALUES (?, ?, 'running', 0, ?)
    `, [id, startedAt, startedAt]);
    return id;
  }

  async finishScanRun(id, {
    finishedAt = new Date().toISOString(),
    status,
    pagesScanned,
    postsSeen,
    matchingPosts,
    videoCandidates,
    errorCode = null,
  }) {
    const validStatuses = new Set(['succeeded', 'partial', 'failed', 'skipped']);
    if (!validStatuses.has(status)) throw new TypeError('Invalid scan status.');
    if (!Number.isInteger(pagesScanned) || pagesScanned < 0 || pagesScanned > 2) {
      throw new RangeError('pagesScanned must be between zero and two.');
    }

    await this.#db.run(`
      UPDATE scan_runs
      SET finished_at = ?, status = ?, pages_scanned = ?, posts_seen = ?,
          matching_posts = ?, video_candidates = ?, error_code = ?
      WHERE id = ?
    `, [finishedAt, status, pagesScanned, postsSeen, matchingPosts, videoCandidates, errorCode, id]);
  }

  async upsertListingPosts(posts, now = new Date().toISOString()) {
    if (!Array.isArray(posts) || posts.length === 0) return;

    const statements = [];
    for (const group of chunks(posts.filter((post) => isValidPostId(post?.id)), POSTS_PER_INSERT)) {
      const values = group.map((post) => [
        post.id,
        post.canonicalUrl,
        post.title,
        normalizeText(post.title),
        post.publishedAt ?? null,
        now,
        now,
        now,
      ]);
      const rowSql = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      statements.push({
        sql: `INSERT INTO posts (
                id, canonical_url, title, normalized_title, published_at,
                discovered_at, created_at, updated_at
              ) VALUES ${rowSql}
              ON CONFLICT(id) DO UPDATE SET
                title = CASE WHEN posts.details_checked_at IS NULL THEN excluded.title ELSE posts.title END,
                normalized_title = CASE WHEN posts.details_checked_at IS NULL
                                        THEN excluded.normalized_title ELSE posts.normalized_title END,
                published_at = COALESCE(excluded.published_at, posts.published_at),
                source_updated_at = excluded.updated_at,
                updated_at = excluded.updated_at
              WHERE (posts.details_checked_at IS NULL AND posts.title <> excluded.title)
                 OR (excluded.published_at IS NOT NULL AND posts.published_at IS NOT excluded.published_at)`,
        params: values.flat(),
      });
    }

    if (statements.some((statement) => statement.params.length > D1_MAX_BOUND_PARAMETERS)) {
      throw new Error('Internal D1 parameter budget exceeded while upserting posts.');
    }
    if (statements.length > 0) await this.#db.batch(statements);
  }

  /**
   * Inspect only posts still present on New pages 1 and 2. Posts that have
   * fallen off those pages are deliberately not crawled later.
   */
  async getPendingInspection(postIds, limit, keyword) {
    const ids = [...new Set(Array.isArray(postIds) ? postIds : [])].filter(isValidPostId);
    if (ids.length === 0) return [];

    const safeLimit = Math.min(ids.length, 160, Math.max(1, Number.isInteger(limit) ? limit : 160));
    const normalizedKeyword = normalizeText(keyword);
    const rows = [];

    // D1 allows at most 100 bound parameters per statement. Chunk IDs rather
    // than interpolating them or relying on JSON table-valued functions.
    for (const group of chunks(ids, IDS_PER_QUERY)) {
      const result = await this.#db.query(`
        SELECT id, canonical_url, title, discovered_at
        FROM posts
        WHERE details_checked_at IS NULL
          AND id IN (${placeholders(group.length)})
        ORDER BY discovered_at DESC, id ASC
      `, group);
      rows.push(...result);
    }

    rows.sort((left, right) => {
      const leftTitleMatch = normalizeText(left.title).includes(normalizedKeyword) ? 0 : 1;
      const rightTitleMatch = normalizeText(right.title).includes(normalizedKeyword) ? 0 : 1;
      if (leftTitleMatch !== rightTitleMatch) return leftTitleMatch - rightTitleMatch;
      const dateOrder = String(right.discovered_at).localeCompare(String(left.discovered_at));
      return dateOrder || String(left.id).localeCompare(String(right.id));
    });

    return rows.slice(0, safeLimit);
  }

  async savePostInspection(inspection, now = new Date().toISOString()) {
    if (!inspection || !isValidPostId(inspection.postId)) {
      throw new TypeError('A valid inspected post ID is required.');
    }

    const postId = inspection.postId;
    const tags = (Array.isArray(inspection.tags) ? inspection.tags : [])
      .map((tag) => ({
        name: String(tag?.name ?? '').trim().slice(0, 80),
        normalizedName: tag?.normalizedName ?? normalizeTag(tag?.name),
      }))
      .filter((tag) => tag.name && tag.normalizedName)
      .slice(0, 40);
    const videos = (Array.isArray(inspection.videos) ? inspection.videos : [])
      .filter((video) => /^[A-Za-z0-9_-]{4,128}$/u.test(String(video?.sourceVideoId ?? '')))
      .slice(0, 100);
    const inspectedAt = inspection.inspectedAt ?? now;
    const title = String(inspection.title ?? '').slice(0, 300);
    const normalizedTitle = normalizeText(title);

    const statements = [
      { sql: 'DELETE FROM post_tags WHERE post_id = ?', params: [postId] },
      {
        sql: `UPDATE posts
              SET title = CASE WHEN ? <> '' THEN ? ELSE title END,
                  normalized_title = CASE WHEN ? <> '' THEN ? ELSE normalized_title END,
                  details_checked_at = ?, updated_at = ?
              WHERE id = ?`,
        params: [title, title, normalizedTitle, normalizedTitle, inspectedAt, now, postId],
      },
    ];

    for (const group of chunks(tags, TAGS_PER_INSERT)) {
      const values = group.map(() => '(?, ?, ?)').join(', ');
      statements.push({
        sql: `INSERT OR IGNORE INTO tags (name, normalized_name, created_at) VALUES ${values}`,
        params: group.flatMap((tag) => [tag.name, tag.normalizedName, now]),
      });
    }

    if (tags.length > 0) {
      const normalized = [...new Set(tags.map((tag) => tag.normalizedName))];
      statements.push({
        sql: `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
              SELECT ?, id FROM tags WHERE normalized_name IN (${placeholders(normalized.length)})`,
        params: [postId, ...normalized],
      });
    }

    for (const group of chunks(videos, VIDEOS_PER_INSERT)) {
      const rows = group.map(() => '(?, ?, ?, \'discovered\', ?, ?, ?, ?)').join(', ');
      const values = await Promise.all(group.map(async (video) => [
        await localVideoId(postId, video.sourceVideoId),
        postId,
        video.sourceVideoId,
        Number.isSafeInteger(video.durationMs) && video.durationMs > 0 ? video.durationMs : null,
        inspectedAt,
        now,
        now,
      ]));
      statements.push({
        sql: `INSERT INTO video_assets (
                id, post_id, source_video_id, status, duration_ms,
                discovered_at, created_at, updated_at
              ) VALUES ${rows}
              ON CONFLICT(post_id, source_video_id) DO UPDATE SET
                duration_ms = COALESCE(excluded.duration_ms, video_assets.duration_ms),
                updated_at = excluded.updated_at`,
        params: values.flat(),
      });
    }

    if (statements.some((statement) => statement.params.length > D1_MAX_BOUND_PARAMETERS)) {
      throw new Error('Internal D1 parameter budget exceeded while saving post inspection.');
    }
    await this.#db.batch(statements);
  }

  async getPostSnapshots(postIds) {
    const ids = [...new Set(Array.isArray(postIds) ? postIds : [])].filter(isValidPostId);
    if (ids.length === 0) return [];

    const snapshots = [];
    for (const group of chunks(ids, IDS_PER_QUERY)) {
      const inClause = placeholders(group.length);
      const posts = await this.#db.query(`
        SELECT id, canonical_url, title, normalized_title, details_checked_at
        FROM posts WHERE id IN (${inClause})
      `, group);
      const tags = await this.#db.query(`
        SELECT pt.post_id, t.name, t.normalized_name
        FROM post_tags pt
        INNER JOIN tags t ON t.id = pt.tag_id
        WHERE pt.post_id IN (${inClause})
        ORDER BY t.normalized_name
      `, group);
      const videos = await this.#db.query(`
        SELECT id, post_id, source_video_id, duration_ms, status
        FROM video_assets WHERE post_id IN (${inClause})
        ORDER BY source_video_id
      `, group);

      const tagsByPost = new Map(group.map((id) => [id, []]));
      const videosByPost = new Map(group.map((id) => [id, []]));
      for (const tag of tags) tagsByPost.get(tag.post_id)?.push(tag.name);
      for (const video of videos) videosByPost.get(video.post_id)?.push(video);

      for (const post of posts) {
        snapshots.push({
          ...post,
          tags: tagsByPost.get(post.id) ?? [],
          videos: videosByPost.get(post.id) ?? [],
        });
      }
    }

    return snapshots;
  }

  async updateEvaluations(evaluations, now = new Date().toISOString()) {
    const validStatuses = new Set(['ignored', 'eligible', 'copy_blocked', 'too_long', 'duration_unknown', 'error']);
    const safe = (Array.isArray(evaluations) ? evaluations : [])
      .filter((item) => validStatuses.has(item?.status) && typeof item.id === 'string');
    if (safe.length === 0) return;

    for (const group of chunks(safe, 40)) {
      const statements = [];
      for (const item of group) {
        statements.push({
          sql: `UPDATE video_assets
                SET status = ?, updated_at = ?
                WHERE id = ?
                  AND status <> ?
                  AND status NOT IN ('stored', 'clicked', 'delete_pending', 'deleted')`,
          params: [item.status, now, item.id, item.status],
        });
        if (item.status === 'eligible') {
          // A deterministic idempotency key prevents duplicate process jobs
          // when the same eligible video appears on both New pages or scans.
          statements.push({
            sql: `INSERT OR IGNORE INTO job_records (
                    id, job_type, subject_id, status, idempotency_key, payload_json,
                    attempts, available_at, created_at, updated_at
                  )
                  SELECT ?, 'process_video', id, 'pending', ?, ?, 0, ?, ?, ?
                  FROM video_assets
                  WHERE id = ? AND status = 'eligible'
                    AND duration_ms IS NOT NULL AND duration_ms > 0 AND duration_ms <= 600000`,
            params: [crypto.randomUUID(), `process:${item.id}`, JSON.stringify({ assetId: item.id }), now, now, now, item.id],
          });
        }
      }
      await this.#db.batch(statements);
    }
  }

  async claimProcessVideoJobs({ now = new Date().toISOString(), limit = 1, leaseMs = 30 * 60_000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2) {
      throw new RangeError('Process-video claim limit must be between 1 and 2.');
    }
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const claimed = await this.#db.query(`
      UPDATE job_records
      SET status = 'leased', attempts = attempts + 1, leased_at = ?,
          lease_expires_at = ?, lease_token = lower(hex(randomblob(16))), updated_at = ?
      WHERE id IN (
        SELECT id FROM job_records
        WHERE job_type = 'process_video'
          AND available_at <= ?
          AND (status IN ('pending', 'retry') OR (status = 'leased' AND lease_expires_at <= ?))
        ORDER BY available_at ASC, id ASC
        LIMIT ?
      )
      RETURNING id, subject_id, attempts, lease_token
    `, [now, leaseUntil, now, now, now, limit]);

    if (claimed.length === 0) return [];
    const assetIds = claimed.map((job) => job.subject_id).filter((id) => typeof id === 'string');
    const rows = assetIds.length === 0 ? [] : await this.#db.query(`
      SELECT a.id, a.post_id, a.source_video_id, a.duration_ms, a.status, p.canonical_url
      FROM video_assets AS a
      INNER JOIN posts AS p ON p.id = a.post_id
      WHERE a.id IN (${placeholders(assetIds.length)})
        AND a.status IN ('eligible', 'processing', 'error')
        AND a.duration_ms IS NOT NULL AND a.duration_ms > 0 AND a.duration_ms <= 600000
    `, assetIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const invalid = claimed.filter((job) => !byId.has(job.subject_id)
      || typeof job.lease_token !== 'string' || !/^[a-f0-9]{32}$/u.test(job.lease_token));
    if (invalid.length > 0) {
      await this.#db.batch(invalid.map((job) => ({
        sql: `UPDATE job_records
              SET status = 'cancelled', leased_at = NULL, lease_expires_at = NULL,
                  lease_token = NULL, updated_at = ?
              WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        params: [now, job.id, job.lease_token],
      })));
    }

    const valid = claimed.filter((job) => byId.has(job.subject_id)
      && typeof job.lease_token === 'string' && /^[a-f0-9]{32}$/u.test(job.lease_token));
    if (valid.length > 0) {
      await this.#db.batch(valid.map((job) => ({
        sql: `UPDATE video_assets SET status = 'processing', updated_at = ?
              WHERE id = ? AND status IN ('eligible', 'processing', 'error')`,
        params: [now, job.subject_id],
      })));
    }

    return valid.map((job) => {
      const asset = byId.get(job.subject_id);
      return {
        jobId: job.id,
        leaseToken: job.lease_token,
        assetId: asset.id,
        postId: asset.post_id,
        canonicalUrl: asset.canonical_url,
        sourceVideoId: asset.source_video_id,
        durationMs: asset.duration_ms,
        attempts: job.attempts,
      };
    });
  }

  async completeProcessVideoJob({ jobId, assetId, leaseToken, objectId, shareUrl, durationMs, uploadedAt, expiresAt }) {
    if (typeof leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(leaseToken)) {
      throw new TypeError('A valid process-video lease token is required.');
    }
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 600000) {
      throw new RangeError('Stored video duration must be between 1 ms and 600000 ms.');
    }
    const results = await this.#db.batch([
      {
        sql: `UPDATE video_assets
              SET status = 'stored', storage_provider = 'mega', storage_object_id = ?,
                  share_url = ?, duration_ms = ?, uploaded_at = ?, expires_at = ?,
                  first_clicked_at = NULL, thumbnail_key = NULL,
                  thumbnail_content_type = NULL, attempts = 0, last_error_code = NULL,
                  updated_at = ?
              WHERE id = ? AND status = 'processing'
                AND duration_ms IS NOT NULL AND duration_ms > 0 AND duration_ms <= 600000
                AND ABS(duration_ms - ?) <= ?
                AND EXISTS (
                  SELECT 1 FROM job_records
                  WHERE id = ? AND subject_id = ? AND job_type = 'process_video'
                    AND status = 'leased' AND lease_token = ?
                )`,
        params: [objectId, shareUrl, durationMs, uploadedAt, expiresAt, uploadedAt,
          assetId, durationMs, APP_CONFIG.media.durationMatchToleranceMs,
          jobId, assetId, leaseToken],
      },
      {
        sql: `UPDATE job_records
              SET status = 'succeeded', leased_at = NULL, lease_expires_at = NULL,
                  lease_token = NULL, last_error_code = NULL, updated_at = ?
              WHERE id = ? AND subject_id = ? AND job_type = 'process_video'
                AND status = 'leased' AND lease_token = ?`,
        params: [uploadedAt, jobId, assetId, leaseToken],
      },
    ]);
    if (Number(results?.[0]?.meta?.changes ?? 0) !== 1
      || Number(results?.[1]?.meta?.changes ?? 0) !== 1) {
      throw Object.assign(new Error('Process-video lease expired or was claimed by another runner.'), {
        code: 'media_lease_stale',
      });
    }
    return { stored: true };
  }

  async failProcessVideoJob({ jobId, assetId, leaseToken, attempts, errorCode, now = new Date().toISOString() }) {
    if (typeof leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(leaseToken)) {
      throw new TypeError('A valid process-video lease token is required.');
    }
    const safeAttempts = Math.max(1, Math.min(100, Number.isInteger(attempts) ? attempts : 1));
    const dead = safeAttempts >= 8;
    const delayMinutes = Math.min(360, 2 ** Math.min(safeAttempts, 8));
    const availableAt = new Date(Date.parse(now) + delayMinutes * 60_000).toISOString();
    const result = await this.#db.batch([
      {
        sql: `UPDATE video_assets SET status = 'error', attempts = ?, last_error_code = ?, updated_at = ?
              WHERE id = ? AND status = 'processing'
                AND EXISTS (SELECT 1 FROM job_records WHERE id = ? AND subject_id = ?
                  AND job_type = 'process_video' AND status = 'leased' AND lease_token = ?)`,
        params: [safeAttempts, errorCode, now, assetId, jobId, assetId, leaseToken],
      },
      {
        sql: `UPDATE job_records
              SET status = ?, available_at = ?, leased_at = NULL, lease_expires_at = NULL,
                  lease_token = NULL, last_error_code = ?, updated_at = ?
              WHERE id = ? AND subject_id = ? AND job_type = 'process_video'
                AND status = 'leased' AND lease_token = ?`,
        params: [dead ? 'dead' : 'retry', availableAt, errorCode, now, jobId, assetId, leaseToken],
      },
    ]);
    if (Number(result?.[0]?.meta?.changes ?? 0) !== 1
      || Number(result?.[1]?.meta?.changes ?? 0) !== 1) {
      return { stale: true, dead: false, retry: false };
    }
    return { stale: false, dead, retry: !dead, availableAt };
  }

  async registerStoredMedia({ assetId, objectId, shareUrl, durationMs, uploadedAt, expiresAt }) {
    const existing = await this.#db.query(
      'SELECT status, storage_object_id FROM video_assets WHERE id = ? LIMIT 1',
      [assetId],
    );
    const current = existing[0];
    if (current && ['stored', 'clicked'].includes(current.status) && current.storage_object_id === objectId) {
      return { registered: true, alreadyRegistered: true };
    }

    const result = await this.#db.run(`
      UPDATE video_assets
      SET status = 'stored', storage_provider = 'mega', storage_object_id = ?,
          share_url = ?, uploaded_at = ?, first_clicked_at = NULL, expires_at = ?,
          thumbnail_key = NULL, thumbnail_content_type = NULL,
          attempts = 0, last_error_code = NULL, updated_at = ?
      WHERE id = ?
        AND duration_ms IS NOT NULL
        AND duration_ms > 0
        AND duration_ms <= 600000
        AND ABS(duration_ms - ?) <= ?
        AND status IN ('eligible', 'copy_blocked', 'processing', 'error')
    `, [objectId, shareUrl, uploadedAt, expiresAt, uploadedAt, assetId, durationMs, APP_CONFIG.media.durationMatchToleranceMs]);

    if (Number(result?.meta?.changes ?? 0) !== 1) {
      throw new Error('Video asset is not in a storable state or exceeds the duration limit.');
    }
    return { registered: true, alreadyRegistered: false };
  }

  async setThumbnailKey(assetId, key, now = new Date().toISOString()) {
    const result = await this.#db.run(`
      UPDATE video_assets
      SET thumbnail_key = ?, thumbnail_content_type = 'image/webp', updated_at = ?
      WHERE id = ? AND status IN ('stored', 'clicked') AND expires_at > ?
    `, [key, now, assetId, now]);
    return Number(result?.meta?.changes ?? 0) === 1;
  }

  async hasDueProcessVideoJobs({ now = new Date().toISOString() } = {}) {
    const rows = await this.#db.query(`
      SELECT 1 AS due
      FROM job_records
      WHERE job_type = 'process_video'
        AND available_at <= ?
        AND (
          status IN ('pending', 'retry')
          OR (status = 'leased' AND lease_expires_at <= ?)
        )
      LIMIT 1
    `, [now, now]);
    return rows.length > 0;
  }

  async hasDueDeletionJobs({ now = new Date().toISOString() } = {}) {
    const rows = await this.#db.query(`
      SELECT 1 AS due
      FROM video_assets
      WHERE status IN ('stored', 'clicked')
        AND uploaded_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?
      UNION ALL
      SELECT 1 AS due
      FROM job_records
      WHERE job_type = 'delete_video'
        AND (
          (status IN ('pending', 'retry') AND available_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?)
        )
      LIMIT 1
    `, [now, now, now]);
    return rows.length > 0;
  }

  async claimDueDeletionJobs({ now = new Date().toISOString(), limit = 20, leaseMs = 30 * 60_000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Deletion claim limit must be between 1 and 50.');
    const dueAssets = await this.#db.query(`
      SELECT id
      FROM video_assets
      WHERE status IN ('stored', 'clicked')
        AND uploaded_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
    `, [now, limit]);
    // delete_pending assets already own a job (created atomically with the status
    // change below), so re-selecting them would let stuck jobs hog these slots.

    if (dueAssets.length > 0) {
      const statements = [];
      for (const asset of dueAssets) {
        const jobId = crypto.randomUUID();
        statements.push({
          sql: `INSERT OR IGNORE INTO job_records (
                  id, job_type, subject_id, status, idempotency_key, payload_json,
                  attempts, available_at, created_at, updated_at
                ) VALUES (?, 'delete_video', ?, 'pending', ?, ?, 0, ?, ?, ?)`,
          params: [jobId, asset.id, `retention:${asset.id}`, JSON.stringify({ assetId: asset.id }), now, now, now],
        });
        statements.push({
          sql: `UPDATE video_assets SET status = 'delete_pending', updated_at = ?
                WHERE id = ? AND status IN ('stored', 'clicked', 'delete_pending') AND expires_at <= ?`,
          params: [now, asset.id, now],
        });
      }
      await this.#db.batch(statements);
    }

    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const claimed = await this.#db.query(`
      UPDATE job_records
      SET status = 'leased', attempts = attempts + 1, leased_at = ?,
          lease_expires_at = ?, lease_token = lower(hex(randomblob(16))), updated_at = ?
      WHERE id IN (
        SELECT id FROM job_records
        WHERE job_type = 'delete_video'
          AND available_at <= ?
          AND (status IN ('pending', 'retry') OR (status = 'leased' AND lease_expires_at <= ?))
        ORDER BY available_at ASC, id ASC
        LIMIT ?
      )
      RETURNING id, subject_id, attempts, lease_token
    `, [now, leaseUntil, now, now, now, limit]);

    if (claimed.length === 0) return [];
    const assetIds = claimed.map((job) => job.subject_id).filter((id) => typeof id === 'string');
    if (assetIds.length === 0) return [];
    const mediaRows = await this.#db.query(`
      SELECT id, storage_provider, storage_object_id, thumbnail_key
      FROM video_assets
      WHERE status = 'delete_pending' AND id IN (${placeholders(assetIds.length)})
    `, assetIds);
    const byId = new Map(mediaRows.map((row) => [row.id, row]));
    const orphans = claimed.filter((job) => !byId.has(job.subject_id));
    if (orphans.length > 0) {
      // The asset vanished (manual cleanup, prune). Close the job instead of
      // letting its lease expire and be re-claimed forever.
      await this.#db.batch(orphans.map((job) => ({
        sql: `UPDATE job_records
              SET status = 'cancelled', leased_at = NULL, lease_expires_at = NULL,
                  lease_token = NULL, updated_at = ?
              WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        params: [now, job.id, job.lease_token],
      })));
    }
    return claimed.flatMap((job) => {
      const asset = byId.get(job.subject_id);
      if (!asset) return [];
      if (typeof job.lease_token !== 'string' || !/^[a-f0-9]{32}$/u.test(job.lease_token)) return [];
      return [{
        jobId: job.id,
        leaseToken: job.lease_token,
        assetId: asset.id,
        attempts: job.attempts,
        storageProvider: asset.storage_provider,
        storageObjectId: asset.storage_object_id,
        thumbnailKey: asset.thumbnail_key,
      }];
    });
  }

  async getDeletionThumbnailKey({ assetId, jobId, leaseToken }) {
    const rows = await this.#db.query(`
      SELECT a.thumbnail_key
      FROM video_assets AS a
      INNER JOIN job_records AS j
        ON j.subject_id = a.id
       AND j.id = ?
       AND j.job_type = 'delete_video'
       AND j.status = 'leased'
       AND j.lease_token = ?
      WHERE a.id = ? AND a.status = 'delete_pending'
      LIMIT 1
    `, [jobId, leaseToken, assetId]);
    if (!rows[0]) {
      throw Object.assign(new Error('Retention lease is no longer owned by this runner.'), {
        code: 'retention_lease_stale',
      });
    }
    return typeof rows[0].thumbnail_key === 'string' ? rows[0].thumbnail_key : null;
  }

  async completeDeletion({ jobId, assetId, leaseToken, now = new Date().toISOString() }) {
    if (typeof leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(leaseToken)) {
      throw new TypeError('A valid retention lease token is required.');
    }
    const results = await this.#db.batch([
      {
        sql: `DELETE FROM video_assets
              WHERE id = ? AND status = 'delete_pending'
                AND EXISTS (
                  SELECT 1 FROM job_records
                  WHERE id = ? AND subject_id = ? AND job_type = 'delete_video'
                    AND status = 'leased' AND lease_token = ?
                )`,
        params: [assetId, jobId, assetId, leaseToken],
      },
      {
        sql: `UPDATE job_records
              SET status = 'succeeded', leased_at = NULL, lease_expires_at = NULL,
                  lease_token = NULL, last_error_code = NULL, updated_at = ?
              WHERE id = ? AND subject_id = ? AND job_type = 'delete_video'
                AND status = 'leased' AND lease_token = ?`,
        params: [now, jobId, assetId, leaseToken],
      },
    ]);
    const deletedAsset = Number(results?.[0]?.meta?.changes ?? 0) === 1;
    const completedJob = Number(results?.[1]?.meta?.changes ?? 0) === 1;
    if (!deletedAsset || !completedJob) {
      throw Object.assign(new Error('Retention lease expired or was claimed by another runner.'), {
        code: 'retention_lease_stale',
      });
    }
    return { deletedFromCatalog: true };
  }

  /**
   * Bounded housekeeping so D1 does not grow forever. Removes, in small
   * batches: video rows that never reached storage, posts without any video row,
   * old scan history and finished retention jobs. Stored/clicked/delete_pending
   * videos and dead jobs are never touched.
   */
  async pruneStale({ now = new Date().toISOString(), retainDays = 14, discardedDays = 3, jobRetainDays = 7, batchSize = 500, continuation = false } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError('Prune batch size must be between 1 and 1000.');
    }
    if (!Number.isInteger(retainDays) || retainDays < 3 || !Number.isInteger(jobRetainDays) || jobRetainDays < 1) {
      throw new RangeError('Prune retention windows are too short.');
    }
    if (!Number.isInteger(discardedDays) || discardedDays < 1 || discardedDays > retainDays) {
      throw new RangeError('discardedDays must be between 1 and retainDays.');
    }
    // At most one housekeeping run per UTC day, even if several scans fall inside the
    // maintenance hour. Later batches of the same run pass `continuation`.
    if (!continuation) {
      await this.#ensureStateTable();
      const today = now.slice(0, 10);
      const rows = await this.#db.query('SELECT value FROM scan_state WHERE key = ?', ['last_prune']);
      if (rows[0]?.value === today) return { videos: 0, posts: 0, scans: 0, jobs: 0, skipped: true };
      await this.#db.run(`
        INSERT INTO scan_state (key, value, updated_at) VALUES ('last_prune', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `, [today, now]);
    }
    const cutoff = new Date(Date.parse(now) - retainDays * 86_400_000).toISOString();
    const discardedCutoff = new Date(Date.parse(now) - discardedDays * 86_400_000).toISOString();
    const jobCutoff = new Date(Date.parse(now) - jobRetainDays * 86_400_000).toISOString();

    const results = await this.#db.batch([
      {
        sql: `DELETE FROM video_assets
              WHERE id IN (
                SELECT id FROM video_assets
                WHERE status NOT IN ('stored', 'clicked', 'delete_pending')
                  AND ((status IN ('discovered', 'ignored', 'too_long', 'duration_unknown', 'copy_blocked') AND discovered_at < ?)
                       OR discovered_at < ?)
                LIMIT ?
              )`,
        params: [discardedCutoff, cutoff, batchSize],
      },
      {
        sql: `DELETE FROM post_tags
              WHERE post_id IN (
                SELECT p.id FROM posts p
                WHERE p.discovered_at < ?
                  AND NOT EXISTS (SELECT 1 FROM video_assets a WHERE a.post_id = p.id)
                LIMIT ?
              )`,
        params: [discardedCutoff, batchSize],
      },
      {
        sql: `DELETE FROM posts
              WHERE id IN (
                SELECT p.id FROM posts p
                WHERE p.discovered_at < ?
                  AND NOT EXISTS (SELECT 1 FROM video_assets a WHERE a.post_id = p.id)
                LIMIT ?
              )`,
        params: [discardedCutoff, batchSize],
      },
      {
        sql: `DELETE FROM scan_runs
              WHERE id IN (SELECT id FROM scan_runs WHERE started_at < ? LIMIT ?)`,
        params: [cutoff, batchSize],
      },
      {
        sql: `DELETE FROM auth_attempts WHERE window_start < ?`,
        params: [new Date(Date.parse(now) - 86_400_000).toISOString()],
      },
      {
        sql: `DELETE FROM job_records
              WHERE id IN (
                SELECT id FROM job_records
                WHERE (status IN ('succeeded', 'cancelled')
                       OR (status = 'dead' AND job_type = 'process_video'))
                  AND updated_at < ?
                LIMIT ?
              )`,
        params: [jobCutoff, batchSize],
      },
    ]);
    const changed = (index) => Number(results?.[index]?.meta?.changes ?? 0);
    return { videos: changed(0), posts: changed(2), scans: changed(3), jobs: changed(5) };
  }

  async failDeletion({ jobId, leaseToken, errorCode, attempts, now = new Date().toISOString() }) {
    if (typeof leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(leaseToken)) {
      throw new TypeError('A valid retention lease token is required.');
    }
    const maxAttempts = 8;
    const dead = attempts >= maxAttempts;
    const delayMs = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.max(0, attempts - 1)));
    const availableAt = new Date(Date.parse(now) + delayMs).toISOString();
    const result = await this.#db.run(`
      UPDATE job_records
      SET status = ?, available_at = ?, leased_at = NULL, lease_expires_at = NULL,
          lease_token = NULL, last_error_code = ?, updated_at = ?
      WHERE id = ? AND job_type = 'delete_video' AND status = 'leased' AND lease_token = ?
    `, [dead ? 'dead' : 'retry', availableAt, String(errorCode).slice(0, 80), now, jobId, leaseToken]);
    if (Number(result?.meta?.changes ?? 0) !== 1) {
      return { retry: false, dead: false, stale: true };
    }
    return { retry: !dead, dead, stale: false };
  }
}
