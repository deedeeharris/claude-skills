'use strict';

// tests/v2-evidence/replay.sh skeleton (plan section 4, WP7): before the evidence commit exists it must stop at
// the first missing evidence file and name it. The script runs from a copy in a temp tree (scripts/ holding a
// placeholder checker), so this test never touches the real neutral root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { gitEnv } = require('./helpers/git-env.js');

const REPLAY = path.join(__dirname, 'v2-evidence', 'replay.sh');

test('replay.sh fails clearly while the evidence files are missing, and refuses a non-neutral root', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-replay-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evid = path.join(root, 'tests', 'v2-evidence');
  fs.mkdirSync(evid, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'check-completion.js'), 'process.exit(9);\n');
  fs.copyFileSync(REPLAY, path.join(evid, 'replay.sh'));
  const run = () => spawnSync('bash', [path.join(evid, 'replay.sh')], { encoding: 'utf8', env: gitEnv() });

  let r = run();
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /missing evidence file tests\/v2-evidence\/index\.json/);

  fs.writeFileSync(path.join(evid, 'index.json'), JSON.stringify({ root: '/srv/gp-v2', bundle: 'toy-repo.bundle', files: [], replay: {} }));
  r = run();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /missing evidence file tests\/v2-evidence\/toy-repo\.bundle/);

  fs.writeFileSync(path.join(evid, 'toy-repo.bundle'), '');
  fs.writeFileSync(path.join(evid, 'index.json'), JSON.stringify({ root: path.join(root, 'elsewhere'), bundle: 'toy-repo.bundle', files: [], replay: {} }));
  r = run();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not the neutral root \/srv\/gp-v2/);

  fs.writeFileSync(path.join(evid, 'index.json'), JSON.stringify({ root: '/srv/gp-v2', bundle: 'toy-repo.bundle', files: [], replay: { approvals: [] } }));
  r = run();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no replay\.design argument list/);
  assert.ok(!fs.existsSync(path.join(root, 'elsewhere')), 'nothing was created');
});
