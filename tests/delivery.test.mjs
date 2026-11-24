import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { delegationsSeen, toolNamesVerdict } from '../cli/lib/doctor.mjs';
import { git, guard, implementCorrectly, SAT_ROOT, makeProject, phase, read, report, satCli, sh, T, task, toImplement, verify, write } from './helpers.mjs';

const J = (o) => JSON.stringify(o);
const CLEAR_AUDIT = J({ profile: 'web', verdict: 'CLEAR_WITHIN_SCOPE', coverage: [{ axis: 'access_control', status: 'NOT_APPLICABLE', reason: 'no entry point' }], findings: [] });

// A bare repository plays GitHub; the project pushes to it.
function withRemote(root) {
  const bare = join(dirname(root), 'origin.git');
  const r = sh('git', ['init', '--bare', '-q', '-b', 'main', bare], dirname(root));
  if (r.code !== 0) throw new Error(r.out);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return bare;
}

// The owner presses Merge on GitHub: done here in a separate clone, as the server would.
function ownerMerges(bare, branch, { squash = false } = {}) {
  const w = join(mkdtempSync(join(tmpdir(), 'sat-owner-')), 'w');
  const c = sh('git', ['clone', '-q', bare, w], dirname(w));
  if (c.code !== 0) throw new Error(c.out);
  const id = ['-c', 'user.name=owner', '-c', 'user.email=owner@test'];
  if (squash) {
    git(w, 'merge', '-q', '--squash', `origin/${branch}`);
    git(w, ...id, 'commit', '-qm', `${branch} (squashed)`);
  } else git(w, ...id, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`);
  git(w, 'push', '-q', 'origin', 'main');
}

// From a fresh project to Gate 2, with the given review findings.
function toGate2(root, findings = []) {
  toImplement(root);
  implementCorrectly(root);
  assert.equal(verify(root).code, 0);
  assert.equal(phase(root, 'next').code, 0);
  write(root, `${T}/REVIEW.json`, J({ verdict: 'CLEAR_WITHIN_SCOPE', findings }));
  write(root, `${T}/SECURITY_AUDIT.json`, CLEAR_AUDIT);
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(report(root).code, 0);
  const rep = read(root, `${T}/REPORT.md`);
  write(root, `${T}/REPORT.md`, rep.replace(/(<!-- sat:tm-risk:begin -->)[\s\S]*?(<!-- sat:tm-risk:end -->)/, '$1\nالمخاطرة المتبقية منخفضة.\n$2'));
  return phase(root, 'next');
}

const remoteHas = (root, branch) => git(root, 'ls-remote', '--heads', 'origin', branch) !== '';
const status = (root) => JSON.parse(phase(root, 'status', '--json').stdout);

test('delivery: Gate 2 pushes the branch; Merge is the approval; the next task starts from the merged base', () => {
  const root = makeProject();
  const bare = withRemote(root);
  const r = toGate2(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Pushed the task branch/);
  assert.equal(task(root).phase, 'GATE_2');
  assert.ok(remoteHas(root, 'sat/TASK-001'), 'the tool pushed the task branch');
  assert.equal(git(root, 'status', '--porcelain'), '', 'nothing is left for the owner to commit');

  const s = status(root);
  assert.equal(s.owner_action, 'merge');
  assert.equal(s.merged, false);
  const early = phase(root, 'new', 'مهمة ثانية');
  assert.notEqual(early.code, 0);
  assert.match(early.out, /waiting for the owner to press Merge/);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sat/TASK-001', 'a refused command changes nothing');

  ownerMerges(bare, 'sat/TASK-001');
  assert.equal(status(root).merged, true);
  const next = phase(root, 'new', 'مهمة ثانية', '--path', 'light');
  assert.equal(next.code, 0, next.out);
  assert.match(next.out, /TASK-001 closed: the owner merged it/);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sat/TASK-002');
  assert.equal(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'origin/main'), 'the local main branch was brought up to date');
  assert.ok(existsSync(join(root, 'src/late.mjs')), 'the new task starts with the merged work');
  assert.equal(task(root, 'TASK-001').phase, 'CLOSED');
  assert.equal(task(root, 'TASK-002').base_sha, git(root, 'rev-parse', 'HEAD'));
});

test('delivery: a squash merge counts as a merge', () => {
  const root = makeProject();
  const bare = withRemote(root);
  assert.equal(toGate2(root).code, 0);
  ownerMerges(bare, 'sat/TASK-001', { squash: true });
  const next = phase(root, 'new', 'مهمة ثانية');
  assert.equal(next.code, 0, next.out);
  assert.equal(task(root, 'TASK-001').phase, 'CLOSED');
});

test('delivery: risks the report lists need the owner\'s written acceptance, recorded in the PR before the merge', () => {
  const medium = { id: 'REV-02', lens: 'logic', severity: 'medium', proof: 'suspected', location: 'src/late.mjs#lateDays', scenario: 's', fix: 'f', plain: 'قد يختلف عدد أيام التأخير بيوم واحد عند تغيّر التوقيت.' };
  const root = makeProject();
  const bare = withRemote(root);
  assert.equal(toGate2(root, [medium]).code, 0);
  assert.match(read(root, `${T}/REPORT.md`), /لقبول ما سبق/);
  const s = status(root);
  assert.deepEqual(s.acceptance_needed, ['REV-02']);
  assert.equal(s.required_reply, 'اعتمد النتيجة');
  assert.notEqual(phase(root, 'approve', 'GATE_2', '--decision', 'approve', '--note', 'تمام').code, 0, '"ok" accepts nothing');
  const ok = phase(root, 'approve', 'GATE_2', '--decision', 'approve', '--note', 'اعتمد النتيجة');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(task(root).phase, 'GATE_2', 'acceptance does not close the task: the merge does');
  assert.deepEqual(task(root).risk_accepted.ids, ['REV-02']);
  const onRemote = JSON.parse(git(root, 'show', 'origin/sat/TASK-001:.team/tasks/TASK-001/task.json'));
  assert.ok(onRemote.risk_accepted, 'the acceptance was pushed into the PR');
  assert.equal(status(root).required_reply, null);
  ownerMerges(bare, 'sat/TASK-001');
  const next = phase(root, 'new', 'مهمة ثانية');
  assert.equal(next.code, 0, next.out);
  assert.doesNotMatch(next.out, /without the owner's written acceptance/);
});

test('delivery: a merge without the written acceptance is closed, and said so', () => {
  const medium = { id: 'REV-03', lens: 'logic', severity: 'medium', proof: 'confirmed', location: 'src/late.mjs#lateDays', scenario: 's', evidence: 'e', fix: 'f', plain: 'قد يظهر تاريخ خاطئ في تقرير المتأخرات.' };
  const root = makeProject();
  const bare = withRemote(root);
  assert.equal(toGate2(root, [medium]).code, 0);
  ownerMerges(bare, 'sat/TASK-001');
  const next = phase(root, 'new', 'مهمة ثانية');
  assert.equal(next.code, 0, next.out);
  assert.match(next.out, /Merged without the owner's written acceptance of: REV-03/);
  const ledger = read(root, '.team/LEDGER.jsonl');
  assert.match(ledger, /"merged_without_acceptance":\["REV-03"\]/);
});

test('delivery: a cancelled task leaves a clean tree, and the next task starts from the base branch', () => {
  const root = makeProject();
  toImplement(root);
  assert.equal(phase(root, 'cancel', '--note', 'صاحب القرار ألغى المهمة').code, 0);
  assert.equal(git(root, 'status', '--porcelain'), '');
  const next = phase(root, 'new', 'مهمة ثانية');
  assert.equal(next.code, 0, next.out);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sat/TASK-002');
  assert.notEqual(sh('git', ['merge-base', '--is-ancestor', 'sat/TASK-001', 'HEAD'], root).code, 0, 'the cancelled work is not carried into the next task');
});

test('delivery: an unmerged task branch cannot be left for new work', () => {
  const root = makeProject();
  toImplement(root);
  write(root, '.team/STATE.json', J({ active_task: null }));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'work in progress');
  const r = phase(root, 'new', 'مهمة ثانية');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /has not been merged/);
});

test('team update: --check changes nothing; one exact approval; its own branch and PR; nothing new before the merge', () => {
  const root = makeProject();
  const bare = withRemote(root);
  const version = JSON.parse(readFileSync(join(SAT_ROOT, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(read(root, '.team/sat.lock'));
  write(root, '.team/sat.lock', `${JSON.stringify({ ...lock, sat_version: '0.4.0' }, null, 2)}\n`);
  git(root, 'commit', '-qam', 'an older team');
  git(root, 'push', '-q');

  const check = satCli(root, 'update', '--check');
  assert.equal(check.code, 0, `CHECK ${check.out}`);
  assert.match(check.out, new RegExp(`Installed: 0\\.4\\.0 · available: ${version.replace(/\./g, '\\.')}`));
  assert.match(check.out, /«نفّذ التحديث»/);
  assert.equal(git(root, 'status', '--porcelain'), '');

  const no = satCli(root, 'update', '--approve', 'تمام');
  assert.notEqual(no.code, 0);
  assert.match(no.out, /does not approve the team update/);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  const yes = satCli(root, 'update', '--approve', 'نفّذ التحديث');
  assert.equal(yes.code, 0, `YES ${yes.out}`);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), `chore/sat-${version}`);
  assert.ok(remoteHas(root, `chore/sat-${version}`));
  assert.equal(git(root, 'log', '-1', '--format=%s'), `chore: update Marwan SAT to ${version}`);
  assert.equal(git(root, 'status', '--porcelain'), '');

  const early = phase(root, 'new', 'مهمة');
  assert.notEqual(early.code, 0);
  assert.match(early.out, /team update .* waiting for the owner to press Merge/);
  ownerMerges(bare, `chore/sat-${version}`);
  const next = phase(root, 'new', 'مهمة');
  assert.equal(next.code, 0, next.out);
  assert.equal(JSON.parse(read(root, '.team/sat.lock')).sat_version, version);
});

test('team update: the in-place update refuses a task branch; in owner mode agents cannot approve an update', () => {
  const root = makeProject();
  assert.equal(phase(root, 'new', 'مهمة').code, 0);
  const r = satCli(root, 'update');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /task branch/);
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace('approval: agent', 'approval: owner'));
  assert.equal(guard(root, 'run_command', { CommandLine: 'npx github:marwan-ahmed/marwan-sat#v9.9.9 update --approve "نفّذ التحديث"' }).decision, 'deny');
});

test('evidence: the hook records each subagent the tech manager starts; doctor confirms the tool names from it', () => {
  const root = makeProject();
  const subagents = ['marwan-sat-request-interpreter', 'marwan-sat-architect', 'marwan-sat-security-auditor', 'marwan-sat-test-author', 'marwan-sat-implementer', 'marwan-sat-adversarial-reviewer'];
  for (const a of subagents.slice(0, 5)) assert.equal(guard(root, 'invoke_subagent', { Name: a, Prompt: `TASK-001 brief for ${a}` }).decision, 'allow');
  assert.equal(delegationsSeen(root, subagents).size, 5);
  const known = { capabilities: { read: ['view_file'] } };
  const used = new Set(['view_file']);
  assert.equal(toolNamesVerdict(known, used, { subagents, seen: delegationsSeen(root, subagents) }).level, 'warn', 'five of six is not all');
  guard(root, 'invoke_subagent', { Name: subagents[5], Prompt: 'brief' });
  const v = toolNamesVerdict(known, used, { subagents, seen: delegationsSeen(root, subagents) });
  assert.equal(v.level, 'ok');
  assert.match(v.detail, /hook evidence/);
  assert.doesNotMatch(read(root, '.team/evidence/delegations.jsonl'), /lateDays/, 'only short call arguments are kept');
  assert.equal(git(root, 'status', '--porcelain', '--', '.team/evidence'), '', 'the evidence is not committed');
});
