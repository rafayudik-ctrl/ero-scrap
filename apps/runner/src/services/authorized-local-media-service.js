import { readFile, unlink } from 'node:fs/promises';
import { assertCopyAuthorized } from '../../../../packages/config/src/security.js';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';

const MAX_THUMBNAIL_BYTES = APP_CONFIG.media.thumbnailMaxBytes;

/**
 * Stores a local file supplied by the operator and known to be authorized.
 * This service deliberately has no Erome URL/download input. The hard copy
 * gate is checked before reading the file or contacting MEGA.
 */
export class AuthorizedLocalMediaService {
  #unopenedDays;
  #storage;
  #repository;
  #thumbnailGenerator;
  #mediaInspector;
  #logger;
  #now;

  constructor({ storage, repository, mediaInspector, thumbnailGenerator = null, logger = console, now = () => new Date(), unopenedDays = APP_CONFIG.retention.unopenedDays }) {
    this.#unopenedDays = unopenedDays;
    if (!storage || typeof storage.uploadLocalFile !== 'function' || typeof storage.deleteObject !== 'function') {
      throw new TypeError('A MEGA-compatible storage provider is required.');
    }
    if (!repository || typeof repository.registerStoredMedia !== 'function') {
      throw new TypeError('A media repository is required.');
    }
    if (!mediaInspector || typeof mediaInspector.inspect !== 'function') {
      throw new TypeError('A media inspector is required to verify the local file duration.');
    }
    this.#storage = storage;
    this.#repository = repository;
    this.#thumbnailGenerator = thumbnailGenerator;
    this.#mediaInspector = mediaInspector;
    this.#logger = logger;
    this.#now = now;
  }

  async storeLocalVideo({ assetId, localPath }) {
    assertCopyAuthorized();
    const inspected = await this.#mediaInspector.inspect({ localPath });
    if (!Number.isSafeInteger(inspected?.durationMs) || inspected.durationMs <= 0
      || inspected.durationMs > APP_CONFIG.media.maxDurationMs) {
      throw new RangeError('Only videos with a locally confirmed duration of at most 600 seconds can be stored.');
    }

    const uploaded = await this.#storage.uploadLocalFile({ assetId, localPath });
    const uploadedAt = uploaded.uploadedAt ?? this.#now().toISOString();
    const expiresAt = new Date(Date.parse(uploadedAt) + this.#unopenedDays * 24 * 60 * 60 * 1_000).toISOString();

    try {
      await this.#repository.registerStoredMedia({
        assetId,
        objectId: uploaded.objectId,
        shareUrl: uploaded.shareUrl,
        durationMs: inspected.durationMs,
        uploadedAt,
        expiresAt,
      });
    } catch (error) {
      await this.#storage.deleteObject({ assetId, objectId: uploaded.objectId }).catch((cleanupError) => {
        this.#logger.error?.('[ero-scrap] failed to compensate unregistered MEGA object', {
          assetId,
          code: cleanupError?.code ?? 'storage_cleanup_failed',
        });
      });
      throw error;
    }

    let thumbnailStored = false;
    if (this.#thumbnailGenerator) {
      let generated;
      try {
        generated = await this.#thumbnailGenerator.generate({ localPath });
        const bytes = await readFile(generated.path);
        if (bytes.byteLength <= MAX_THUMBNAIL_BYTES) {
          await this.#repository.uploadThumbnail(assetId, new Uint8Array(bytes));
          thumbnailStored = true;
        }
      } catch (error) {
        this.#logger.warn?.('[ero-scrap] thumbnail generation skipped', {
          assetId,
          code: error?.code ?? 'thumbnail_generation_failed',
        });
      } finally {
        if (generated?.cleanup) await generated.cleanup().catch(() => {});
        else if (generated?.path) await unlink(generated.path).catch(() => {});
      }
    }

    return { assetId, uploadedAt, expiresAt, shareUrl: uploaded.shareUrl, thumbnailStored };
  }
}
