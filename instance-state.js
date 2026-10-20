'use strict';
// Each Electron process receives its own UI/API configuration while keeping
// the same Chromium userData directory and authenticated browser session.
const { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_INSTANCES = 8;
const FIRST_API_PORT = 8787;
const OWNER_FILE = 'owner.json';

function preferredInstance(argv = process.argv) {
  const args = argv.filter((arg) => arg.startsWith('--chatclient-instance='));
  if (!args.length) { return null; }
  const slot = args[0].slice('--chatclient-instance='.length);
  if (args.length !== 1 || !/^[0-7]$/.test(slot)) {
    throw new Error('Use --chatclient-instance=0..7, sem duplicar a opção.');
  }
  return Number(slot);
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Atomic mkdir grants a slot to exactly one live process. Stale leases left
// after SIGKILL are reclaimed on the next start. An initializing process is
// not stolen just because it has not yet written its owner.json.
function reserveInstanceState(userData, {
  pid = process.pid, slot = null, isAlive = alive
} = {}) {
  const base = join(userData, '.chatclient-instances');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const slots = slot === null ? Array.from({ length: MAX_INSTANCES }, (_, index) => index) : [slot];
  for (const index of slots) {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_INSTANCES) {
      throw new Error('Invalid ChatClient instance slot');
    }
    const dir = join(base, 'slot-' + index);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') { throw error; }
        let owner = null;
        try { owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')); } catch {}
        if (owner && isAlive(owner.pid)) { break; }
        // Another process may be between mkdir and writeFile.
        if (!owner) {
          try {
            if (Date.now() - statSync(dir).mtimeMs < 15000) { break; }
          } catch { continue; }
        }
        const stale = join(base, 'stale-' + randomUUID());
        try {
          renameSync(dir, stale);
          rmSync(stale, { recursive: true, force: true });
        } catch (renameError) {
          if (renameError.code !== 'ENOENT') { throw renameError; }
        }
        continue;
      }
      const token = randomUUID();
      try {
        writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid, token }), {
          flag: 'wx', mode: 0o600
        });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      return {
        slot: index,
        defaultPort: FIRST_API_PORT + index,
        statePath: join(userData, 'session-state.instance-' + index + '.json'),
        legacyPath: join(userData, 'session-state.json'),
        release() {
          try {
            const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8'));
            if (owner.pid === pid && owner.token === token) {
              rmSync(dir, { recursive: true, force: true });
            }
          } catch { /* Already released or ownership changed. */ }
        }
      };
    }
  }
  throw new Error('Nenhuma instância livre do ChatClient (máximo de oito).');
}

module.exports = { reserveInstanceState, preferredInstance, MAX_INSTANCES, FIRST_API_PORT };
