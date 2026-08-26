/**
 * Fetches Mailpit on first use, then runs it.
 *
 * Mailpit is a single binary with no dependencies, so there is nothing to
 * install and nothing to leave behind: it lands in .tools/, which is git
 * ignored, and deleting that directory undoes it completely.
 *
 * The version is pinned rather than tracking the latest release, so everybody
 * runs the same build. Note that the project publishes no checksums, so there
 * is nothing to verify the download against beyond the pinned tag and TLS.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v1.31.0';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_DIR = join(ROOT, '.tools', 'mailpit', VERSION);
const BINARY = join(INSTALL_DIR, process.platform === 'win32' ? 'mailpit.exe' : 'mailpit');

function assetName() {
  const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];

  if (!platform || !arch) {
    throw new Error(
      `Mailpit publishes no build for ${process.platform}/${process.arch}. ` +
        'Install it another way and point SMTP_HOST and SMTP_PORT at it: ' +
        'https://mailpit.axllent.org/docs/install/',
    );
  }

  return platform === 'windows'
    ? `mailpit-windows-${arch}.zip`
    : `mailpit-${platform}-${arch}.tar.gz`;
}

async function install() {
  const asset = assetName();
  const url = `https://github.com/axllent/mailpit/releases/download/${VERSION}/${asset}`;

  process.stderr.write(`Fetching Mailpit ${VERSION} for ${process.platform}/${process.arch}\n`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `Could not download Mailpit: ${response.status} ${response.statusText}\n${url}`,
    );
  }

  mkdirSync(INSTALL_DIR, { recursive: true });
  const archive = join(INSTALL_DIR, asset);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

  // bsdtar reads both .zip and .tar.gz, so one command covers every platform.
  //
  // On Windows it has to be named by full path. Git for Windows puts GNU tar
  // ahead of it on PATH, and GNU tar reads the C: in an absolute path as a
  // remote host name and fails with "Cannot connect to C: resolve failed".
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';

  execFileSync(tar, ['-xf', archive, '-C', INSTALL_DIR], { stdio: 'inherit' });
  rmSync(archive);

  if (process.platform !== 'win32') {
    chmodSync(BINARY, 0o755);
  }
}

if (!existsSync(BINARY)) {
  await install();
}

// Mailpit's defaults are SMTP on 1025 and the web interface on 8025, which is
// what .env.example already points at. Arguments here are passed straight
// through, so `npm run mail -- --help` works.
const mailpit = spawn(BINARY, process.argv.slice(2), { stdio: 'inherit' });
mailpit.on('exit', (code) => process.exit(code ?? 0));
