import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProject } from '../core/bin/lib/config.mjs';
import { normalizePhrase, phraseMatches, stageOf } from '../core/bin/lib/plain.mjs';
import { execPrompt, git, guard, implementCorrectly, makeProject, phase, read, report, SAT_ROOT, sh, T, task, toGate1, toImplement, verify, write } from './helpers.mjs';

const status = (root) => JSON.parse(phase(root, 'status', '--json').out);

test('phrases: harmless differences are tolerated, other words are not', () => {
  assert.ok(phraseMatches('ابدأ التنفيذ', 'ابدأ التنفيذ'));
  assert.ok(phraseMatches('  «ابدا التنفيذ».', 'ابدأ التنفيذ'), 'hamza, quotes, punctuation and spaces');
  assert.ok(phraseMatches('اعتمد النتيجه', 'اعتمد النتيجة'), 'ta marbuta');
  assert.ok(phraseMatches('ابدأُ التنفيذَ', 'ابدأ التنفيذ'), 'diacritics');
  assert.ok(!phraseMatches('تمام', 'ابدأ التنفيذ'));
  assert.ok(!phraseMatches('ابدأ التنفيذ غداً', 'ابدأ التنفيذ'), 'an extra word changes the meaning');
  assert.ok(!phraseMatches('اعتمد الخطة', 'ابدأ التنفيذ'));
  assert.ok(!phraseMatches('', 'ابدأ التنفيذ'));
  assert.equal(normalizePhrase('ابدأ'), normalizePhrase('ابدا'));
});

test('two gates: approving the plan starts nothing; only the exact start phrase does', () => {
  const root = makeProject();
  toGate1(root);
  assert.equal(task(root).phase, 'GATE_1');
  assert.match(status(root).stage, /تحضير/);
  assert.equal(status(root).required_reply, 'اعتمد الخطة');

  // A paraphrase records nothing.
  let r = phase(root, 'approve', 'GATE_1', '--decision', 'approve', '--note', 'موافق');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /اعتمد الخطة/);
  assert.equal(task(root).phase, 'GATE_1');
  assert.equal((task(root).gates.GATE_1 || []).length, 0, 'nothing recorded');

  // The plan is approved: the task now waits for a separate start permission, still in preparation.
  assert.equal(phase(root, 'approve', 'GATE_1', '--decision', 'approve', '--note', 'اعتمد الخطة').code, 0);
  assert.equal(task(root).phase, 'GATE_START');
  assert.equal(status(root).required_reply, 'ابدأ التنفيذ');
  assert.match(status(root).stage, /تحضير/);
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, 'src/late.mjs') }).decision, 'deny', 'no code before the start permission');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, 'tests/late.test.mjs') }).decision, 'deny', 'no tests either');

  for (const reply of ['تمام', 'اعتمد الخطة', 'نعم ابدأ', 'ok']) {
    r = phase(root, 'approve', 'GATE_START', '--decision', 'approve', '--note', reply);
    assert.notEqual(r.code, 0, `"${reply}" must not start the work`);
    assert.equal(task(root).phase, 'GATE_START');
  }
  assert.match(r.out, /ابدأ التنفيذ/);

  // The owner can still change the plan from the start gate: back to design, nothing started.
  assert.equal(phase(root, 'approve', 'GATE_START', '--decision', 'changes', '--note', 'عدّل: أضف عمود الفرع').code, 0);
  assert.equal(task(root).phase, 'DESIGN');
  assert.ok(!task(root).started);
});

test('two gates: the start phrase moves the task into execution and the stage says so', () => {
  const root = makeProject();
  toGate1(root);
  phase(root, 'approve', 'GATE_1', '--decision', 'approve', '--note', 'اعتمد الخطة');
  assert.equal(phase(root, 'approve', 'GATE_START', '--decision', 'approve', '--note', '«ابدا التنفيذ»').code, 0);
  assert.equal(task(root).phase, 'TESTS');
  assert.ok(task(root).started);
  assert.match(status(root).stage, /تنفيذ/);
  assert.equal(stageOf({ phase: 'GATE_2' }).key, 'delivered');
});

test('resume cannot jump into execution before the start permission', () => {
  const root = makeProject();
  toGate1(root);
  assert.equal(phase(root, 'escalate', 'owner away').code, 0);
  let r = phase(root, 'resume', '--to', 'IMPLEMENT', '--note', 'كمّل');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /start permission/);
  r = phase(root, 'resume', '--to', 'DESIGN', '--note', 'عدّل التصميم');
  assert.equal(r.code, 0, r.out);
});

test('the report is two parts: the owner\'s decision first, the technical detail last', () => {
  const root = makeProject();
  toImplement(root);
  implementCorrectly(root);
  verify(root);
  phase(root, 'next');
  write(root, `${T}/REVIEW.json`, JSON.stringify({ verdict: 'CLEAR_WITHIN_SCOPE', findings: [{ id: 'REV-01', lens: 'logic', severity: 'medium', proof: 'suspected', location: 'src/late.mjs#lateDays', scenario: 'DST', fix: 'use UTC' }] }));
  write(root, `${T}/SECURITY_AUDIT.json`, JSON.stringify({ profile: 'web', verdict: 'CLEAR_WITHIN_SCOPE', coverage: [{ axis: 'access_control', status: 'NOT_APPLICABLE', reason: 'no entry point' }], findings: [] }));
  let r = phase(root, 'next');
  assert.notEqual(r.code, 0, 'simple audience: a medium finding needs a plain sentence');
  assert.match(r.out, /plain/);
  write(root, `${T}/REVIEW.json`, JSON.stringify({ verdict: 'CLEAR_WITHIN_SCOPE', findings: [{ id: 'REV-01', lens: 'logic', severity: 'medium', proof: 'suspected', location: 'src/late.mjs#lateDays', scenario: 'DST', fix: 'use UTC', plain: 'قد يخطئ العدّ بيوم واحد عند تغيير التوقيت الصيفي.' }] }));
  r = phase(root, 'next');
  assert.equal(r.code, 0, r.out);
  assert.equal(report(root).code, 0);
  const rep = read(root, `${T}/REPORT.md`);
  const part2 = rep.indexOf('# الجزء الثاني');
  assert.ok(rep.indexOf('# الجزء الأول: لك') < part2 && part2 > 0);
  assert.match(rep, /🟢 انتهى التنفيذ/);
  assert.match(rep, /«اعتمد النتيجة»/);
  assert.match(rep.slice(0, part2), /قد يخطئ العدّ بيوم واحد/, 'the plain sentence is in the owner\'s part');
  assert.match(rep.slice(0, part2), /متوسطة/);
  assert.doesNotMatch(rep.slice(0, part2), /src\/late\.mjs/, 'no file paths in the owner\'s part');
  assert.match(rep.slice(part2), /src\/late\.mjs/, 'files are in the technical part');
});

test('audience developer: technical vocabulary, plain sentences optional', () => {
  const root = makeProject();
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace(/audience: simple/, 'audience: developer'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'developer audience');
  toImplement(root);
  implementCorrectly(root);
  verify(root);
  phase(root, 'next');
  write(root, `${T}/REVIEW.json`, JSON.stringify({ verdict: 'CLEAR_WITHIN_SCOPE', findings: [{ id: 'REV-01', lens: 'logic', severity: 'medium', proof: 'suspected', location: 'src/late.mjs#lateDays', scenario: 'DST', fix: 'use UTC' }] }));
  write(root, `${T}/SECURITY_AUDIT.json`, JSON.stringify({ profile: 'web', verdict: 'CLEAR_WITHIN_SCOPE', coverage: [{ axis: 'access_control', status: 'NOT_APPLICABLE', reason: 'no entry point' }], findings: [] }));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(report(root).code, 0);
  const rep = read(root, `${T}/REPORT.md`);
  assert.match(rep, /ملاحظة Medium REV-01/);
  assert.match(rep, /حكم المراجع: CLEAR_WITHIN_SCOPE/);
});

test('project.yaml: audience and phrases are validated; custom phrases are honoured', () => {
  const root = makeProject();
  const y = read(root, '.team/project.yaml');
  write(root, '.team/project.yaml', y.replace(/audience: simple/, 'audience: manager'));
  assert.throws(() => loadProject(root), /owner\.audience/);
  write(root, '.team/project.yaml', y.replace('start: "ابدأ التنفيذ"', 'start: "اعتمد الخطة"'));
  assert.throws(() => loadProject(root), /must differ/);
  write(root, '.team/project.yaml', y.replace('start: "ابدأ التنفيذ"', 'start: "نفّذ الآن"'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'custom start phrase');
  toGate1(root);
  phase(root, 'approve', 'GATE_1', '--decision', 'approve', '--note', 'اعتمد الخطة');
  assert.notEqual(phase(root, 'approve', 'GATE_START', '--decision', 'approve', '--note', 'ابدأ التنفيذ').code, 0);
  assert.equal(phase(root, 'approve', 'GATE_START', '--decision', 'approve', '--note', 'نفّذ الآن').code, 0);
});

test('install: the audience is chosen at init and baked into the generated instructions', () => {
  const root = makeProject();
  const tm = read(root, '.agents/agents/marwan-sat-tech-manager.md');
  assert.match(tm, /«ابدأ التنفيذ»/);
  assert.match(tm, /owner\.audience: simple/);
  assert.doesNotMatch(tm, /\{\{PHRASE_/);
  assert.match(read(root, '.agents/rules/marwan-sat.md'), /«اعتمد الخطة».*«ابدأ التنفيذ»/);
  const dev = join(root, '..', 'dev');
  sh('git', ['init', '-q', '-b', 'main', dev], root);
  write(dev, 'package.json', '{"name":"d"}\n');
  const r = sh('node', [join(SAT_ROOT, 'cli', 'sat.mjs'), 'init', '--stack', 'custom', '--audience', 'developer'], dev);
  assert.equal(r.code, 0, r.out);
  assert.match(read(dev, '.team/project.yaml'), /audience: developer/);
  assert.notEqual(sh('node', [join(SAT_ROOT, 'cli', 'sat.mjs'), 'init', '--stack', 'custom', '--audience', 'boss', '--dir', join(root, '..', 'x')], root).code, 0);
});

test('light path: plan and start gates come before any change', () => {
  const root = makeProject();
  phase(root, 'new', 'نص الزر', '--path', 'light');
  write(root, `${T}/REQUEST.md`, 'غيّر نص الزر\n');
  phase(root, 'next');
  write(root, `${T}/EXEC_PROMPT.md`, execPrompt({ path: 'light' }));
  write(root, `${T}/TASKS.json`, JSON.stringify({ task_id: 'TASK-001', path: 'light', items: [{ id: 'T1', title: 't', acceptance: [], allowed_write: ['src/a.mjs'] }] }));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'GATE_1');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, 'src/a.mjs') }).decision, 'deny');
  assert.equal(phase(root, 'approve', 'GATE_1', '--decision', 'changes', '--note', 'عدّل: نص آخر').code, 0);
  assert.equal(task(root).phase, 'INTERPRET', 'the light path has no design phase: changes go back to interpretation');
});

test('tasks from before the start gate still resume into execution', async () => {
  const { hasStarted } = await import('../core/bin/lib/plain.mjs');
  assert.ok(hasStarted({ history: [{ phase: 'GATE_1' }, { phase: 'TESTS' }] }), 'an older task that reached TESTS had started');
  assert.ok(!hasStarted({ history: [{ phase: 'GATE_1' }] }));
  assert.ok(hasStarted({ started: { at: 'x' } }));
});
