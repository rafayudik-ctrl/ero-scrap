import { createHmac } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value) {
  const normalized = value.toUpperCase().replace(/[\s=-]/gu, '');
  if (!normalized || !/^[A-Z2-7]+$/u.test(normalized)) {
    throw new Error('MEGA_TOTP_SECRET must be a valid Base32 secret.');
  }
  let bits = '';
  for (const character of normalized) {
    bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function createTotp(secret, now = Date.now()) {
  const key = decodeBase32(secret);
  const counter = BigInt(Math.floor(now / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function runMega(command, args = []) {
  try {
    await execFile(`mega-${command}`, args, {
      timeout: 45_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
    });
  } catch {
    // Never surface MEGAcmd output: it can contain account details or links.
    throw new Error(`MEGAcmd ${command} failed. Check the GitHub secret configuration.`);
  }
}

const email = String(process.env.MEGA_EMAIL ?? '').trim();
const password = String(process.env.MEGA_PASSWORD ?? '');
const totpSecret = String(process.env.MEGA_TOTP_SECRET ?? '').trim();

if (!email || email.length > 254 || !email.includes('@') || !password || password.length > 1_024) {
  throw new Error('MEGA_EMAIL and MEGA_PASSWORD must be configured as GitHub Actions secrets.');
}

const args = [];
if (totpSecret) args.push(`--auth-code=${createTotp(totpSecret)}`);
args.push(email, password);

await runMega('login', args);
await runMega('whoami');
console.info('[ero-scrap] MEGA session authenticated for this ephemeral job.');
