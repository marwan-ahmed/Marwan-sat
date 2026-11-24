import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretProtection, protectionVerdict, toolNamesVerdict } from '../cli/lib/doctor.mjs';
import { mergeRules } from '../core/bin/guard.mjs';
import { loadProject } from '../core/bin/lib/config.mjs';
import { git, guard, makeProject, read, satCli, write } from './helpers.mjs';

const ok = (body) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
const err = (stderr) => ({ status: 1, stdout: '', stderr });
const noRules = () => {
  throw new Error('rulesets must not be read when the classic rule answers');
};
const verdict = (policy, classic, rules = noRules) => protectionVerdict(policy, 'main', interpretProtection(classic, rules));

test('branch protection: only a rule that requires a PR and binds admins counts', () => {
  const full = { required_pull_request_reviews: { required_approving_review_count: 0 }, enforce_admins: { enabled: true } };
  assert.equal(verdict('required', ok(full)).level, 'ok');

  // Agents act with the owner's identity: a rule admins can bypass does not stop them.
  const bypassable = verdict('required', ok({ ...full, enforce_admins: { enabled: false } }));
  assert.equal(bypassable.level, 'fail');
  assert.match(bypassable.detail, /Do not allow bypassing the above settings/);
  assert.match(bypassable.detail, /act with your GitHub identity/);

  const noPr = verdict('required', ok({ enforce_admins: { enabled: true } }));
  assert.equal(noPr.level, 'fail');
  assert.match(noPr.detail, /Require a pull request before merging/);
});

test('branch protection: a private repository on the free plan, a missing rule, or no answer is NOT READY', () => {
  const plan = verdict('required', err('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'));
  assert.equal(plan.level, 'fail');
  assert.match(plan.detail, /GitHub Pro/);
  assert.match(plan.detail, /accepted_risk/, 'the way out is named');

  const off = verdict('required', err('gh: Branch not protected (HTTP 404)'), () => ok([]));
  assert.equal(off.level, 'fail');
  assert.match(off.detail, /^off: /);

  const ruleset = verdict('required', err('gh: Branch not protected (HTTP 404)'), () => ok([{ type: 'deletion' }, { type: 'pull_request' }]));
  assert.equal(ruleset.level, 'ok', 'a repository ruleset that requires a PR counts');

  const forbidden = verdict('required', err('gh: Resource not accessible by integration (HTTP 403)'));
  assert.equal(forbidden.level, 'fail');
  assert.match(forbidden.detail, /not verified/);

  const noGh = protectionVerdict('required', 'main', { state: 'unverifiable', why: 'GitHub CLI (gh) is not installed' });
  assert.equal(noGh.level, 'fail');
});

test('branch protection: accepted_risk turns the block into a recorded warning, never into ok', () => {
  for (const s of [{ state: 'plan' }, { state: 'off' }, { state: 'unverifiable', why: 'x' }, { state: 'weak', missing: ['"x"'] }]) {
    const v = protectionVerdict('accepted_risk', 'main', s);
    assert.equal(v.level, 'warn', s.state);
    assert.match(v.detail, /Risk accepted in project\.yaml/);
    assert.match(v.detail, /guard is not a final guarantee/);
  }
  assert.equal(protectionVerdict('accepted_risk', 'main', { state: 'enforced' }).level, 'ok');
});

test('project.yaml: git.branch_protection defaults to required and is validated', () => {
  const root = makeProject();
  assert.match(read(root, '.team/project.yaml'), /branch_protection: required/, 'the preset writes it');
  assert.equal(loadProject(root).git.branch_protection, 'required');
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace('branch_protection: required', 'branch_protection: maybe'));
  assert.throws(() => loadProject(root), /git\.branch_protection/);
  // Older projects without the key get the strict default.
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace(/ *branch_protection: maybe.*\n/, ''));
  assert.equal(loadProject(root).git.branch_protection, 'required');
});

test('doctor: unverified branch protection blocks, until the owner records the accepted risk', () => {
  const root = makeProject(); // no GitHub remote: protection cannot be verified on any machine
  const strict = satCli(root, 'doctor', '--quick');
  assert.match(strict.out, /✗ Branch protection on main — not verified/);
  assert.match(strict.out, /Verdict: NOT READY/);
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace('branch_protection: required', 'branch_protection: accepted_risk'));
  git(root, 'commit', '-qam', 'owner accepts the risk');
  const accepted = satCli(root, 'doctor', '--quick');
  assert.match(accepted.out, /! Branch protection on main — not verified: .*Risk accepted in project\.yaml/);
  assert.doesNotMatch(accepted.out, /✗ Branch protection/);
});

test('guard: merging stays with the owner — no push to the base branch, no gh merge', () => {
  const rules = mergeRules('develop');
  const denied = (cmd) => rules.some(([rx]) => rx.test(cmd));
  for (const cmd of [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin sat/TASK-001:refs/heads/main',
    'git push origin +HEAD:master',
    'git push origin "develop"',
    'gh pr merge 7 --squash',
    'gh api -X PUT repos/o/r/pulls/7/merge',
    'gh api repos/o/r/merges -f base=main -f head=sat/TASK-001',
  ])
    assert.ok(denied(cmd), cmd);
  for (const cmd of ['git push -u origin sat/TASK-001', 'git push origin main-menu', 'git push origin feature/main', 'gh pr create --fill', 'gh pr view 7'])
    assert.ok(!denied(cmd), cmd);

  // End to end through the hook, in a project whose checked-out branch is main.
  const root = makeProject();
  assert.equal(guard(root, 'run_command', { CommandLine: 'gh pr merge 3 --merge' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'git push origin HEAD:main' }).decision, 'deny');
  assert.equal(guard(root, 'run_command', { CommandLine: 'git push' }).decision, 'deny', 'a bare push from main would update main');
  assert.equal(guard(root, 'run_command', { CommandLine: 'git push -u origin sat/TASK-001' }).decision, 'allow');
});

test('doctor: Antigravity tool names are confirmed only by a recorded real run', () => {
  const known = { capabilities: { read: ['view_file'], shell: ['run_command'] } };
  const used = new Set(['view_file', 'run_command']);
  assert.equal(toolNamesVerdict(known, used).level, 'warn');
  assert.equal(toolNamesVerdict({ ...known, confirmed: { on: '2026-11-23', names: ['view_file', 'run_command'] } }, used).level, 'ok');
  const partly = toolNamesVerdict({ ...known, confirmed: { on: '2026-11-23', names: ['view_file'] } }, used);
  assert.equal(partly.level, 'warn');
  assert.match(partly.detail, /^run_command — /, 'only the unconfirmed names are listed');
  assert.equal(toolNamesVerdict(known, new Set(['view_file', 'invent_tool'])).level, 'fail');
});
