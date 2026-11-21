import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentHash } from '../cli/lib/install.mjs';
import { parseFrontmatter } from '../core/bin/lib/yaml.mjs';
import { SAT_ROOT, makeProject, read, satCli, verify, write } from './helpers.mjs';

const ROLES = ['tech-manager', 'request-interpreter', 'architect', 'security-auditor', 'test-author', 'implementer', 'adversarial-reviewer'].map((r) => `marwan-sat-${r}`);

test('init: generates the seven Antigravity agents, rule, skills, hooks and CI', () => {
  const root = makeProject({ stack: 'nextjs' });
  for (const id of ROLES) {
    const { data, body } = parseFrontmatter(read(root, `.agents/agents/${id}.md`));
    assert.equal(data.name, id);
    assert.ok(data.description.length > 40);
    assert.ok(Array.isArray(data.tools) && data.tools.length > 0);
    assert.ok(['pro', 'flash', 'inherit'].includes(data.model));
    assert.ok(body.includes('non-negotiables'), 'common rules appended');
    assert.ok(!body.includes('{{'), 'placeholders resolved');
    if (id === 'marwan-sat-tech-manager') {
      assert.equal(data.mainAgent, true);
      assert.ok(data.tools.includes('invoke_subagent'));
    } else {
      assert.equal(data.subagent, true);
      assert.ok(!data.tools.includes('invoke_subagent'), 'flat hierarchy');
    }
  }
  assert.ok(existsSync(join(root, '.agents/skills/sat-nextjs-conventions/SKILL.md')));
  const sec = read(root, '.agents/skills/sat-security-web/SKILL.md');
  assert.ok(sec.includes('Stack-specific: Next.js'));
  assert.match(read(root, '.agents/rules/marwan-sat.md'), /^---\ntrigger: always_on/);
  assert.ok(JSON.parse(read(root, '.agents/hooks.json'))['marwan-sat-guard']);
  const ci = read(root, '.github/workflows/sat-verify.yml');
  assert.ok(!ci.includes('@@'), 'CI placeholders resolved');
  assert.ok(ci.includes('${{ github.base_ref'));
  assert.match(read(root, '.gitignore'), /\.team\/STATE\.json/);
  const yaml = read(root, '.team/project.yaml');
  assert.match(yaml, /install: npm ci/);
  assert.match(read(root, '.team/LICENSE'), /Copyright \(c\) \d{4} Marwan Ahmed \(مروان أحمد\)/, 'copyright notice installed');
});

test('init refuses to run twice', () => {
  const root = makeProject();
  assert.notEqual(satCli(root, 'init', '--stack', 'custom').code, 0);
});

test('update refuses to overwrite a locally modified managed file, and verify flags it', () => {
  const root = makeProject();
  write(root, '.team/roles/marwan-sat-implementer.md', `${read(root, '.team/roles/marwan-sat-implementer.md')}\nlocal edit\n`);
  const r = satCli(root, 'update');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /\.team\/roles\/marwan-sat-implementer\.md/);
  const v = verify(root);
  assert.notEqual(v.code, 0);
  assert.match(v.out, /managed_files/);
  assert.equal(satCli(root, 'update', '--force').code, 0);
  assert.equal(verify(root).code, 0);
});

test('regenerate keeps the project\'s own hooks', () => {
  const root = makeProject();
  const hooks = JSON.parse(read(root, '.agents/hooks.json'));
  hooks['my-own-hook'] = { enabled: true, PreToolUse: [] };
  write(root, '.agents/hooks.json', JSON.stringify(hooks, null, 2));
  assert.equal(satCli(root, 'regenerate').code, 0);
  const after = JSON.parse(read(root, '.agents/hooks.json'));
  assert.ok(after['my-own-hook'], 'project hook preserved');
  assert.ok(after['marwan-sat-guard'], 'SAT hook present');
  assert.equal(satCli(root, 'update').code, 0, 'own hooks do not count as a local modification');
});

test('presets render for every stack', () => {
  for (const stack of ['nextjs', 'laravel', 'flutter', 'react-native', 'custom']) {
    const root = makeProject({ stack });
    const yaml = readFileSync(join(root, '.team/project.yaml'), 'utf8');
    assert.match(yaml, new RegExp(`stack: ${stack}`));
    const d = satCli(root, 'doctor', '--quick');
    assert.match(d.out, /Verdict:/);
    assert.match(d.out, /✓ guard works on this machine \(live test from the root and from \.agents\//, 'live guard self-test passes');
  }
});

test('cli: "run this next" hints use the command the owner actually has (npx, sat or node)', async () => {
  const { satCommand, githubSpec } = await import('../cli/lib/invoke.mjs');
  assert.equal(githubSpec(SAT_ROOT), 'github:marwan-ahmed/marwan-sat');
  const npxRoot = '/home/u/.npm/_npx/3f2a/node_modules/marwan-sat';
  assert.equal(satCommand(npxRoot, '0.1.1', {}, () => true), 'npx github:marwan-ahmed/marwan-sat#v0.1.1');
  assert.equal(satCommand(SAT_ROOT, '0.1.1', { npm_command: 'exec' }, () => true).startsWith('npx '), true);
  assert.equal(satCommand(SAT_ROOT, '0.1.1', {}, () => true), 'sat');
  assert.match(satCommand(SAT_ROOT, '0.1.1', {}, () => false), /^node ".+sat\.mjs"$/);
  // End to end: the hint printed by the real CLI is exactly the command this machine can run.
  const version = JSON.parse(readFileSync(join(SAT_ROOT, 'package.json'), 'utf8')).version;
  const root = makeProject();
  const again = satCli(root, 'init', '--stack', 'custom');
  assert.notEqual(again.code, 0);
  assert.ok(again.out.includes(`Use: ${satCommand(SAT_ROOT, version)} update`), again.out);
});

test('cli: commit hints name SAT files only, and doctor separates uncommitted SAT files from the owner\'s work', () => {
  const root = makeProject();
  const clean = satCli(root, 'doctor', '--quick');
  assert.match(clean.out, /✓ SAT files are committed/);
  assert.match(clean.out, /✓ no uncommitted project changes/);
  write(root, 'src/feature.mjs', 'export const f = 1;\n');
  write(root, '.agents/rules/extra-note.md', 'x\n');
  const dirty = satCli(root, 'doctor', '--quick');
  assert.match(dirty.out, /! SAT files are committed — 1 uncommitted: git add \.team \.agents/);
  assert.match(dirty.out, /! no uncommitted project changes — 1 files \(e\.g\. src\/feature\.mjs\)/);
  assert.doesNotMatch(dirty.out, /git add -A/);
});

test('update from 0.1.x removes the old unprefixed agent and role files (agents renamed to marwan-sat-*)', () => {
  const root = makeProject();
  const lock = JSON.parse(read(root, '.team/sat.lock'));
  const old = ['tech-manager', 'architect', 'implementer'];
  for (const r of old) {
    const agent = `.agents/agents/${r}.md`;
    const role = `.team/roles/${r}.md`;
    write(root, agent, `---\nname: ${r}\n---\nold\n`);
    write(root, role, `---\nid: ${r}\n---\nold\n`);
    lock.generated[agent] = contentHash(read(root, agent));
    lock.managed[role] = contentHash(read(root, role));
  }
  lock.sat_version = '0.1.3';
  write(root, '.team/sat.lock', `${JSON.stringify(lock, null, 2)}\n`);
  const r = satCli(root, 'update');
  assert.equal(r.code, 0, r.out);
  for (const o of old) {
    assert.ok(!existsSync(join(root, `.agents/agents/${o}.md`)), `old agent ${o} removed`);
    assert.ok(!existsSync(join(root, `.team/roles/${o}.md`)), `old role ${o} removed`);
    assert.ok(existsSync(join(root, `.agents/agents/marwan-sat-${o}.md`)), `new agent ${o} present`);
  }
  assert.match(r.out, /6 removed/);
  assert.match(r.out, /- \.agents\/agents\/tech-manager\.md/);
});

test('the tech manager delegates by the exact agent names it can invoke', () => {
  const root = makeProject();
  const tm = read(root, '.agents/agents/marwan-sat-tech-manager.md');
  for (const r of ROLES.filter((x) => x !== 'marwan-sat-tech-manager')) {
    assert.ok(existsSync(join(root, `.agents/agents/${r}.md`)), `${r} exists`);
    assert.ok(tm.includes(`\`${r}\``), `tech manager names ${r}`);
  }
  assert.ok(!/`(request-interpreter|architect|security-auditor|test-author|implementer|adversarial-reviewer)`/.test(tm), 'no unprefixed agent names left');
  assert.match(read(root, '.agents/rules/marwan-sat.md'), /`marwan-sat-tech-manager`/);
});
