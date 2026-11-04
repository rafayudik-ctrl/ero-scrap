import { lstat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { assertCopyAuthorized } from '../../config/src/security.js';
import { createMegaCommandRunner } from './command-runner.js';
import { APP_CONFIG } from '../../config/src/app.js';

const ASSET_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}$/u;
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ogv']);
const MEGA_URL_PATTERN = /https:\/\/mega\.nz\/(?:file|folder)\/[^\s"'<>]+|https:\/\/mega\.nz\/#(?:F!)?[^\s"'<>]+/u;

export class MegaStorageError extends Error {
  constructor(message, { code = 'mega_storage_error', cause } = {}) {
    super(message, { cause });
    this.name = 'MegaStorageError';
    this.code = code;
  }
}

function normalizeRemoteRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.includes('..')) {
    throw new TypeError('MEGA remote root must be a safe absolute remote path.');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^[A-Za-z0-9._-]{1,64}$/u.test(part))) {
    throw new TypeError('MEGA remote root contains an invalid path segment.');
  }
  return `/${parts.join('/')}`;
}

function parseShareUrl(output) {
  const match = String(output).match(MEGA_URL_PATTERN);
  if (!match) throw new MegaStorageError('MEGAcmd did not return a recognized share URL.', { code: 'mega_share_url_missing' });
  const candidate = match[0].replace(/[),.;]+$/u, '');
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.hostname !== 'mega.nz' || url.username || url.password) {
    throw new MegaStorageError('MEGAcmd returned an unsafe share URL.', { code: 'mega_share_url_invalid' });
  }
  return url.toString();
}

function validateAssetId(value) {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
    throw new TypeError('assetId must be a 32-character hexadecimal ID.');
  }
}

function isMissingRemoteObject(error) {
  const diagnostic = `${error?.stdout ?? ''} ${error?.stderr ?? ''}`.toLowerCase();
  return /(?:not found|couldn'?t find|could not find|cannot find|no such (?:file|path)|does not exist|doesn'?t exist|enoent)/u.test(diagnostic);
}


export class MegaCmdStorageProvider {
  #run;
  #remoteRoot;
  #authorizeCopy;
  #now;

  constructor({ runCommand, timeoutMs = 120_000, remoteRoot = '/Ero-Scrap', authorizeCopy = assertCopyAuthorized, now = () => new Date() } = {}) {
    if ((runCommand !== undefined && typeof runCommand !== 'function') || typeof authorizeCopy !== 'function' || typeof now !== 'function') {
      throw new TypeError('MEGA provider dependencies must be functions.');
    }
    this.#run = runCommand ?? createMegaCommandRunner({ timeoutMs });
    this.#remoteRoot = normalizeRemoteRoot(remoteRoot);
    this.#authorizeCopy = authorizeCopy;
    this.#now = now;
  }

  async checkConnection() {
    await this.#run('whoami', []);
    return { connected: true };
  }

  async uploadLocalFile({ assetId, localPath }) {
    // The hard gate runs before stat calls or any MEGAcmd command.
    this.#authorizeCopy();
    validateAssetId(assetId);
    if (typeof localPath !== 'string' || !localPath.trim()) throw new TypeError('localPath is required.');

    const absolutePath = resolve(localPath);
    let fileStat;
    try {
      fileStat = await lstat(absolutePath);
    } catch (error) {
      throw new MegaStorageError('Authorized local file could not be inspected.', { code: 'local_file_unavailable', cause: error });
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size <= 0
      || fileStat.size > APP_CONFIG.media.maxFileBytes) {
      throw new MegaStorageError('Local file must be a non-empty regular video within the configured size limit.', { code: 'local_file_invalid' });
    }

    const fileName = basename(absolutePath);
    const extension = extname(fileName).toLowerCase();
    if (!SAFE_FILENAME_PATTERN.test(fileName) || !ALLOWED_EXTENSIONS.has(extension)) {
      throw new MegaStorageError('File name or video extension is not supported.', { code: 'local_file_unsupported' });
    }

    const remoteDirectory = `${this.#remoteRoot}/${assetId}`;
    const remoteObjectId = `${remoteDirectory}/${fileName}`;

    // Deterministic object paths make retries idempotent. If a previous run
    // uploaded successfully but lost its D1 acknowledgement, re-export the
    // exact existing object instead of uploading a duplicate or failing dead.
    try {
      const existing = await this.#run('ls', ['--show-handles', remoteObjectId]);
      const exported = await this.#run('export', ['-a', remoteObjectId]);
      const existingShareUrl = parseShareUrl(`${exported.stdout}\n${exported.stderr}`);
      return Object.freeze({
        provider: 'mega',
        objectId: remoteObjectId,
        shareUrl: existingShareUrl,
        sizeBytes: fileStat.size,
        uploadedAt: this.#now().toISOString(),
        verified: existing.exitCode === 0,
        reusedExisting: true,
      });
    } catch (error) {
      if (!isMissingRemoteObject(error)) throw error;
    }

    await this.#run('mkdir', ['-p', remoteDirectory]);
    let verification;
    let shareUrl;
    try {
      await this.#run('put', [absolutePath, remoteDirectory]);
      verification = await this.#run('ls', ['--show-handles', remoteObjectId]);
      const exportResult = await this.#run('export', ['-a', remoteObjectId]);
      shareUrl = parseShareUrl(`${exportResult.stdout}\n${exportResult.stderr}`);
    } catch (rawError) {
      const error = rawError instanceof Error
        ? rawError
        : new MegaStorageError('MEGA upload could not be finalized.', { code: 'mega_upload_failed' });
      // Upload may have succeeded even if verification or link creation failed.
      // Probe the exact destination and compensate only when it is confirmed
      // present. Authentication/network failures are never mistaken for absence.
      let confirmedPresent = false;
      try {
        await this.#run('ls', ['--show-handles', remoteObjectId]);
        confirmedPresent = true;
      } catch (probeError) {
        if (!isMissingRemoteObject(probeError)) {
          Object.defineProperty(error, 'cleanupError', { value: probeError, enumerable: false });
        }
      }

      if (confirmedPresent) {
        await this.#run('export', ['-d', remoteObjectId]).catch(() => {});
        try {
          await this.#run('rm', ['-f', remoteObjectId]);
        } catch (cleanupError) {
          Object.defineProperty(error, 'cleanupError', { value: cleanupError, enumerable: false });
        }
      }
      throw error;
    }

    return Object.freeze({
      provider: 'mega',
      objectId: remoteObjectId,
      shareUrl,
      sizeBytes: fileStat.size,
      uploadedAt: this.#now().toISOString(),
      verified: verification.exitCode === 0,
      reusedExisting: false,
    });
  }

  async deleteObject({ assetId, objectId }) {
    validateAssetId(assetId);
    if (typeof objectId !== 'string') throw new TypeError('objectId is required.');

    const prefix = `${this.#remoteRoot}/${assetId}/`;
    const relative = objectId.startsWith(prefix) ? objectId.slice(prefix.length) : '';
    if (!relative || relative.includes('/') || relative === '.' || relative === '..' || !SAFE_FILENAME_PATTERN.test(relative)) {
      throw new MegaStorageError('Refusing to delete a path outside the asset folder.', { code: 'unsafe_remote_path' });
    }

    // Probe the exact file first. A confirmed missing file is already in the
    // desired state; connectivity/authentication errors are never treated as
    // successful deletion.
    try {
      await this.#run('ls', ['--show-handles', objectId]);
    } catch (error) {
      if (isMissingRemoteObject(error)) return { deleted: true, alreadyAbsent: true, objectId };
      throw error;
    }

    // Revoke sharing first, then remove the exact file (never recursive).
    // Removing the underlying file invalidates its public share as well. The
    // explicit export revocation is best-effort because an unshared file has
    // no export record to revoke; the subsequent exact rm is authoritative.
    await this.#run('export', ['-d', objectId]).catch(() => {});

    try {
      await this.#run('rm', ['-f', objectId]);
    } catch (error) {
      // Another administrative action may have deleted the file between the
      // probe and rm. Confirm absence before treating that race as success.
      try {
        await this.#run('ls', ['--show-handles', objectId]);
      } catch (probeError) {
        if (isMissingRemoteObject(probeError)) return { deleted: true, alreadyAbsent: true, objectId };
      }
      throw error;
    }
    return { deleted: true, alreadyAbsent: false, objectId };
  }
}
