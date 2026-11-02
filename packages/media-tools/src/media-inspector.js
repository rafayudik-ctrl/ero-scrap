import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { APP_CONFIG } from '../../config/src/app.js';

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ogv']);
const MAX_OUTPUT_BYTES = 64 * 1024;

export class MediaInspectionError extends Error {
  constructor(message, { code = 'media_inspection_failed', cause } = {}) {
    super(message, { cause });
    this.name = 'MediaInspectionError';
    this.code = code;
  }
}

function runFfprobe(binary, args, { timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new MediaInspectionError('FFprobe could not be started.', {
        code: 'ffprobe_spawn_failed', cause: error,
      }));
      return;
    }

    const stdout = [];
    let outputBytes = 0;
    let timedOut = false;
    let oversized = false;
    let settled = false;

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        oversized = true;
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => finishError(new MediaInspectionError(
      'FFprobe process failed.', { code: 'ffprobe_spawn_failed', cause: error },
    )));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new MediaInspectionError('FFprobe exceeded its time limit.', { code: 'ffprobe_timeout' }));
      } else if (oversized) {
        reject(new MediaInspectionError('FFprobe output exceeded its size limit.', { code: 'ffprobe_output_limit' }));
      } else if (exitCode !== 0) {
        reject(new MediaInspectionError('FFprobe could not inspect the local media file.', { code: 'ffprobe_failed' }));
      } else {
        resolve(Buffer.concat(stdout).toString('utf8'));
      }
    });
  });
}

export class FfprobeMediaInspector {
  #binary;
  #timeoutMs;
  #spawn;

  constructor({ binary = 'ffprobe', timeoutMs = 20_000, spawnImpl = spawn } = {}) {
    if (typeof binary !== 'string' || !binary.trim()) throw new TypeError('FFprobe binary is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new RangeError('FFprobe timeout must be between 1 and 120 seconds.');
    }
    if (typeof spawnImpl !== 'function') throw new TypeError('FFprobe spawn implementation must be a function.');
    this.#binary = binary;
    this.#timeoutMs = timeoutMs;
    this.#spawn = spawnImpl;
  }

  async inspect({ localPath }) {
    if (typeof localPath !== 'string' || !localPath.trim()) throw new TypeError('localPath is required.');
    let fileStat;
    try {
      fileStat = await lstat(localPath);
    } catch (error) {
      throw new MediaInspectionError('Local media file could not be inspected.', {
        code: 'local_file_unavailable', cause: error,
      });
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size <= 0
      || fileStat.size > APP_CONFIG.media.maxFileBytes) {
      throw new MediaInspectionError('Local media must be a non-empty regular file within the size limit.', {
        code: 'local_file_invalid',
      });
    }
    if (!ALLOWED_EXTENSIONS.has(extname(basename(localPath)).toLowerCase())) {
      throw new MediaInspectionError('Local media extension is unsupported.', { code: 'unsupported_media_type' });
    }

    const output = await runFfprobe(this.#binary, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      localPath,
    ], { timeoutMs: this.#timeoutMs, spawnImpl: this.#spawn });

    let metadata;
    try {
      metadata = JSON.parse(output);
    } catch (error) {
      throw new MediaInspectionError('FFprobe returned invalid metadata.', { code: 'ffprobe_invalid_json', cause: error });
    }

    const durationSeconds = Number(metadata?.format?.duration);
    const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1_000)
      : null;
    const hasVideoStream = Array.isArray(metadata?.streams)
      && metadata.streams.some((stream) => stream?.codec_type === 'video');

    if (!hasVideoStream || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new MediaInspectionError('File is not a supported video with a confirmed duration.', {
        code: 'media_metadata_incomplete',
      });
    }

    return Object.freeze({ durationMs, sizeBytes: fileStat.size, hasVideoStream: true });
  }
}
