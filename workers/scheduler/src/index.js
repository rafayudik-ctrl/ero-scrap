// Ero-Scrap scheduler: a tiny Cloudflare Worker whose only job is to start the
// GitHub Actions workflow on time. Cloudflare Cron Triggers are exact and free
// (no credit card), unlike GitHub's own `schedule`, which delays or drops runs.
//
// One outgoing request every 15 minutes, no database, no stored state, no
// dependencies. It is a single file so it can also be pasted into the
// Cloudflare dashboard editor. COPY_AUTHORIZED stays the only lock: this
// Worker always asks for mode "auto", which the workflow resolves from it.

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const REF_PATTERN = /^[A-Za-z0-9._\/-]{1,100}$/u;
const FILE_PATTERN = /^[A-Za-z0-9._-]{1,100}\.ya?ml$/u;
const MODES = new Set(['auto', 'metadata', 'full', 'cleanup']);

export class SchedulerConfigError extends Error {}

/** Validates the configuration and builds the GitHub request (pure, no I/O). */
export function buildDispatchRequest(env = {}) {
  const repo = String(env.GITHUB_REPO ?? '');
  const ref = String(env.GITHUB_REF ?? 'main');
  const file = String(env.WORKFLOW_FILE ?? 'automation.yml');
  const mode = String(env.MODE ?? 'auto');
  const token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!REPO_PATTERN.test(repo) || repo.startsWith('OWNER/')) throw new SchedulerConfigError('GITHUB_REPO must look like owner/repository.');
  if (!REF_PATTERN.test(ref) || ref.includes('..')) throw new SchedulerConfigError('GITHUB_REF is invalid.');
  if (!FILE_PATTERN.test(file)) throw new SchedulerConfigError('WORKFLOW_FILE is invalid.');
  if (!MODES.has(mode)) throw new SchedulerConfigError('MODE must be auto, metadata, full or cleanup.');
  if (token.length < 20) throw new SchedulerConfigError('The GITHUB_TOKEN secret is missing.');
  return {
    url: `https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ero-scrap-scheduler',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref, inputs: { mode } }),
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the workflow. One retry only for a network error or a 5xx/429. */
export async function dispatchWorkflow(env, { fetchImpl = fetch, wait = sleep, logger = console } = {}) {
  const { url, init } = buildDispatchRequest(env);
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.status === 204) {
        logger.info?.('[ero-scrap-scheduler] workflow dispatched', { attempt });
        return { dispatched: true, attempt };
      }
      lastStatus = response.status;
      // Never log the request (it carries the token). GitHub's message is safe to show.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      logger.error?.('[ero-scrap-scheduler] GitHub refused the dispatch', { status: response.status, attempt, detail });
      if (response.status < 500 && response.status !== 429) break;
    } catch {
      lastStatus = 0;
      logger.error?.('[ero-scrap-scheduler] network error while dispatching', { attempt });
    }
    if (attempt === 1) await wait(3000);
  }
  throw new Error(`Workflow dispatch failed (status ${lastStatus}).`);
}

export default {
  // Called by the Cron Trigger. A thrown error shows up as a failed run in the
  // Cloudflare dashboard, which is the signal that something needs attention.
  async scheduled(_event, env) {
    await dispatchWorkflow(env);
  },
  // No public surface.
  async fetch() {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
