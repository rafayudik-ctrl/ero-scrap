const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function resolveApiBaseUrl() {
  const configured = window.ERO_SCRAP_CONFIG?.apiBaseUrl;
  if (typeof configured === 'string' && configured.trim()) {
    const url = new URL(configured.trim());
    const localHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) {
      throw new TypeError('The configured API origin must use HTTPS.');
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('The configured API origin must not contain credentials, paths, queries, or fragments.');
    }
    return url.origin;
  }
  return LOCAL_HOSTS.has(window.location.hostname) ? 'http://127.0.0.1:8787' : '';
}

const API_BASE_URL = resolveApiBaseUrl();

async function request(path, { signal } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`A API retornou uma resposta inválida (${response.status}).`);
  }

  if (!response.ok) {
    const message = payload?.error?.message || `Falha na API (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code || 'request_failed';
    throw error;
  }

  return payload;
}

export function getSystemStatus(options) {
  return request('/api/status', options);
}

export function getCatalogStats(options) {
  return request('/api/stats', options);
}

export function getCatalogPage({ query = '', cursor = null, limit = 24, signal } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  return request(`/api/catalog?${params}`, { signal });
}


export function getOpenActionUrl(itemId) {
  if (typeof itemId !== 'string' || !/^[a-f0-9]{32}$/u.test(itemId)) {
    throw new TypeError('Invalid catalog item ID.');
  }
  return `${API_BASE_URL}/api/catalog/${encodeURIComponent(itemId)}/open`;
}

export function resolveApiAssetUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/thumbnails/')) return null;
  return `${API_BASE_URL}${path}`;
}
