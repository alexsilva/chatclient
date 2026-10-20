const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { reserveInstanceState, preferredInstance } = require('../instance-state');

test('instance slots have independent settings and ports', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chatclient-instances-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = reserveInstanceState(root);
  const second = reserveInstanceState(root);
  const third = reserveInstanceState(root);
  assert.deepEqual([first.slot, second.slot, third.slot], [0, 1, 2]);
  assert.deepEqual([first.defaultPort, second.defaultPort, third.defaultPort], [8787, 8788, 8789]);
  assert.equal(new Set([first.statePath, second.statePath, third.statePath]).size, 3);
  assert.equal(first.legacyPath, second.legacyPath);
  assert.equal(statSync(join(root, '.chatclient-instances', 'slot-0')).mode & 0o077, 0);
  for (const lease of [first, second, third]) { lease.release(); }
  const reused = reserveInstanceState(root);
  assert.equal(reused.slot, 0);
  reused.release();
});

test('explicit busy instance never reuses another window config', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chatclient-slot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lease = reserveInstanceState(root, { slot: 3 });
  assert.equal(lease.defaultPort, 8790);
  assert.throws(() => reserveInstanceState(root, { slot: 3 }), /Nenhuma/);
  lease.release();
  const recovered = reserveInstanceState(root, { slot: 3 });
  assert.equal(recovered.slot, 3);
  recovered.release();
});

test('stale lease is reclaimed and old release cannot delete new owner', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chatclient-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = reserveInstanceState(root, { pid: 12345, slot: 1 });
  const recovered = reserveInstanceState(root, { slot: 1, isAlive: () => false });
  assert.equal(recovered.slot, 1);
  old.release();
  assert.equal(JSON.parse(readFileSync(join(root, '.chatclient-instances/slot-1/owner.json'))).pid, process.pid);
  recovered.release();
});

test('instance cli option accepts one numeric slot', () => {
  assert.equal(preferredInstance(['app']), null);
  assert.equal(preferredInstance(['app', '--chatclient-instance=7']), 7);
  for (const slot of ['-1', '8', 'abc']) {
    assert.throws(() => preferredInstance(['app', '--chatclient-instance=' + slot]));
  }
  assert.throws(() => preferredInstance(['--chatclient-instance=0', '--chatclient-instance=0']));
});
