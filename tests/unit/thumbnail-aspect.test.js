import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THUMBNAIL_FILTER } from '../../packages/media-tools/src/thumbnail-generator.js';

test('thumbnails fit a 320x320 box, keep the aspect ratio and never upscale', () => {
  assert.match(THUMBNAIL_FILTER, /force_original_aspect_ratio=decrease/u);
  assert.match(THUMBNAIL_FILTER, /w=min\(320\\,iw\)/u);
  assert.match(THUMBNAIL_FILTER, /h=min\(320\\,ih\)/u);
  assert.match(THUMBNAIL_FILTER, /force_divisible_by=2/u);
});

test('the catalog never crops thumbnails and gives vertical videos a portrait box', () => {
  const css = readFileSync(new URL('../../apps/web/public/assets/css/app.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../../apps/web/public/assets/js/app.js', import.meta.url), 'utf8');
  assert.match(css, /\.video-thumbnail img \{[^}]*object-fit: contain/u);
  assert.doesNotMatch(css, /\.video-thumbnail img \{[^}]*object-fit: cover/u);
  assert.match(css, /\.video-thumbnail\.is-portrait \{[^}]*aspect-ratio: 3 \/ 4/u);
  assert.match(js, /naturalHeight > image\.naturalWidth/u);
  assert.match(js, /classList\.add\('is-portrait'\)/u);
});
