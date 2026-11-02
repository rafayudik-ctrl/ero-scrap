import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAlbumPage, parseNewListing } from '../../../packages/source-erome/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(resolve(HERE, '../../fixtures/erome', name), 'utf8');

test('New listing extracts only paired album-link and album-title cards', async () => {
  const html = await fixture('new-page-1.html');
  const posts = parseNewListing(html, 1);
  assert.deepEqual(posts, [
    {
      id: 'AbCd1234',
      canonicalUrl: 'https://www.erome.com/a/AbCd1234',
      title: 'Sample Matching Album',
      pageNumber: 1,
    },
    {
      id: 'EfGh5678',
      canonicalUrl: 'https://www.erome.com/a/EfGh5678',
      title: 'Images only album',
      pageNumber: 1,
    },
  ]);
});

test('listing parser hard-rejects page numbers beyond the first two', async () => {
  const html = await fixture('new-page-2.html');
  assert.equal(parseNewListing(html, 2)[0].id, 'IjKl9012');
  assert.throws(() => parseNewListing(html, 3), /first two New pages/);
});

test('album parser keeps videos only and preserves each video duration independently', async () => {
  const html = await fixture('album-mixed.html');
  const album = parseAlbumPage(html, 'https://www.erome.com/a/AbCd1234');

  assert.equal(album.postId, 'AbCd1234');
  assert.equal(album.title, 'Mixed sample post');
  assert.deepEqual(album.tags.map((tag) => tag.normalizedName), ['retro', 'sample keyword']);
  assert.equal(album.videos.length, 2);
  assert.equal(album.videos[0].sourceVideoId, 'VideoA123');
  assert.equal(album.videos[0].durationMs, 599_000);
  assert.equal(album.videos[0].mediaUrl, 'https://s1.erome.com/1234/AbCd1234/VideoA123.mp4');
  assert.equal(album.videos[1].sourceVideoId, 'VideoB456');
  assert.equal(album.videos[1].durationMs, 601_000);
  assert.equal(album.videos[1].mediaUrl, 'https://s2.erome.com/1234/AbCd1234/VideoB456.webm');
  assert.equal(album.imageCount, 2);
  assert.ok(album.videos.every((video) => !('type' in video) || video.type !== 'image'));
});

test('image-only albums produce zero video assets', async () => {
  const html = await fixture('album-images-only.html');
  const album = parseAlbumPage(html, 'https://www.erome.com/a/AbCd1234');
  assert.equal(album.imageCount, 2);
  assert.deepEqual(album.videos, []);
});

test('unknown video duration remains null and cannot be accepted', async () => {
  const html = await fixture('album-duration-unknown.html');
  const album = parseAlbumPage(html, 'https://www.erome.com/a/AbCd1234');
  assert.equal(album.videos.length, 1);
  assert.equal(album.videos[0].durationMs, null);
});

test('album parser accepts the observed HTML5 source pattern and data-setup duration only when explicit', () => {
  const html = `<!doctype html><html><body>
    <h1>Metadata example</h1>
    <div class="tags"><a href="/tags/keyword">#Keyword</a></div>
    <video data-setup='{"duration": 600}'><source src="https://v19.erome.com/1234/AbCd1234/VideoZ123_720p.mp4" type="video/mp4"></video>
    <div class="img"><img data-src="https://s63.erome.com/1234/AbCd1234/Preview.jpg"></div>
  </body></html>`;
  const album = parseAlbumPage(html, 'https://www.erome.com/a/AbCd1234');
  assert.equal(album.videos.length, 1);
  assert.equal(album.videos[0].durationMs, 600_000);
  assert.deepEqual(album.tags.map((tag) => tag.normalizedName), ['keyword']);
  assert.equal(album.imageCount, 1);
});

test('album parser rejects non-canonical and foreign URLs', async () => {
  const html = await fixture('album-images-only.html');
  assert.throws(() => parseAlbumPage(html, 'https://outside.example/a/AbCd1234'), /canonical Erome/);
});

test('media classification rejects external URLs and unknown file types', async () => {
  const { classifyMediaUrl } = await import('../../../packages/source-erome/src/normalizers.js');
  assert.equal(classifyMediaUrl('https://v19.erome.com/1234/post/video.mp4'), 'video');
  assert.equal(classifyMediaUrl('https://s63.erome.com/1234/post/image.webp'), 'image');
  assert.equal(classifyMediaUrl('https://outside.example/video.mp4'), 'unsupported');
  assert.equal(classifyMediaUrl('https://v19.erome.com/1234/post/file.bin'), 'unsupported');
});

test('album parser maps visible .duration labels to videos only when counts match', () => {
  const html = `<!doctype html><html><body><h1>Grouped media</h1>
    <div class="media-group"><span class="duration">09:58</span><div class="video">
      <video><source src="https://v19.erome.com/1234/AbCd1234/FirstVid123.mp4"></video>
    </div></div>
    <div class="media-group"><span class="duration">10:01</span><div class="video">
      <video><source src="https://v19.erome.com/1234/AbCd1234/SecondVid456.mp4"></video>
    </div></div>
  </body></html>`;
  const album = parseAlbumPage(html, 'https://www.erome.com/a/AbCd1234');
  assert.deepEqual(album.videos.map((video) => video.durationMs), [598_000, 601_000]);
});

test('ambiguous duration labels are not guessed or assigned to videos', () => {
  const html = `<!doctype html><html><body><h1>Ambiguous media</h1>
    <div class="duration">03:00</div>
    <video><source src="https://v19.erome.com/1234/AbCd1234/FirstVid123.mp4"></video>
    <video><source src="https://v19.erome.com/1234/AbCd1234/SecondVid456.mp4"></video>
  </body></html>`;
  const album = parseAlbumPage(html, 'https://www.erome.com/a/AbCd1234');
  assert.deepEqual(album.videos.map((video) => video.durationMs), [null, null]);
});

test('listing parser isolates the #albums container and does not shift malformed card pairs', () => {
  const html = `<!doctype html><html><body>
    <div class="album"><a class="album-link" href="/a/Wrong1234"></a><a class="album-title">Outside container</a></div>
    <div id="albums">
      <div class="album"><a class="album-link" href="/a/BadCard123"></a></div>
      <div class="album"><a class="album-link" href="/a/GoodCard12"></a><a class="album-title">Correct title</a></div>
    </div>
  </body></html>`;
  const posts = parseNewListing(html, 1);
  assert.deepEqual(posts.map((post) => [post.id, post.title]), [['GoodCard12', 'Correct title']]);
});


test('listing parser distinguishes a valid empty page from an unexpected HTML layout', () => {
  assert.deepEqual(parseNewListing('<div id="albums"></div>', 2), []);
  assert.throws(() => parseNewListing('<main>layout changed</main>', 2), /expected #albums container/);
});


test('album URL normalizer rejects embedded credentials and custom ports', async () => {
  const { normalizeAlbumUrl } = await import('../../../packages/source-erome/src/normalizers.js');
  assert.equal(normalizeAlbumUrl('https://user@www.erome.com/a/AbCd1234'), null);
  assert.equal(normalizeAlbumUrl('https://www.erome.com:8443/a/AbCd1234'), null);
});
