import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUnopenedDays } from '../../../../packages/config/src/retention-days.js';
import { APP_CONFIG } from '../../../../packages/config/src/app.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

function normalizeCollectorEndpoint(value, appEnv) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing runner configuration: COLLECTOR_API_URL.');
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('COLLECTOR_API_URL must be an absolute URL.');
  }

  const secureProtocol = url.protocol === 'https:';
  const localDevelopment = appEnv === 'development'
    && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (!secureProtocol && !localDevelopment) {
    throw new Error('COLLECTOR_API_URL must use HTTPS (HTTP is allowed only for localhost in development).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('COLLECTOR_API_URL must not contain credentials, a query, or a fragment.');
  }
  if (url.pathname.replace(/\/$/u, '') !== '/internal/collector') {
    throw new Error('COLLECTOR_API_URL must end exactly in /internal/collector.');
  }
  return url.toString().replace(/\/$/u, '');
}


export function loadMegaConfig(env = process.env) {
  const remoteRoot = String(env.MEGA_REMOTE_ROOT ?? '/Ero-Scrap').trim();
  const timeoutValue = Number(env.MEGA_COMMAND_TIMEOUT_MS ?? 120_000);
  const megaCommandTimeoutMs = Number.isInteger(timeoutValue)
    ? Math.min(15 * 60_000, Math.max(1_000, timeoutValue))
    : 120_000;
  return Object.freeze({
    megaRemoteRoot: remoteRoot || '/Ero-Scrap',
    megaCommandTimeoutMs,
    ffmpegBinary: String(env.FFMPEG_BINARY ?? 'ffmpeg').trim() || 'ffmpeg',
    ffprobeBinary: String(env.FFPROBE_BINARY ?? 'ffprobe').trim() || 'ffprobe',
  });
}

/**
 * Runtime credentials only authenticate the private Worker API. The runner
 * never receives Cloudflare account/D1 administrative credentials.
 */
export function loadRunnerConfig(env = process.env) {
  const appEnv = String(env.APP_ENV ?? 'production').trim();
  const endpoint = normalizeCollectorEndpoint(env.COLLECTOR_API_URL, appEnv);
  const token = String(env.COLLECTOR_API_TOKEN ?? '').trim();
  const accessClientId = String(env.CF_ACCESS_CLIENT_ID ?? '').trim();
  const accessClientSecret = String(env.CF_ACCESS_CLIENT_SECRET ?? '').trim();

  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together.');
  }
  // The Access service token is optional: it is only needed when the site uses
  // AUTH_MODE="access" and /internal/* sits behind a Zero Trust policy. The
  // Bearer token below always protects the internal API.

  if (token.length < 32) {
    throw new Error('COLLECTOR_API_TOKEN must contain at least 32 characters.');
  }

  return Object.freeze({
    appEnv,
    collectorApiUrl: endpoint,
    collectorApiToken: token,
    accessClientId: accessClientId || null,
    accessClientSecret: accessClientSecret || null,
    collectorApiTimeoutMs: 15_000,
    keywordFilePath: resolve(PROJECT_ROOT, 'config/search-keyword.txt'),
    scanIntervalMs: APP_CONFIG.scan.intervalMinutes * 60_000,
    maxPostInspectionsPerRun: APP_CONFIG.scan.maxPostInspectionsPerRun,
    retentionIntervalMs: APP_CONFIG.retention.sweepIntervalMinutes * 60_000,
    retentionBatchSize: APP_CONFIG.retention.batchSize,
    retentionMaxBatches: APP_CONFIG.retention.maxBatchesPerSweep,
    unopenedRetentionDays: resolveUnopenedDays(env.UNOPENED_RETENTION_DAYS),
    maintenanceIntervalMs: APP_CONFIG.maintenance.intervalHours * 60 * 60_000,
    ...loadMegaConfig(env),
  });
}
