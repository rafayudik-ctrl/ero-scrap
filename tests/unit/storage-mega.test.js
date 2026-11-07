import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MegaCmdStorageProvider } from '../../packages/storage-mega/src/index.js';
import { CopyAuthorizationError, COPY_AUTHORIZED } from '../../packages/config/src/security.js';

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

test('MEGA upload is blocked before local file inspection or any command by default', { skip: COPY_AUTHORIZED }, async () => {
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
      // Folder listed, saw (fake) content, so it is left alone.
      ['ls', `/Ero-Scrap/${ASSET_ID}`],
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
    folderRemoved: false,
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
  assert.equal(result.folderRemoved, true);
  assert.deepEqual(commands.map(({ command }) => command), ['ls', 'export', 'rm', 'ls', 'rm']);
  assert.deepEqual(commands[2].args, ['-f', `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4`]);
  // Then the now-empty per-asset folder (exact validated path) is removed.
  assert.deepEqual(commands[3].args, [`/Ero-Scrap/${ASSET_ID}`]);
  assert.deepEqual(commands[4].args, ['-r', '-f', `/Ero-Scrap/${ASSET_ID}`]);
});

test('MEGA deletion keeps the asset folder when it still holds something', async () => {
  const commands = [];
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === 'ls' && args[0] === `/Ero-Scrap/${ASSET_ID}`) return { stdout: 'other.mp4\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const result = await provider.deleteObject({ assetId: ASSET_ID, objectId: `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4` });
  assert.equal(result.deleted, true);
  assert.equal(result.folderRemoved, false);
  assert.equal(commands.filter(({ command }) => command === 'rm').length, 1);
});

test('MEGA deletion still succeeds when the empty folder cannot be removed', async () => {
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command, args) => {
      if (command === 'rm' && args[0] === '-r') throw new Error('boom');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const result = await provider.deleteObject({ assetId: ASSET_ID, objectId: `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4` });
  assert.deepEqual([result.deleted, result.folderRemoved], [true, false]);
});

test('MEGA deletion of an already absent file still tidies a leftover empty folder', async () => {
  const commands = [];
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === 'ls' && args[0] === '--show-handles') throw missingFileError();
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const result = await provider.deleteObject({ assetId: ASSET_ID, objectId: `/Ero-Scrap/${ASSET_ID}/authorized-sample.mp4` });
  assert.deepEqual([result.alreadyAbsent, result.folderRemoved], [true, true]);
  assert.deepEqual(commands.at(-1).args, ['-r', '-f', `/Ero-Scrap/${ASSET_ID}`]);
});

test('empty-folder sweep inspects a bounded random sample and only touches asset-ID-shaped names', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => index.toString(16).padStart(32, '0'));
  const commands = [];
  const provider = new MegaCmdStorageProvider({
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === 'ls' && args[0] === '/Ero-Scrap') {
        return { stdout: `${ids.join('\n')}\nnot-an-asset\n../escape\n`, stderr: '', exitCode: 0 };
      }
      // Odd folders still hold a file; even ones are empty.
      if (command === 'ls') return { stdout: Number.parseInt(args[0].slice(-2), 16) % 2 ? 'x.mp4\n' : '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const result = await provider.pruneEmptyFolders({ maxChecks: 8, random: () => 0 });
  assert.equal(result.listed, 30);
  assert.equal(result.checked, 8);
  assert.ok(result.removed > 0 && result.removed <= 8);
  const removals = commands.filter(({ command }) => command === 'rm');
  assert.equal(removals.length, result.removed);
  for (const { args } of removals) {
    assert.equal(args[0], '-r');
    assert.match(args[2], /^\/Ero-Scrap\/[a-f0-9]{32}$/u);
  }
  // 1 root listing + 8 folder listings + removals; never more than the budget.
  assert.equal(commands.filter(({ command }) => command === 'ls').length, 9);
});

test('empty-folder sweep with maxChecks 0 runs no command and rejects bad budgets', async () => {
  let count = 0;
  const provider = new MegaCmdStorageProvider({ runCommand: async () => { count += 1; return { stdout: '' }; } });
  assert.deepEqual(await provider.pruneEmptyFolders({ maxChecks: 0 }), { listed: 0, checked: 0, removed: 0 });
  assert.equal(count, 0);
  await assert.rejects(provider.pruneEmptyFolders({ maxChecks: 501 }), RangeError);
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
