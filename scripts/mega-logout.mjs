import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

for (const command of ['mega-logout', 'mega-quit']) {
  try {
    await execFile(command, [], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
  } catch {
    // The GitHub-hosted runner is destroyed after the job. Cleanup is best effort.
  }
}
console.info('[ero-scrap] MEGA CLI cleanup finished.');
