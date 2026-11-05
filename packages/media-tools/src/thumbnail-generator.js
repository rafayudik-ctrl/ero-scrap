import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertCopyAuthorized } from '../../config/src/security.js';
import { APP_CONFIG } from '../../config/src/app.js';

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ogv']);
const MAX_INPUT_BYTES = APP_CONFIG.media.maxFileBytes;
const MAX_OUTPUT_BYTES = APP_CONFIG.media.thumbnailMaxBytes;
// Fit inside a 320x320 box, keeping the aspect ratio and never upscaling:
// landscape 16:9 -> 320x180, vertical 9:16 -> 180x320 (smaller than scaling by width only).
export const THUMBNAIL_FILTER = `scale=w=min(${APP_CONFIG.media.thumbnailWidth}\\,iw):h=min(${APP_CONFIG.media.thumbnailWidth}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`;

export class ThumbnailGeneratorError extends Error {
  constructor(message, { code = 'thumbnail_generation_failed', cause } = {}) {
    super(message, { cause });
    this.name = 'ThumbnailGeneratorError';
    this.code = code;
  }
}

function runFfmpeg(binary, args, { timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new ThumbnailGeneratorError('FFmpeg could not be started.', { code: 'ffmpeg_spawn_failed', cause: error }));
      return;
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ThumbnailGeneratorError('FFmpeg process failed.', { code: 'ffmpeg_spawn_failed', cause: error }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ThumbnailGeneratorError('FFmpeg exceeded its time limit.', { code: 'ffmpeg_timeout' }));
      } else if (code !== 0) {
        // stderr is intentionally not included in the surfaced message; media
        // tooling can echo local paths or metadata.
        reject(new ThumbnailGeneratorError('FFmpeg could not generate the thumbnail.', { code: 'ffmpeg_failed' }));
      } else {
        resolve({ exitCode: code, diagnosticBytes: stderr.length });
      }
    });
  });
}

export class FfmpegThumbnailGenerator {
  #binary;
  #timeoutMs;
  #spawn;
  #maxOutputBytes;

  constructor({ binary = 'ffmpeg', timeoutMs = 45_000, spawnImpl = spawn, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
    if (typeof binary !== 'string' || !binary.trim()) throw new TypeError('FFmpeg binary is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new RangeError('FFmpeg timeout must be between 1 and 120 seconds.');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 16_384 || maxOutputBytes > MAX_OUTPUT_BYTES) throw new RangeError('Thumbnail size limit must be between 16 KiB and 256 KiB.');
    this.#binary = binary;
    this.#timeoutMs = timeoutMs;
    this.#spawn = spawnImpl;
    this.#maxOutputBytes = maxOutputBytes;
  }

  async generate({ localPath }) {
    assertCopyAuthorized();
    if (typeof localPath !== 'string' || !localPath.trim()) throw new TypeError('localPath is required.');
    const input = localPath;
    const inputStat = await lstat(input);
    if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size <= 0 || inputStat.size > MAX_INPUT_BYTES) {
      throw new ThumbnailGeneratorError('Input must be a non-empty regular local video file.', { code: 'invalid_thumbnail_input' });
    }
    if (!ALLOWED_EXTENSIONS.has(extname(basename(input)).toLowerCase())) {
      throw new ThumbnailGeneratorError('Input extension is unsupported.', { code: 'unsupported_thumbnail_input' });
    }

    const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-thumb-'));
    const output = join(directory, 'thumbnail.webp');
    try {
      await runFfmpeg(this.#binary, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', '00:00:01', '-i', input,
        '-frames:v', '1', '-an',
        '-vf', THUMBNAIL_FILTER,
        '-c:v', 'libwebp', '-quality', '68', '-preset', 'picture',
        '-f', 'webp', output,
      ], { timeoutMs: this.#timeoutMs, spawnImpl: this.#spawn });

      const outputStat = await stat(output);
      if (outputStat.size < 12 || outputStat.size > this.#maxOutputBytes) {
        throw new ThumbnailGeneratorError('Generated thumbnail is outside the allowed size range.', { code: 'thumbnail_size_invalid' });
      }
      return {
        path: output,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
