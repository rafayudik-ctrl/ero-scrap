const MAX_CURSOR_LENGTH = 512;

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function encodeCursor({ discoveredAt, id, durationMs = null }) {
  if (typeof discoveredAt !== 'string' || !Number.isFinite(Date.parse(discoveredAt))) {
    throw new TypeError('Invalid cursor timestamp.');
  }
  if (typeof id !== 'string' || id.length < 1 || id.length > 128) {
    throw new TypeError('Invalid cursor id.');
  }
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) {
    throw new TypeError('Invalid cursor duration.');
  }
  return encodeBase64Url(durationMs === null ? { discoveredAt, id } : { discoveredAt, id, durationMs });
}

export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    return null;
  }

  try {
    const parsed = decodeBase64Url(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.discoveredAt !== 'string' || !Number.isFinite(Date.parse(parsed.discoveredAt))) return null;
    if (typeof parsed.id !== 'string' || parsed.id.length < 1 || parsed.id.length > 128) return null;
    if (parsed.durationMs !== undefined && (!Number.isSafeInteger(parsed.durationMs) || parsed.durationMs < 0)) return null;
    return parsed.durationMs === undefined
      ? { discoveredAt: parsed.discoveredAt, id: parsed.id }
      : { discoveredAt: parsed.discoveredAt, id: parsed.id, durationMs: parsed.durationMs };
  } catch {
    return null;
  }
}
