import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSearchKeyword } from '../../packages/config/src/keyword-file.js';

async function withKeywordFile(contents, run) {
  const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-keyword-'));
  const filePath = join(directory, 'search-keyword.txt');
  try {
    await writeFile(filePath, contents, 'utf8');
    await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('keyword file reads one phrase, trims it and tolerates a UTF-8 BOM', async () => {
  await withKeywordFile('\uFEFF  Example Phrase  \n', async (filePath) => {
    assert.equal(await loadSearchKeyword(filePath), 'Example Phrase');
  });
});

test('empty keyword file safely disables scans', async () => {
  await withKeywordFile('\n  \t\n', async (filePath) => {
    assert.equal(await loadSearchKeyword(filePath), null);
  });
});

test('keyword file rejects multiple lines and oversized terms', async () => {
  await withKeywordFile('first\nsecond', async (filePath) => {
    await assert.rejects(loadSearchKeyword(filePath), /exactly one line/);
    await writeFile(filePath, 'x'.repeat(81), 'utf8');
    await assert.rejects(loadSearchKeyword(filePath), /80 characters or fewer/);
  });
});

test('keyword changes are picked up by reading the same file again', async () => {
  await withKeywordFile('alpha', async (filePath) => {
    assert.equal(await loadSearchKeyword(filePath), 'alpha');
    await writeFile(filePath, 'beta', 'utf8');
    assert.equal(await loadSearchKeyword(filePath), 'beta');
  });
});

test('SEARCH_KEYWORD secret takes precedence over the file; empty secret falls back to it', async () => {
  await withKeywordFile('from-file', async (filePath) => {
    assert.equal(await loadSearchKeyword(filePath, { SEARCH_KEYWORD: '  from-secret ' }), 'from-secret');
    assert.equal(await loadSearchKeyword(filePath, { SEARCH_KEYWORD: '   ' }), 'from-file');
    assert.equal(await loadSearchKeyword(filePath, {}), 'from-file');
    await assert.rejects(loadSearchKeyword(filePath, { SEARCH_KEYWORD: 'a\nb' }), /exactly one line/);
  });
});
