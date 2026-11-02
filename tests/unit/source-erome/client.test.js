import test from 'node:test';
import assert from 'node:assert/strict';
import { EromeClient, EromeSourceError } from '../../../packages/source-erome/src/client.js';

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

test('client requests exactly the first and second New pages', async () => {
  const urls = [];
  const client = new EromeClient({
    minimumDelayMs: 0,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return htmlResponse('<html>ok</html>');
    },
  });

  await client.fetchNewPage(1);
  await client.fetchNewPage(2);
  assert.equal(new URL(urls[0]).pathname, '/explore/new');
  assert.equal(new URL(urls[0]).search, '');
  assert.equal(new URL(urls[1]).searchParams.get('page'), '2');
  await assert.rejects(() => client.fetchNewPage(3), /first two New pages/);
  assert.equal(urls.length, 2);
});

test('client accepts only canonical public Erome album URLs', async () => {
  let requested = 0;
  const client = new EromeClient({
    minimumDelayMs: 0,
    fetchImpl: async () => {
      requested += 1;
      return htmlResponse('<html>ok</html>');
    },
  });

  await assert.rejects(() => client.fetchAlbum('https://outside.example/a/AbCd1234'), /public Erome/);
  assert.equal(requested, 0);
});

test('client does not follow redirects or retry access denials', async () => {
  const redirectClient = new EromeClient({
    minimumDelayMs: 0,
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://outside.example' } }),
  });
  await assert.rejects(() => redirectClient.fetchNewPage(1), (error) => error.code === 'redirect_rejected');

  const deniedClient = new EromeClient({
    minimumDelayMs: 0,
    fetchImpl: async () => new Response('blocked', { status: 403 }),
  });
  await assert.rejects(() => deniedClient.fetchNewPage(1), (error) => error.code === 'access_denied');
});

test('client stops on HTTP 429 and preserves Retry-After without retrying', async () => {
  let calls = 0;
  const client = new EromeClient({
    minimumDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } });
    },
  });

  await assert.rejects(() => client.fetchNewPage(1), (error) => {
    assert.ok(error instanceof EromeSourceError);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
  assert.equal(calls, 1);
});

test('client rejects non-HTML and oversized responses', async () => {
  const binaryClient = new EromeClient({
    minimumDelayMs: 0,
    fetchImpl: async () => new Response('binary', { headers: { 'Content-Type': 'video/mp4' } }),
  });
  await assert.rejects(() => binaryClient.fetchNewPage(1), (error) => error.code === 'unexpected_content_type');

  const largeClient = new EromeClient({
    minimumDelayMs: 0,
    maxHtmlBytes: 4,
    fetchImpl: async () => htmlResponse('12345'),
  });
  await assert.rejects(() => largeClient.fetchNewPage(1), (error) => error.code === 'response_too_large');
});
