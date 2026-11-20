// Run after pnpm build with @opencode/cli@2.3.2 on PATH.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'quiver-opencode-')));
const cwd = join(root, 'project');
const catalog = join(root, 'catalog');
const marker = join(root, 'discovered');
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_RUNTIME_DIR: join(root, 'runtime'), CI: '1', QUIVER_NO_UPDATE_NOTIFIER: '1' };
function run(cmd, ...args) {
  return execFileSync(cmd, args, { env, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' });
}
try {
  mkdirSync(cwd);
  mkdirSync(env.HOME);
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  mkdirSync(join(catalog, 'plugins'), { recursive: true });
  writeFileSync(join(catalog, 'plugins/probe.js'), `import { writeFileSync } from 'node:fs';\nexport default { id: 'probe', async setup() { writeFileSync(${JSON.stringify(marker)}, 'discovered'); } };`);
  writeFileSync(join(catalog, 'config.json'), JSON.stringify({
    mcpServers: { fixture: { transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./fixture-mcp.mjs', import.meta.url))] } },
    plugins: { probe: { provider: 'opencode', sourcePath: 'plugins/probe.js' } }, tui: { theme: 'smoke' },
  }));
  assert.match(run('opencode', '--version').trim(), /\bv?2\.3\.2$/);
  const cli = fileURLToPath(new URL('../../bin/quiver-cli.mjs', import.meta.url));
  run(process.execPath, cli, 'init', '--all', '--providers=opencode', `--catalog=local:${catalog}`);
  const sync = spawnSync(process.execPath, [cli, 'sync'], { env, cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stderr, /V2 uses global CLI settings/);
  assert.ok(!existsSync(join(env.XDG_CONFIG_HOME, 'opencode/cli.json')));
  assert.equal(JSON.parse(readFileSync(join(cwd, '.opencode/tui.json'))).theme, 'smoke');
  const path = `/api/mcp?${new URLSearchParams({ 'location[directory]': cwd })}`;
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  run('opencode', 'service', 'set', 'port', String(port));
  try {
    let response;
    for (let i = 0; i < 10; ++i) {
      response = JSON.parse(run('opencode', 'api', 'get', path));
      assert.equal(response.location.directory, cwd);
      if (existsSync(marker) && response.data.some(s => s.name === 'fixture' && s.status.status === 'connected')) break;
      await setTimeout(200);
    }
    assert.ok(response.data.some(s => s.name === 'fixture' && s.status.status === 'connected'), JSON.stringify(response));
    assert.equal(readFileSync(marker, 'utf8'), 'discovered');
  } finally {
    run('opencode', 'service', 'stop');
  }
  const configPath = join(cwd, '.agents/config.json');
  const config = JSON.parse(readFileSync(configPath));
  delete config.tui;
  writeFileSync(configPath, JSON.stringify(config));
  run(process.execPath, cli, 'sync');
  const tui = join(cwd, '.opencode/tui.json');
  assert.ok(!existsSync(tui) && !existsSync(join(cwd, '.opencode/.quiver-tui')));
  writeFileSync(tui, '{"theme":"mine"}');
  run(process.execPath, cli, 'sync');
  assert.equal(readFileSync(tui, 'utf8'), '{"theme":"mine"}');
  console.log('OpenCode 2.3.2 recognized the generated MCP config and imported the linked plugin.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
