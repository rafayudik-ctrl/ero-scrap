import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MegaCmdStorageProvider } from '../../packages/storage-mega/src/index.js';
import { CopyAuthorizationError } from '../../packages/config/src/security.js';

const ASSET_ID = 'a'.repeat(32);

function missingFileError() {
  return Object.assign(new Error('MEGA command failed.'), {
    code: 'mega_command_failed',
    stdout: '',
    stderr: 'No such file or folder',
  });
}

async function withVideoFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ero-scrap-mega-test-'));
  const path = join(directory, 'authorized-sample.mp4');
  await writeFile(path, Buffer.from('test-video-bytes'));
  try { await run(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('MEGA connection check is read-only and does not require the copy gate', async () => {
  const commands = [];
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return { stdout: 'account', stderr: '', exitCode: 0 };
    },
  });
  assert.deepEqual(await provider.checkConnection(), { connected: true });
  assert.deepEqual(commands, [{ command: 'whoami', args: [] }]);
});

test('MEGA upload is blocked before local file inspection or any command by default', async () => {
  let commandCount = 0;
  const provider = new MegaCmdStorageProvider({ runCommand: async () => { commandCount += 1; } });
  await assert.rejects(provider.uploadLocalFile({ assetId: ASSET_ID, localPath: '/not-read.mp4' }), CopyAuthorizationError);
  assert.equal(commandCount, 0);
});

test('MEGA upload uses an exact per-video folder and verifies the exported URL', async () => {
  await withVideoFile(async (localPath) => {
    const commands = [];
    const provider = new MegaCmdStorageProvider({
      authorizeCopy: () => {},
      now: () => new Date('2026-11-01T00:00:00.000Z'),
      runCommand: async (command, args) => {
        commands.push({ command, args });
        if (command === 'ls' && args[1] && commands.filter((entry) => entry.command === 'ls').length === 1) {
          throw missingFileError();
        }
        if (command === 'export') {
          return { stdout: 'Exported link: https://mega.nz/file/AbCdEf#secretKey', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await provider.uploadLocalFile({ assetId: ASSET_ID, localPath });
    assert.equal(result.provider, 'mega');
    assert.equal(result.objectId, `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4`);
    assert.equal(result.shareUrl, 'https://mega.nz/file/AbCdEf#secretKey');
    assert.equal(result.uploadedAt, '2026-11-01T00:00:00.000Z');
    assert.equal(result.verified, true);
    assert.deepEqual(commands.map(({ command }) => command), ['ls', 'mkdir', 'put', 'ls', 'export']);
    assert.deepEqual(commands[2].args, [localPath, `/Ero-Scrap/${ASSET_ID}`]);
  });
});


test('MEGA upload compensates an object when export verification fails after upload', async () => {
  await withVideoFile(async (localPath) => {
    const commands = [];
    let lsCount = 0;
    const provider = new MegaCmdStorageProvider({
      authorizeCopy: () => {},
      runCommand: async (command, args) => {
        commands.push({ command, args });
        if (command === 'ls') {
          lsCount += 1;
          if (lsCount === 1) throw missingFileError();
          return { stdout: 'remote object exists', stderr: '', exitCode: 0 };
        }
        if (command === 'export' && args[0] === '-a') {
          return { stdout: 'unexpected output', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    await assert.rejects(provider.uploadLocalFile({ assetId: ASSET_ID, localPath }), (error) => {
      assert.equal(error.code, 'mega_share_url_missing');
      assert.equal(error.cleanupError, undefined);
      return true;
    });
    assert.deepEqual(commands.map(({ command, args }) => [command, args?.[0]]), [
      ['ls', '--show-handles'],
      ['mkdir', '-p'],
      ['put', localPath],
      ['ls', '--show-handles'],
      ['export', '-a'],
      ['ls', '--show-handles'],
      ['export', '-d'],
      ['rm', '-f'],
    ]);
  });
});

test('MEGA upload reuses and re-exports an existing object after an interrupted D1 acknowledgement', async () => {
  await withVideoFile(async (localPath) => {
    const commands = [];
    const provider = new MegaCmdStorageProvider({
      authorizeCopy: () => {},
      now: () => new Date('2026-11-01T00:00:00.000Z'),
      runCommand: async (command, args) => {
        commands.push({ command, args });
        if (command === 'export') return { stdout: 'Exported link: https://mega.nz/file/AbCdEf#secretKey', stderr: '', exitCode: 0 };
        return { stdout: 'existing file handle', stderr: '', exitCode: 0 };
      },
    });
    const result = await provider.uploadLocalFile({ assetId: ASSET_ID, localPath });
    assert.equal(result.reusedExisting, true);
    assert.equal(result.shareUrl, 'https://mega.nz/file/AbCdEf#secretKey');
    assert.deepEqual(commands.map(({ command }) => command), ['ls', 'export']);
  });
});

test('MEGA deletion refuses paths outside the asset folder without running commands', async () => {
  let commandCount = 0;
  const provider = new MegaCmdStorageProvider({ runCommand: async () => { commandCount += 1; } });
  await assert.rejects(provider.deleteObject({
    assetId: ASSET_ID,
    objectId: `/Ero-Scrap/${'b'.repeat(32)}/other.mp4`,
  }), (error) => error.code === 'unsafe_remote_path');
  assert.equal(commandCount, 0);
});

test('MEGA deletion treats a confirmed absent file as already deleted', async () => {
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command) => {
      assert.equal(command, 'ls');
      throw missingFileError();
    },
  });
  assert.deepEqual(await provider.deleteObject({
    assetId: ASSET_ID,
    objectId: `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4`,
  }), {
    deleted: true,
    alreadyAbsent: true,
    objectId: `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4`,
  });
});

test('MEGA deletion revokes sharing best-effort and removes only the exact file', async () => {
  const commands = [];
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === 'export') throw Object.assign(new Error('not shared'), { code: 'mega_command_failed' });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const result = await provider.deleteObject({
    assetId: ASSET_ID,
    objectId: `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4`,
  });
  assert.equal(result.deleted, true);
  assert.equal(result.alreadyAbsent, false);
  assert.deepEqual(commands.map(({ command }) => command), ['ls', 'export', 'rm']);
  assert.deepEqual(commands[2].args, ['-f', `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4`]);
});

test('MEGAcmd wording "Couldn\'t find" counts as a missing file, so the first upload proceeds', async () => {
  await withVideoFile(async (localPath) => {
    const commands = [];
    const provider = new MegaCmdStorageProvider({
      authorizeCopy: () => {},
      runCommand: async (command, args) => {
        commands.push(command);
        if (command === 'ls' && commands.filter((name) => name === 'ls').length === 1) {
          throw Object.assign(new Error('failed'), { code: 'mega_command_failed', stderr: "[err: 2026] Couldn't find /Ero-Scrap/x/authorized-sample.mp4" });
        }
        if (command === 'export') return { stdout: 'Exported link: https://mega.nz/file/AbCdEf#secretKey', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const result = await provider.uploadLocalFile({ assetId: ASSET_ID, localPath });
    assert.equal(result.reusedExisting, false);
    assert.deepEqual(commands.slice(0, 3), ['ls', 'mkdir', 'put']);
  });
});

test('an authentication failure is never mistaken for a missing file', async () => {
  await withVideoFile(async (localPath) => {
    const provider = new MegaCmdStorageProvider({
      authorizeCopy: () => {},
      runCommand: async () => { throw Object.assign(new Error('failed'), { code: 'mega_command_failed', stderr: 'Not logged in.' }); },
    });
    await assert.rejects(provider.uploadLocalFile({ assetId: ASSET_ID, localPath }), /failed/);
  });
});

test('a hung quick MEGAcmd step times out on its own short limit while put keeps the long one', async () => {
  const { createMegaCommandRunner } = await import('../../packages/storage-mega/src/command-runner.js');
  const { EventEmitter } = await import('node:events');
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => child.emit('close', null));
    return child; // never finishes by itself
  };
  const run = createMegaCommandRunner({ platform: 'linux', spawnImpl: fakeSpawn, timeoutMs: 5_000, commandTimeoutsMs: { export: 30, put: 5_000 } });
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 1_000); // the runner's own timer is unref'd
  try {
    await assert.rejects(run('export', ['-a', '-f', '/x']), (error) => error.code === 'mega_timeout' && error.command === 'export');
  } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - started < 2_000, 'did not wait for the long limit');
});
