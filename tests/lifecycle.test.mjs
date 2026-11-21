import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { execPrompt, git, guard, implementCorrectly, makeProject, phase, read, report, sh, T, task, toImplement, verify, write } from './helpers.mjs';

test('full path: from request to closed, with a fix cycle', () => {
  const root = makeProject();
  toImplement(root);
  assert.equal(task(root).phase, 'IMPLEMENT');
  assert.ok(task(root).frozen_sha, 'tests were frozen by a commit');

  // Gate cannot be skipped without a passing verify on a clean commit.
  assert.notEqual(phase(root, 'next').code, 0);
  implementCorrectly(root);
  assert.equal(verify(root).code, 0);
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'REVIEW');

  // A confirmed high finding forces FIX and archives the review.
  write(root, `${T}/REVIEW.json`, JSON.stringify({ verdict: 'BLOCKED', findings: [{ id: 'REV-01', lens: 'logic', severity: 'high', proof: 'confirmed', location: 'src/late.mjs:1', scenario: 's', evidence: 'e', fix: 'f' }] }));
  write(root, `${T}/SECURITY_AUDIT.json`, JSON.stringify({ profile: 'web', verdict: 'CLEAR_WITHIN_SCOPE', coverage: [{ axis: 'access_control', status: 'NOT_APPLICABLE', reason: 'no entry point' }], findings: [] }));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'FIX');
  assert.ok(existsSync(join(root, T, 'REVIEW.c1.json')));

  git(root, 'commit', '--allow-empty', '-qm', 'fix');
  assert.equal(verify(root).code, 0, 'tool-archived files do not break allowed_write');
  assert.equal(phase(root, 'next').code, 0);
  write(root, `${T}/REVIEW.json`, JSON.stringify({ verdict: 'CLEAR_WITHIN_SCOPE', findings: [] }));
  write(root, `${T}/SECURITY_AUDIT.json`, JSON.stringify({ profile: 'web', verdict: 'CLEAR_WITHIN_SCOPE', coverage: [{ axis: 'access_control', status: 'NOT_APPLICABLE', reason: 'no entry point' }], findings: [] }));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'REPORT');

  assert.equal(report(root).code, 0);
  assert.notEqual(phase(root, 'next').code, 0, 'risk section must be written first');
  let rep = read(root, `${T}/REPORT.md`);
  write(root, `${T}/REPORT.md`, rep.replace('## 3. ما تغيّر', '## 3. ما تغيّر (معدّل)'));
  assert.notEqual(phase(root, 'next').code, 0, 'generated sections are hash-locked');
  rep = rep.replace(/(<!-- sat:tm-risk:begin -->)[\s\S]*?(<!-- sat:tm-risk:end -->)/, '$1\nالمخاطرة المتبقية منخفضة ومحصورة في دالة صافية.\n$2');
  write(root, `${T}/REPORT.md`, rep);
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(phase(root, 'approve', 'GATE_2', '--decision', 'approve', '--note', 'اعتمدت').code, 0);
  assert.equal(task(root).phase, 'CLOSED');

  // The next task must not start from the previous task's branch, and never reuses its id
  // (here the base branch has no TASK-001 folder, as after a cancelled, never-merged task).
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'task files');
  const base = task(root).base_ref;
  const again = phase(root, 'new', 'مهمة ثانية');
  assert.notEqual(again.code, 0);
  assert.match(again.out, /previous task's branch/);
  git(root, 'checkout', '-q', base);
  assert.equal(phase(root, 'new', 'مهمة ثانية').code, 0);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'sat/TASK-002');
});

test('gates: GATE_0 needs the owner answers; GATE_1 needs a valid TASKS.json', () => {
  const root = makeProject();
  phase(root, 'new', 'x');
  write(root, `${T}/REQUEST.md`, 'طلب\n');
  phase(root, 'next');
  write(root, `${T}/EXEC_PROMPT.md`, execPrompt({ blocking: 1 }));
  phase(root, 'next');
  assert.equal(task(root).phase, 'GATE_0');
  assert.notEqual(phase(root, 'approve', 'GATE_0', '--note', 'نعم').code, 0);
  write(root, `${T}/ANSWERS.md`, 'لا توجد فترة سماح\n');
  assert.equal(phase(root, 'approve', 'GATE_0', '--note', 'لا توجد فترة سماح').code, 0);
  assert.equal(task(root).phase, 'INTERPRET');
  assert.equal(task(root).interpret_round, 2);
  // Still blocking after the last allowed round → escalation.
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'ESCALATED');
});

test('light path: touching a sensitive path fails verify', () => {
  const root = makeProject();
  phase(root, 'new', 'text change', '--path', 'light');
  write(root, `${T}/REQUEST.md`, 'غيّر النص\n');
  phase(root, 'next');
  write(root, `${T}/EXEC_PROMPT.md`, execPrompt({ path: 'light' }));
  write(root, `${T}/TASKS.json`, JSON.stringify({ task_id: 'TASK-001', path: 'light', items: [{ id: 'T1', title: 't', acceptance: [], allowed_write: ['src/payment-label.mjs'] }] }));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'IMPLEMENT');
  write(root, 'src/payment-label.mjs', 'export const label = "x";\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'change');
  const r = verify(root);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /light_path_sensitive/);
});

test('light path: proposed full path upgrades the task', () => {
  const root = makeProject();
  phase(root, 'new', 'x', '--path', 'light');
  write(root, `${T}/REQUEST.md`, 'طلب\n');
  phase(root, 'next');
  write(root, `${T}/EXEC_PROMPT.md`, execPrompt({ path: 'full' }));
  phase(root, 'next');
  assert.equal(task(root).path, 'full');
  assert.equal(task(root).phase, 'DESIGN');
});

test('implement: writing outside allowed_write fails verify; tampering with frozen tests fails verify', () => {
  const root = makeProject();
  toImplement(root);
  implementCorrectly(root);
  write(root, 'src/other.mjs', 'export const b = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'outside');
  let r = verify(root);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /allowed_write/);

  const root2 = makeProject();
  toImplement(root2);
  implementCorrectly(root2);
  write(root2, 'tests/late.test.mjs', "import { test } from 'node:test';\ntest('AC-1: weakened', () => {});\n");
  git(root2, 'add', '-A');
  git(root2, 'commit', '-qm', 'weaken');
  r = verify(root2);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /tests_frozen/);
});

test('implement: two consecutive verify failures escalate', () => {
  const root = makeProject();
  toImplement(root);
  write(root, 'src/late.mjs', 'export function lateDays() { return 0; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'wrong');
  assert.notEqual(verify(root).code, 0);
  assert.notEqual(verify(root).code, 0);
  assert.equal(task(root).phase, 'ESCALATED');
  assert.equal(phase(root, 'resume', '--to', 'IMPLEMENT', '--note', 'حاول مرة أخرى').code, 0);
  assert.equal(task(root).phase, 'IMPLEMENT');
});

test('change request: clarification returns to TESTS and refreezes', () => {
  const root = makeProject();
  toImplement(root);
  const firstFreeze = task(root).frozen_sha;
  write(root, `${T}/CHANGE_REQUEST-1.md`, '# CR-1\nSPEC ambiguous on time zone\n');
  assert.equal(phase(root, 'goto', 'DESIGN', '--reason', 'CR-1').code, 0);
  assert.notEqual(phase(root, 'next').code, 0, 'needs CHANGE_DECISION');
  write(root, `${T}/CHANGE_DECISION-1.md`, '---\nclassification: clarification\n---\n# decision\n');
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'TESTS');
  write(root, 'tests/late.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('AC-1: late days UTC', async () => {\n  const { lateDays } = await import('../src/late.mjs');\n  assert.equal(lateDays('2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z'), 14);\n});\n");
  assert.equal(phase(root, 'next').code, 0);
  assert.notEqual(task(root).frozen_sha, firstFreeze);
});

test('guard: phase-based write control and command rules', () => {
  const root = makeProject();
  toImplement(root);
  const abs = (rel) => join(root, rel);
  assert.equal(guard(root, 'write_to_file', { TargetFile: abs('src/late.mjs') }).decision, 'allow');
  assert.equal(guard(root, 'replace_file_content', { TargetFile: abs('tests/late.test.mjs') }).decision, 'deny');
  assert.equal(guard(root, 'write_to_file', { TargetFile: abs(`${T}/task.json`) }).decision, 'deny');
  assert.equal(guard(root, 'write_to_file', { TargetFile: abs('.team/bin/phase.mjs') }).decision, 'deny');
  assert.equal(guard(root, 'write_to_file', { TargetFile: abs('.agents/agents/marwan-sat-implementer.md') }).decision, 'deny');
  assert.equal(guard(root, 'write_to_file', {}).decision, 'ask');
  assert.equal(guard(root, 'run_command', { CommandLine: 'rm -rf src' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'git push --force origin sat/TASK-001' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'git push origin main' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'git push -u origin sat/TASK-001' }).decision, 'allow');
  assert.equal(guard(root, 'view_file', { AbsolutePath: abs(`${T}/IMPLEMENTATION_NOTES.md`) }).decision, 'allow', 'allowed outside REVIEW');
});

test('guard: no active task asks; owner approval mode blocks agents from approving', () => {
  const root = makeProject();
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, 'src/a.mjs') }).decision, 'ask');
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace('approval: agent', 'approval: owner'));
  assert.equal(guard(root, 'run_command', { CommandLine: 'node .team/bin/phase.mjs approve GATE_1 --note ok' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'node .team/bin/phase.mjs status' }).decision, 'allow');
});

test('guard: reviewers keep a clean context and attack localhost only', () => {
  const root = makeProject();
  toImplement(root);
  implementCorrectly(root);
  verify(root);
  phase(root, 'next');
  assert.equal(task(root).phase, 'REVIEW');
  assert.equal(guard(root, 'view_file', { AbsolutePath: join(root, `${T}/IMPLEMENTATION_NOTES.md`) }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'curl -s https://example.com/api' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'curl -s http://localhost:3000/api/x' }).decision, 'allow');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, `${T}/REVIEW.json`) }).decision, 'allow');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, 'src/late.mjs') }).decision, 'deny');
});

test('verify: a configured scanner that is not installed is a warning locally and a failure in CI', () => {
  const root = makeProject();
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace('    secrets: null', '    secrets: sat-missing-scanner-zz --scan'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'configure a scanner that is not installed');
  const local = verify(root);
  assert.equal(local.code, 0, local.out);
  assert.match(local.out, /secrets: missing/);
  const ci = verify(root, '--ci');
  assert.notEqual(ci.code, 0);
  assert.match(ci.out, /secrets: fail/);
});

test('guard: works the way Antigravity runs it — `node .team/bin/guard.mjs` from .agents/, no workspacePaths', () => {
  // Regression: Antigravity runs workspace hooks with .agents/ as the working directory, and the hook failed
  // with "Cannot find module .agents/.team/bin/guard.mjs", which blocked every tool call.
  const root = makeProject();
  const payload = (file) => JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: join(root, file) } } });
  for (const cwd of [root, join(root, '.agents')]) {
    const protectedFile = sh('node', [join('.team', 'bin', 'guard.mjs')], cwd, payload('.team/CHARTER.md'));
    assert.equal(protectedFile.code, 0, protectedFile.out);
    assert.equal(JSON.parse(protectedFile.stdout).decision, 'deny', `from ${cwd}: ${protectedFile.out}`);
    const noTask = sh('node', [join('.team', 'bin', 'guard.mjs')], cwd, payload('src/a.mjs'));
    assert.equal(JSON.parse(noTask.stdout).decision, 'ask', `from ${cwd}: ${noTask.out}`);
  }
});
