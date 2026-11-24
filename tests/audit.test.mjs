import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBacklog, isSymbolLocation, priorityOf, validateFinding, validateInventory } from '../core/bin/lib/audit.mjs';
import { git, guard, makeProject, phase, read, sh, T, task, verify, write } from './helpers.mjs';

const backlog = (root) => sh('node', ['.team/bin/backlog.mjs'], root);
const J = (o) => `${JSON.stringify(o, null, 2)}\n`;

// ------------------------------------------------------------------------------------------- fixtures

function finding(id, over = {}) {
  return {
    id,
    title: `عنوان ${id}`,
    type: 'bug',
    area: 'core',
    severity: 'medium',
    proof: 'suspected',
    source: 'static_review',
    location: 'src/a.mjs#a',
    files: ['src/a.mjs'],
    problem: 'وصف المشكلة',
    expected_behavior: 'السلوك المتوقع',
    plain: `شرح مبسط لـ ${id}`,
    ...over,
  };
}

function inventory(over = {}) {
  return {
    task_id: 'TASK-001',
    environment: [
      { id: 'ENV-1', topic: 'runtime', fact: 'Node.js 22 on the server', evidence: 'package.json#engines' },
      { id: 'ENV-2', topic: 'hosting', fact: 'Vercel Fluid compute', evidence: 'vercel.json#(missing)' },
      { id: 'ENV-3', topic: 'database', fact: 'Postgres through a pooled driver', evidence: 'src/db.mjs#pool' },
      { id: 'ENV-4', topic: 'auth', fact: 'session cookie checked by getUser', evidence: 'src/auth-session.mjs#getUser' },
    ],
    entry_points: [
      { id: 'EP-1', kind: 'route', path: 'GET /courses', exposure: 'public', auth_check: 'NOT_REQUIRED' },
      { id: 'EP-2', kind: 'server_action', path: 'src/admin.mjs#deleteTransaction', exposure: 'role', roles: ['admin'], auth_check: 'UNKNOWN' },
      { id: 'EP-3', kind: 'server_action', path: 'src/payment.mjs#requestPayout', exposure: 'authenticated', auth_check: 'src/auth-session.mjs#getUser' },
    ],
    ...over,
  };
}

const coverage = [
  ['access_control', 'REVIEWED_STATIC'],
  ['authentication', 'REVIEWED_STATIC'],
  ['injection', 'REVIEWED_STATIC'],
  ['business_logic', 'REVIEWED_STATIC'],
  ['mass_assignment_data_exposure', 'NOT_TESTED', 'attack_env is none'],
  ['resource_abuse_uploads', 'REVIEWED_STATIC'],
  ['configuration_secrets_supply_chain', 'REVIEWED_STATIC'],
].map(([axis, status, reason]) => ({ axis, status, ...(reason ? { reason } : {}) }));

function securityFile(findings) {
  return { task_id: 'TASK-001', lens: 'security', profile: 'web', examined: ['every server action in src/'], not_examined: [], coverage, scanner_triage: [], findings };
}
const lensFile = (lens, findings, extra = {}) => ({ task_id: 'TASK-001', lens, examined: ['src/'], not_examined: [], findings, ...extra });
const checks = (o = {}) => ({ reachable: 'yes', fix_valid_in_env: 'yes', severity_ok: 'yes', external_claims_verified: 'na', ...o });

// A project with code worth auditing.
function auditProject() {
  const root = makeProject();
  write(root, 'src/payment.mjs', 'export function requestPayout(user, amount) { return { user, amount }; }\n');
  write(root, 'src/admin.mjs', 'export function deleteTransaction(id) { return id; }\n');
  write(root, 'src/auth-session.mjs', 'export function getUser() { return null; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'app code');
  return root;
}

function toFindings(root) {
  assert.equal(phase(root, 'new', 'تدقيق شامل', '--kind', 'audit').code, 0);
  write(root, `${T}/REQUEST.md`, 'دقق المشروع واستخرج النواقص.\n');
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'INVENTORY');
  verify(root);
  write(root, `${T}/INVENTORY.json`, J(inventory()));
  const r = phase(root, 'next');
  assert.equal(r.code, 0, r.out);
  assert.equal(task(root).phase, 'FINDINGS');
}

function writeFindings(root) {
  write(root, `${T}/proofs/REV-1.md`, '# REV-1\nTwo parallel requests both succeeded: balance 100 → -100 (script + output).\n');
  write(
    root,
    `${T}/findings/security.json`,
    J(securityFile([finding('SEC-1', { type: 'vulnerability', area: 'authz', severity: 'high', attacker: 'authenticated', reachability: 'unknown', location: 'src/admin.mjs#deleteTransaction', files: ['src/admin.mjs'], entry_points: ['EP-2'], to_confirm: 'Call deleteTransaction with a student session and expect 403.' })])),
  );
  write(
    root,
    `${T}/findings/logic-money.json`,
    J(lensFile('logic_money', [finding('REV-1', { type: 'bug', area: 'payouts', severity: 'high', proof: 'confirmed', source: 'reproduction', attacker: 'authenticated', location: 'src/payment.mjs#requestPayout', files: ['src/payment.mjs'], evidence: `${T}/proofs/REV-1.md`, fix_hint: 'Lock the instructor row inside one transaction.', fix_assumes: ['ENV-3'], decision_needed: 'Who absorbs a rounding remainder?' })])),
  );
  write(root, `${T}/findings/gaps.json`, J(lensFile('gaps', [finding('GAP-1', { type: 'feature_gap', area: 'db-layer', files: ['src/db.mjs'], location: 'src/db.mjs#pool' })])));
}

function writeChallenges(root) {
  write(
    root,
    `${T}/challenge/by-reviewer.json`,
    J({ task_id: 'TASK-001', challenger: 'reviewer', reviews: [{ finding: 'SEC-1', verdict: 'upheld', reason: 'No role check on the path.', checks: checks({ reachable: 'unknown' }) }, { finding: 'GAP-1', verdict: 'upheld', reason: 'Seen in code.', checks: checks() }], missed: [] }),
  );
  write(
    root,
    `${T}/challenge/by-auditor.json`,
    J({
      task_id: 'TASK-001',
      challenger: 'auditor',
      reviews: [{ finding: 'REV-1', verdict: 'upheld', reason: 'Reproduced again.', checks: checks() }],
      dependencies: [{ finding: 'REV-1', after: 'GAP-1', reason: 'The lock needs an interactive transaction, which the current driver does not offer.' }],
      missed: [finding('MA-1', { type: 'missing_control', area: 'audit-log', severity: 'medium', files: ['src/admin.mjs'], location: 'src/admin.mjs#(missing)' })],
    }),
  );
}

// ------------------------------------------------------------------------------------------- unit

test('audit: locations are file#symbol, never a bare line number', () => {
  assert.ok(isSymbolLocation('src/actions/admin.ts#deleteTransactionAction'));
  assert.ok(isSymbolLocation('package.json#dependencies.xlsx'));
  assert.ok(isSymbolLocation('src/app/robots.ts#(missing)'));
  assert.ok(!isSymbolLocation('src/lib/db/index.ts#L38-L41'));
  assert.ok(!isSymbolLocation('src/lib/db/index.ts:38'));
  assert.ok(!isSymbolLocation('src/lib/db/index.ts'));
});

test('audit: the priority table', () => {
  assert.equal(priorityOf({ severity: 'critical', proof: 'suspected' }), 'P0');
  assert.equal(priorityOf({ severity: 'critical', proof: 'confirmed', reachability: 'unreachable' }), 'P2', 'unreachable code is not an emergency');
  assert.equal(priorityOf({ severity: 'high', proof: 'confirmed', attacker: 'authenticated' }), 'P0');
  assert.equal(priorityOf({ severity: 'high', proof: 'confirmed', attacker: 'privileged' }), 'P1');
  assert.equal(priorityOf({ severity: 'high', proof: 'suspected', attacker: 'unauthenticated' }), 'P1');
  assert.equal(priorityOf({ severity: 'medium' }), 'P2');
  assert.equal(priorityOf({ severity: 'low' }), 'P3');
});

test('audit: finding rules that the Marwan Academy report broke', () => {
  const ctx = { prefix: 'SEC', where: 'security.json', envIds: new Set(['ENV-1']), epIds: new Set(['EP-1']) };
  const errs = (f) => validateFinding(f, ctx).join('\n');
  assert.equal(errs(finding('SEC-1')), '');
  assert.match(errs(finding('SEC-1', { location: 'src/a.mjs#L12' })), /not a line number/);
  assert.match(errs(finding('SEC-1', { severity: 'high' })), /to_confirm/, 'a suspected high needs the check that would confirm it');
  assert.match(errs(finding('SEC-1', { proof: 'confirmed' })), /needs evidence/);
  assert.match(errs(finding('SEC-1', { type: 'vulnerability', attacker: 'authenticated' })), /reachability is required/);
  assert.match(errs(finding('SEC-1', { type: 'dependency', reachability: 'reachable', package: 'xlsx', usage: [] })), /no usage site/);
  assert.match(errs(finding('SEC-1', { type: 'dependency', reachability: 'unreachable', package: 'xlsx', usage: [] })), /reachability_note/);
  assert.match(errs(finding('SEC-1', { fix_hint: 'cache the pool in globalThis' })), /fix_assumes/, 'a fix must say which environment facts it depends on');
  assert.match(errs(finding('SEC-1', { fix_hint: 'x', fix_assumes: ['ENV-9'] })), /unknown fact ENV-9/);
  assert.match(errs(finding('SEC-1', { external_claims: [{ claim: 'next 16.4.6 is patched', source: 'npm view next@16.4.6' }] })), /checked_at/);
  assert.match(errs(finding('SEC-1', { entry_points: ['EP-7'] })), /unknown entry point EP-7/);
});

test('audit: inventory needs evidence-backed facts and a server-side check for every entry point', () => {
  assert.deepEqual(validateInventory(inventory(), { taskId: 'TASK-001' }).errors, []);
  const noAuth = inventory({ environment: inventory().environment.filter((e) => e.topic !== 'auth') });
  assert.match(validateInventory(noAuth).errors.join('\n'), /topic "auth"/);
  const bad = inventory({ entry_points: [{ id: 'EP-1', kind: 'server_action', path: 'x', exposure: 'role', auth_check: 'NOT_REQUIRED' }] });
  const e = validateInventory(bad).errors.join('\n');
  assert.match(e, /cannot have auth_check NOT_REQUIRED/);
  assert.match(e, /needs the roles/);
  const unknownFact = inventory({ environment: [...inventory().environment, { id: 'ENV-5', topic: 'db_driver', fact: 'http or websocket?', status: 'unknown' }] });
  assert.match(validateInventory(unknownFact).errors.join('\n'), /question/);
});

test('audit: backlog groups by priority and area, isolates dependencies, respects size limits', () => {
  const many = ['SEC-1', 'SEC-2', 'SEC-3', 'SEC-4'].map((id) => finding(id, { area: 'headers', severity: 'medium', files: [`src/${id}.mjs`], location: `src/${id}.mjs#x` }));
  const dep = finding('SEC-5', { type: 'dependency', area: 'headers', severity: 'medium', package: 'xlsx', usage: ['src/x.mjs#exportUsers'], reachability: 'reachable', files: ['package.json'], location: 'package.json#dependencies.xlsx' });
  const urgent = finding('SEC-6', { area: 'headers', severity: 'critical', files: ['src/h.mjs'], location: 'src/h.mjs#h', to_confirm: 'x' });
  const data = { inventory: inventory(), findings: { security: securityFile([...many, dep, urgent]), logic_money: lensFile('logic_money', []), gaps: lensFile('gaps', []) }, challenges: {}, unknowns: [] };
  const b = buildBacklog(data, { agentsMd: true, limits: { max_findings_per_task: 3, max_files_per_task: 8 } });
  const ids = b.items.map((it) => it.findings.map((f) => f.id).join('+'));
  assert.deepEqual(ids, ['SEC-6', 'SEC-1+SEC-2+SEC-3', 'SEC-4', 'SEC-5'], 'P0 first; never more than 3 findings; a dependency stands alone; priorities are not mixed');
  assert.equal(b.items[0].confirm_first[0].id, 'SEC-6', 'a suspected critical starts by confirming it');
  assert.equal(b.items.find((it) => it.findings[0].id === 'SEC-5').path, 'full', 'a dependency change is always the full path');
});

test('audit: a task inherits the urgency of what waits for it; cycles are rejected', () => {
  const slow = finding('GAP-1', { area: 'db-layer', severity: 'low', files: ['src/db.mjs'], location: 'src/db.mjs#pool' });
  const fast = finding('REV-1', { area: 'payouts', severity: 'high', proof: 'confirmed', attacker: 'authenticated', files: ['src/p.mjs'], location: 'src/p.mjs#payout', evidence: 'x' });
  const data = (deps) => ({
    inventory: inventory(),
    findings: { security: securityFile([]), logic_money: lensFile('logic_money', [fast]), gaps: lensFile('gaps', [slow]) },
    challenges: { auditor: { reviews: [], dependencies: deps, missed: [] } },
    unknowns: [],
  });
  const b = buildBacklog(data([{ finding: 'REV-1', after: 'GAP-1', reason: 'needs the driver change' }]), { agentsMd: true });
  assert.deepEqual(b.items.map((it) => it.findings[0].id), ['GAP-1', 'REV-1']);
  assert.equal(b.items[0].priority, 'P0');
  assert.deepEqual(b.items[0].promoted, { from: 'P3', because: 'B-02' });
  assert.throws(() => buildBacklog(data([{ finding: 'REV-1', after: 'GAP-1', reason: 'a' }, { finding: 'GAP-1', after: 'REV-1', reason: 'b' }]), { agentsMd: true }), /cycle/);
});

test('audit: duplicates merge into one finding with the higher severity; disputes are flagged, not applied', () => {
  const a = finding('SEC-1', { severity: 'medium', files: ['src/a.mjs'] });
  const b = finding('REV-1', { severity: 'high', proof: 'confirmed', evidence: 'x', files: ['src/b.mjs'], location: 'src/b.mjs#b' });
  const c = finding('GAP-1', { area: 'export', severity: 'high', to_confirm: 'x', files: ['src/c.mjs'], location: 'src/c.mjs#c' });
  const data = {
    inventory: inventory(),
    findings: { security: securityFile([a]), logic_money: lensFile('logic_money', [b]), gaps: lensFile('gaps', [c]) },
    challenges: {
      reviewer: { reviews: [{ finding: 'SEC-1', verdict: 'duplicate', duplicate_of: 'REV-1', reason: 'same race' }, { finding: 'GAP-1', verdict: 'disputed', reason: 'export only', checks: checks({ reachable: 'no' }), proposed_severity: 'low' }], missed: [] },
    },
    unknowns: [],
  };
  const bl = buildBacklog(data, { agentsMd: false });
  assert.equal(bl.items[0].governance, 'agents_md', 'without AGENTS.md, project rules come first');
  const rev = bl.items.find((it) => it.findings.some((f) => f.id === 'REV-1'));
  assert.deepEqual(rev.findings[0].merged, ['SEC-1']);
  assert.deepEqual(rev.files, ['src/a.mjs', 'src/b.mjs']);
  const gap = bl.items.find((it) => it.findings.some((f) => f.id === 'GAP-1'));
  assert.equal(gap.findings[0].severity, 'high', 'only the owner lowers a severity');
  assert.equal(bl.disputed[0].proposed_severity, 'low');
});

// ------------------------------------------------------------------------------------------- lifecycle

test('audit lifecycle: inventory → findings → challenge → backlog → gate A → a task from the backlog', () => {
  const root = auditProject();

  // An audit has no path, and the guard keeps it out of the code from the first phase.
  assert.notEqual(phase(root, 'new', 'x', '--kind', 'audit', '--path', 'light').code, 0);
  assert.equal(phase(root, 'new', 'تدقيق شامل', '--kind', 'audit').code, 0);
  assert.equal(task(root).kind, 'audit');
  write(root, `${T}/REQUEST.md`, 'دقق المشروع واستخرج النواقص.\n');
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'INVENTORY');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, 'src/a.mjs') }).decision, 'deny');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, `${T}/INVENTORY.json`) }).decision, 'allow');

  // INVENTORY needs a verify run (scanner evidence) and evidence-backed facts.
  write(root, `${T}/INVENTORY.json`, J(inventory()));
  let r = phase(root, 'next');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /verify/);
  assert.equal(verify(root).code, 0, 'an audit verify passes: it changed nothing');
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'FINDINGS');

  // Every unguarded entry point must be examined: here EP-2 (an admin action with an UNKNOWN check).
  writeFindings(root);
  const sec = JSON.parse(read(root, `${T}/findings/security.json`));
  write(root, `${T}/findings/security.json`, J({ ...sec, findings: [] }));
  r = phase(root, 'next');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /EP-2/);
  writeFindings(root);
  assert.equal(guard(root, 'run_command', { CommandLine: 'curl -s https://victim.example/api' }).decision, 'deny', 'audit proofs run on localhost only');
  r = phase(root, 'next');
  assert.equal(r.code, 0, r.out);
  assert.equal(task(root).phase, 'CHALLENGE');

  // Every finding is challenged by a role that did not write it.
  writeChallenges(root);
  const byRev = JSON.parse(read(root, `${T}/challenge/by-reviewer.json`));
  write(root, `${T}/challenge/by-reviewer.json`, J({ ...byRev, reviews: byRev.reviews.slice(0, 1) }));
  r = phase(root, 'next');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not challenged yet: GAP-1/);
  writeChallenges(root);
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'BACKLOG');

  // The backlog is generated; only the tech-manager section is written by hand.
  r = backlog(root);
  assert.equal(r.code, 0, r.out);
  const bj = JSON.parse(read(root, `${T}/BACKLOG.json`));
  assert.deepEqual(
    bj.items.map((it) => `${it.id}:${it.findings.map((f) => f.id).join('+') || it.governance}`),
    ['B-01:agents_md', 'B-02:GAP-1', 'B-03:REV-1', 'B-04:SEC-1', 'B-05:MA-1'],
  );
  const b3 = bj.items.find((it) => it.id === 'B-03');
  assert.equal(b3.path, 'full', 'src/payment.mjs is a sensitive path');
  assert.deepEqual(b3.depends_on.map((d) => `${d.item}:${d.type}`), ['B-01:governance', 'B-02:logical']);
  assert.equal(bj.items.find((it) => it.id === 'B-02').priority, 'P0', 'the driver change is promoted to the urgency of the payout lock');
  assert.equal(guard(root, 'write_to_file', { TargetFile: join(root, `${T}/BACKLOG.json`) }).decision, 'deny', 'tool-owned');
  const req = read(root, `${T}/requests/B-03.md`);
  assert.match(req, /sat:from-backlog TASK-001 B-03/);
  assert.match(req, /اقتراحات غير ملزمة/);
  assert.match(req, /Who absorbs a rounding remainder/);
  const md = read(root, `${T}/BACKLOG.md`);
  assert.match(md, /MA-1/);
  assert.match(md, /mass_assignment_data_exposure/, 'what was not tested is listed');
  assert.notEqual(phase(root, 'next').code, 0, 'the tech-manager section must be written first');
  write(root, `${T}/BACKLOG.md`, md.replace(/(<!-- sat:tm-risk:begin -->)[\s\S]*?(<!-- sat:tm-risk:end -->)/, '$1\nأبدأ بـ B-01 ثم B-02: قفل السحب ينتظر تغيير المشغّل.\n$2'));
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root).phase, 'GATE_A');
  assert.equal(git(root, 'status', '--porcelain', '--', '.team/tasks'), '', 'the tool committed the audit folder at Gate A');
  // Gate A closes when the owner merges the audit PR: no phrase closes it, and nothing is recorded.
  const byPhrase = phase(root, 'approve', 'GATE_A', '--decision', 'approve', '--note', 'اعتمد القائمة');
  assert.notEqual(byPhrase.code, 0);
  assert.match(byPhrase.out, /merging is the approval/);
  assert.equal(task(root).phase, 'GATE_A');
  assert.equal(JSON.parse(phase(root, 'status', '--json').stdout).required_reply, null);

  // After the audit PR is merged, a backlog item opens a task with its request ready, and the audit closes.
  const branch = task(root).branch;
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge audit', branch);
  r = phase(root, 'new', '--from', 'TASK-001:B-03', '--path', 'light');
  assert.notEqual(r.code, 0, 'a full-path item cannot be downgraded');
  r = phase(root, 'new', '--from', 'TASK-001:B-03');
  assert.equal(r.code, 0, `NEWFROM ${r.out}`);
  assert.match(r.out, /depends on B-02/);
  assert.match(r.out, /depends on B-01/, 'AGENTS.md is still missing');
  const t2 = task(root, 'TASK-002');
  assert.equal(t2.path, 'full');
  assert.deepEqual(t2.source, { audit: 'TASK-001', item: 'B-03' });
  assert.match(read(root, '.team/tasks/TASK-002/REQUEST.md'), /REV-1/);
  assert.equal(task(root, 'TASK-001').phase, 'CLOSED', 'the merged audit is closed by the next task');
  assert.equal(phase(root, 'next').code, 0);
  assert.equal(task(root, 'TASK-002').phase, 'INTERPRET');

  // Once the items it waits for are delivered (merged into the base branch), the warnings go away.
  assert.equal(phase(root, 'cancel', '--note', 'test only').code, 0);
  git(root, 'checkout', '-q', 'main');
  rmSync(join(root, '.team/tasks/TASK-002'), { recursive: true, force: true });
  write(root, 'AGENTS.md', '# Project rules\n');
  write(root, '.team/tasks/TASK-009/task.json', J({ id: 'TASK-009', kind: 'change', path: 'full', source: { audit: 'TASK-001', item: 'B-02' }, phase: 'GATE_2' }));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'delivered B-01 and B-02');
  r = phase(root, 'new', '--from', 'TASK-001:B-03');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /depends on/);
});

test('audit: an audit that changes code fails verify and cannot move on', () => {
  const root = auditProject();
  toFindings(root);
  write(root, 'src/a.mjs', 'export const a = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'sneaky fix');
  const v = verify(root);
  assert.notEqual(v.code, 0);
  assert.match(v.out, /audit_read_only/);
  writeFindings(root);
  const r = phase(root, 'next');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /changes nothing outside/);
  assert.ok(!existsSync(join(root, `${T}/BACKLOG.json`)));
});

test('audit: merging the base branch into the audit (e.g. a SAT update) is not counted as the audit changing code', () => {
  const root = auditProject();
  toFindings(root);
  const branch = task(root).branch;
  git(root, 'checkout', '-q', 'main');
  write(root, 'src/a.mjs', 'export const a = 3;\n');
  git(root, 'add', 'src/a.mjs');
  git(root, 'commit', '-qm', 'hotfix on main');
  git(root, 'checkout', '-q', branch);
  git(root, 'merge', '-q', '--no-edit', 'main');
  writeFindings(root);
  const r = phase(root, 'next');
  assert.equal(r.code, 0, r.out);
});

test('audit: scanner findings are audit input, and each one must be triaged', () => {
  const root = auditProject();
  write(root, 'tools/fake-audit.mjs', "console.log('1 high severity vulnerability');\nprocess.exit(1);\n");
  write(root, '.team/project.yaml', read(root, '.team/project.yaml').replace(/    dependencies: null/, '    dependencies: node tools/fake-audit.mjs'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'scanner');
  toFindings(root);
  assert.equal(task(root).last_verify.result, 'pass', 'a scanner that reports debt does not fail an audit verify');
  writeFindings(root);
  let r = phase(root, 'next');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /dependencies scanner reported something/);
  const sec = JSON.parse(read(root, `${T}/findings/security.json`));
  sec.scanner_triage = [{ step: 'dependencies', tool: 'npm', classification: 'not_reachable', reason: 'The vulnerable parser is only used for export; no file is read.' }];
  write(root, `${T}/findings/security.json`, J(sec));
  r = phase(root, 'next');
  assert.equal(r.code, 0, r.out);
});

test('audit: the shipped templates satisfy the validators', async () => {
  const { readFileSync } = await import('node:fs');
  const { SAT_ROOT } = await import('./helpers.mjs');
  const { validateFindingsFile, validateChallengeFile } = await import('../core/bin/lib/audit.mjs');
  const tpl = (n) => JSON.parse(readFileSync(join(SAT_ROOT, 'core', 'templates', n), 'utf8'));
  const inv = validateInventory(tpl('INVENTORY.json'), { taskId: 'TASK-001' });
  assert.deepEqual(inv.errors, []);
  const ctx = { taskId: 'TASK-001', profile: 'web', envIds: inv.envIds, epIds: new Set([...inv.eps.map((p) => p.id), 'EP-4']) };
  assert.deepEqual(validateFindingsFile('security', tpl('FINDINGS.json'), ctx), []);
  const ch = validateChallengeFile('reviewer', tpl('CHALLENGE.json'), { ...ctx, assigned: ['SEC-1', 'SEC-2', 'GAP-3'], allIds: ['SEC-1', 'SEC-2', 'GAP-3', 'SEC-5', 'GAP-7', 'REV-2', 'GAP-1'] });
  assert.deepEqual(ch, []);
});

test('audit: installed projects route audit requests to an audit task', () => {
  const root = makeProject();
  assert.match(read(root, '.agents/rules/marwan-sat.md'), /--kind audit/);
  assert.match(read(root, '.agents/agents/marwan-sat-tech-manager.md'), /never answer them yourself/);
  assert.match(read(root, '.team/sensitive-paths.txt'), /\*\*\/\*payout\*/);
  assert.ok(existsSync(join(root, '.team/bin/backlog.mjs')));
  assert.ok(existsSync(join(root, '.team/templates/FINDINGS.json')));
});
