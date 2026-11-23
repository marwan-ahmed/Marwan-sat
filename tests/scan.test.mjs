// Scanners scoped to the change (charter §9.6): pre-existing debt is reported, not charged to the task.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { advisoriesFromJson, auditLevel, changedManifests, looksLikeFindings, scopeScannerCommand } from '../core/bin/lib/scan.mjs';
import { execPrompt, git, makeProject, phase, read, T, task, verify, write, approvePlanAndStart } from './helpers.mjs';

const BASE = '0123456789abcdef0123456789abcdef01234567';

test('scan: scanner commands are rewritten to look only at the change', () => {
  const g = scopeScannerCommand('secrets', 'gitleaks git --no-banner --redact --exit-code 1', BASE);
  assert.equal(g.command, `gitleaks git --no-banner --redact --exit-code 1 --log-opts=${BASE}..HEAD`);
  assert.ok(g.scoped);
  assert.equal(scopeScannerCommand('secrets', 'gitleaks git --log-opts=-5', BASE).scoped, false, 'an explicit range is kept');
  assert.equal(scopeScannerCommand('secrets', 'gitleaks dir .', BASE).scoped, false, 'a filesystem scan cannot be scoped');

  const s = scopeScannerCommand('sast', 'semgrep scan --config p/default --error', BASE);
  assert.equal(s.command, `semgrep scan --config p/default --error --baseline-commit=${BASE}`);
  assert.ok(s.scoped && s.needsClean);

  const p = scopeScannerCommand('sast', 'my-sast --since {base} --strict', BASE);
  assert.equal(p.command, `my-sast --since ${BASE} --strict`);
  assert.ok(p.scoped && !p.needsClean);

  assert.equal(scopeScannerCommand('sast', 'other-tool .', BASE).scoped, false);
  assert.equal(scopeScannerCommand('secrets', 'gitleaks git', null).command, 'gitleaks git', 'no base: unchanged');
});

test('scan: manifests, audit level and finding detection', () => {
  assert.deepEqual(changedManifests(['src/a.ts', 'package-lock.json', 'apps/web/package.json', 'composer.lock', 'README.md']), ['package-lock.json', 'apps/web/package.json', 'composer.lock']);
  assert.equal(auditLevel('npm audit --audit-level=high'), 'high');
  assert.equal(auditLevel('pnpm audit --audit-level high'), 'high');
  assert.equal(auditLevel('yarn npm audit --severity critical'), 'critical');
  assert.equal(auditLevel('composer audit'), 'low');
  assert.ok(looksLikeFindings('41 vulnerabilities (1 low, 18 moderate, 18 high, 4 critical)'));
  assert.ok(!looksLikeFindings('npm error audit endpoint returned an error'));
});

test('scan: advisories are read from npm, pnpm and composer JSON, above the threshold only', () => {
  const npm = JSON.stringify({
    vulnerabilities: {
      next: { severity: 'critical', via: [{ source: 1, name: 'next', title: 'RCE', url: 'https://github.com/advisories/GHSA-aaaa', severity: 'critical' }, 'postcss'] },
      postcss: { severity: 'moderate', via: [{ source: 2, name: 'postcss', title: 'x', url: 'https://github.com/advisories/GHSA-bbbb', severity: 'moderate' }] },
    },
  });
  const a = advisoriesFromJson('npm', npm, 'high');
  assert.deepEqual([...a.keys()], ['https://github.com/advisories/GHSA-aaaa']);
  assert.equal(advisoriesFromJson('npm', npm, 'low').size, 2);

  const pnpm = JSON.stringify({ advisories: { 7: { id: 7, github_advisory_id: 'GHSA-cccc', severity: 'high', module_name: 'ws', title: 'DoS' } } });
  assert.deepEqual([...advisoriesFromJson('pnpm', pnpm, 'high').keys()], ['GHSA-cccc']);

  const composer = JSON.stringify({ advisories: { 'laravel/framework': [{ advisoryId: 'PKSA-1', packageName: 'laravel/framework', severity: 'medium', title: 't' }], 'a/b': [{ advisoryId: 'PKSA-2', packageName: 'a/b', severity: null, title: 'u' }] } });
  assert.deepEqual([...advisoriesFromJson('composer', composer, 'high').keys()], ['PKSA-2'], 'an advisory without severity counts as high');
  assert.equal(advisoriesFromJson('composer', JSON.stringify({ advisories: [] }), 'low').size, 0);

  assert.equal(advisoriesFromJson('npm', 'not json at all', 'low'), null);
  assert.equal(advisoriesFromJson('npm', JSON.stringify({ error: { code: 'ENOLOCK' } }), 'low'), null);
});

// A project whose dependency audit always reports pre-existing findings (exit 1), like a real legacy project.
function projectWithDebt({ auditOutput = '41 vulnerabilities (1 low, 18 moderate, 18 high, 4 critical)', scope } = {}) {
  const root = makeProject();
  write(root, 'tools/fake-audit.mjs', `console.log(${JSON.stringify(auditOutput)});\nprocess.exit(1);\n`);
  write(root, 'tools/echo-base.mjs', 'console.log(`scanned since ${process.argv[2]}`);\n');
  let y = read(root, '.team/project.yaml');
  y = y.replace(/    dependencies: .*/, '    dependencies: node tools/fake-audit.mjs').replace(/    sast: .*/, '    sast: node tools/echo-base.mjs {base}');
  if (scope) y = y.replace(/  scan_scope: \w+/, `  scan_scope: ${scope}`);
  write(root, '.team/project.yaml', y);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'scanners');
  return root;
}

function lightTask(root, allowed = ['src/a.mjs']) {
  assert.equal(phase(root, 'new', 'small change', '--path', 'light').code, 0);
  write(root, `${T}/REQUEST.md`, 'تعديل صغير\n');
  phase(root, 'next');
  write(root, `${T}/EXEC_PROMPT.md`, execPrompt({ path: 'light' }));
  write(root, `${T}/TASKS.json`, JSON.stringify({ task_id: 'TASK-001', path: 'light', items: [{ id: 'T1', title: 't', acceptance: [], allowed_write: allowed }] }));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'GATE_1');
  approvePlanAndStart(root);
  assert.equal(task(root).phase, 'IMPLEMENT');
}

function lastSummary(root, id = 'TASK-001') {
  const dir = join(root, '.team', 'tasks', id, 'evidence');
  const runs = readdirSync(dir).sort();
  return JSON.parse(read(root, `.team/tasks/${id}/evidence/${runs[runs.length - 1]}/summary.json`));
}

test('verify: pre-existing dependency debt is a warning, not a failure of the task', () => {
  const root = projectWithDebt();
  lightTask(root);
  write(root, 'src/a.mjs', 'export const a = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'change');
  const r = verify(root);
  assert.equal(r.code, 0, r.out);
  const s = lastSummary(root);
  const dep = s.steps.find((x) => x.name === 'dependencies');
  assert.equal(dep.status, 'warn');
  assert.equal(dep.preexisting, true);
  assert.match(dep.reason, /pre-existing/);
  assert.equal(s.scan_scope, 'diff');
  assert.equal(s.base, task(root).base_sha);
  const sast = s.steps.find((x) => x.name === 'sast');
  assert.equal(sast.status, 'pass');
  assert.match(read(root, sast.log), new RegExp(`scanned since ${task(root).base_sha}`), '{base} is substituted');
  // The phase can move on with this evidence.
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'REVIEW');
});

test('verify: an audit that did not complete still fails, even with manifests unchanged', () => {
  const root = projectWithDebt({ auditOutput: 'npm error audit endpoint returned an error' });
  lightTask(root);
  write(root, 'src/a.mjs', 'export const a = 3;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'change');
  const r = verify(root);
  assert.notEqual(r.code, 0);
  assert.match(lastSummary(root).steps.find((x) => x.name === 'dependencies').reason, /did not complete/);
});

test('verify: scan_scope full keeps whole-repository judgement', () => {
  const root = projectWithDebt({ scope: 'full' });
  lightTask(root);
  write(root, 'src/a.mjs', 'export const a = 4;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'change');
  assert.notEqual(verify(root).code, 0);
  assert.equal(lastSummary(root).steps.find((x) => x.name === 'dependencies').status, 'fail');
});

test('verify: a change to dependency manifests is judged, and an unknown audit tool fails closed', () => {
  const root = projectWithDebt();
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'package.json', '{"name":"demo-app","scripts":{"test":"node --test"},"dependencies":{"left-pad":"1.3.0"}}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'add a dependency');
  const r = verify(root);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /dependency manifests changed \(package\.json\)/);
});

test('verify: changes merged in from the base branch are not counted as the task\'s (allowed_write, light path)', () => {
  const root = projectWithDebt();
  lightTask(root);
  write(root, 'src/a.mjs', 'export const a = 5;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'task change');
  // Meanwhile the base branch moves on (for example a SAT update touching sensitive governance paths).
  git(root, 'checkout', '-q', 'main');
  write(root, 'docs/notes.md', '# notes\n');
  write(root, '.github/workflows/other.yml', 'name: other\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'main moves on');
  git(root, 'checkout', '-q', 'sat/TASK-001');
  git(root, 'merge', '-q', '--no-edit', 'main');
  const r = verify(root);
  assert.equal(r.code, 0, r.out);
  const s = lastSummary(root);
  assert.equal(s.checks.find((c) => c.name === 'allowed_write').status, 'pass');
  assert.equal(s.checks.find((c) => c.name === 'light_path_sensitive').status, 'pass');
  assert.notEqual(s.base, task(root).base_sha, 'the base moved to the merge base with main');
});

test('verify: merging origin/main works even when the local main branch is stale', () => {
  const root = projectWithDebt();
  lightTask(root);
  write(root, 'src/a.mjs', 'export const a = 6;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'task change');
  const oldMain = git(root, 'rev-parse', 'main');
  git(root, 'checkout', '-q', 'main');
  write(root, '.github/workflows/other.yml', 'name: other\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'main moves on (merged on GitHub)');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', 'sat/TASK-001');
  git(root, 'branch', '-f', 'main', oldMain); // local main was never pulled
  git(root, 'merge', '-q', '--no-edit', 'origin/main');
  const r = verify(root);
  assert.equal(r.code, 0, r.out);
  assert.equal(lastSummary(root).checks.find((c) => c.name === 'allowed_write').status, 'pass');
});
