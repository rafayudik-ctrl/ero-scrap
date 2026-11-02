import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FfprobeMediaInspector } from '../../packages/media-tools/src/media-inspector.js';

function createSpawnWithJson(payload, commands) {
  return (binary, args, options) => {
    commands.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify(payload));
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
}

async function withVideo(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-probe-'));
  const localPath = join(directory, 'sample.mp4');
  await writeFile(localPath, Buffer.from('fixture-video'));
  try { await run(localPath); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('FFprobe inspector obtains duration from local metadata without trusting CLI input', async () => {
  await withVideo(async (localPath) => {
    const commands = [];
    const inspector = new FfprobeMediaInspector({
      spawnImpl: createSpawnWithJson({
        format: { duration: '599.750' },
        streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
      }, commands),
    });
    assert.deepEqual(await inspector.inspect({ localPath }), {
      durationMs: 599_750,
      sizeBytes: Buffer.byteLength('fixture-video'),
      hasVideoStream: true,
    });
    assert.equal(commands[0].binary, 'ffprobe');
    assert.equal(commands[0].options.shell, false);
    assert.equal(commands[0].args.at(-1), localPath);
  });
});

test('FFprobe inspector rejects files without a video stream or confirmed duration', async () => {
  await withVideo(async (localPath) => {
    const inspector = new FfprobeMediaInspector({
      spawnImpl: createSpawnWithJson({ format: { duration: '120' }, streams: [{ codec_type: 'audio' }] }, []),
    });
    await assert.rejects(inspector.inspect({ localPath }), (error) => error.code === 'media_metadata_incomplete');
  });
});

test('FFprobe inspector rejects malformed metadata instead of guessing a duration', async () => {
  await withVideo(async (localPath) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const inspector = new FfprobeMediaInspector({
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.end('{broken');
          child.emit('close', 0);
        });
        return child;
      },
    });
    await assert.rejects(inspector.inspect({ localPath }), (error) => error.code === 'ffprobe_invalid_json');
  });
});
