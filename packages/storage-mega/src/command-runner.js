import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const POWERSHELL_BRIDGE = resolve(PROJECT_ROOT, 'scripts/mega-command.ps1');

export class MegaCommandError extends Error {
  constructor(command, { exitCode = null, code = 'mega_command_failed', cause, stdout = '', stderr = '' } = {}) {
    // Keep process output available for narrowly-scoped error classification,
    // but never interpolate it into the public message or routine logs.
    super(`MEGAcmd command failed (${command}; ${code}).`, { cause });
    this.name = 'MegaCommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.code = code;
    this.stdout = String(stdout).slice(0, 8_192);
    this.stderr = String(stderr).slice(0, 8_192);
  }
}

function validateCommandName(command) {
  if (typeof command !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/u.test(command)) {
    throw new TypeError('Invalid MEGAcmd command name.');
  }
  return command;
}

/**
 * Execute MEGAcmd without a shell on POSIX systems. On Windows, invoke the
 * installed .bat wrappers through a fixed PowerShell bridge that forwards an
 * argument array (never a constructed shell command string).
 */
export function createMegaCommandRunner({
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  powershellBridge = POWERSHELL_BRIDGE,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new RangeError('MEGA command timeout must be between 1 second and 15 minutes.');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 4_096 || maxOutputBytes > 2 * 1024 * 1024) {
    throw new RangeError('MEGA output limit must be between 4 KiB and 2 MiB.');
  }

  return function runMegaCommand(rawCommand, args = []) {
    const command = validateCommandName(rawCommand);
    if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new TypeError('MEGA command arguments must be a bounded array of strings.');
    }

    const executable = `mega-${command}`;
    const file = platform === 'win32' ? 'powershell.exe' : executable;
    const argv = platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', powershellBridge, executable, ...args]
      : args;

    return new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawnImpl(file, argv, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (error) {
        rejectPromise(new MegaCommandError(command, { code: 'mega_spawn_failed', cause: error }));
        return;
      }

      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let oversized = false;

      const settleError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      };

      const collect = (target) => (chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          oversized = true;
          child.kill('SIGKILL');
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (error) => settleError(new MegaCommandError(command, {
        code: 'mega_spawn_failed', cause: error,
      })));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();

      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          rejectPromise(new MegaCommandError(command, { exitCode, code: 'mega_timeout' }));
          return;
        }
        if (oversized) {
          rejectPromise(new MegaCommandError(command, { exitCode, code: 'mega_output_limit' }));
          return;
        }
        const output = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        };
        if (output.exitCode !== 0) {
          rejectPromise(new MegaCommandError(command, {
            exitCode: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr,
          }));
          return;
        }
        resolvePromise(output);
      });
    });
  };
}
