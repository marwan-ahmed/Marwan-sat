import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFrontmatter } from '../core/bin/lib/yaml.mjs';
import { makeProject, read, satCli, verify, write } from './helpers.mjs';

const ROLES = ['tech-manager', 'request-interpreter', 'architect', 'security-auditor', 'test-author', 'implementer', 'adversarial-reviewer'];

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
    if (id === 'tech-manager') {
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
  write(root, '.team/roles/implementer.md', `${read(root, '.team/roles/implementer.md')}\nlocal edit\n`);
  const r = satCli(root, 'update');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /\.team\/roles\/implementer\.md/);
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
    assert.match(d.out, /الحكم/);
    assert.match(d.out, /✓ guard يعمل على هذا الجهاز/, 'live guard self-test passes');
  }
});
