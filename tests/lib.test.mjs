import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkSpecTrace, validateAudit, validateReview, validateTasks } from '../core/bin/lib/contracts.mjs';
import { matchGlob, parsePathList } from '../core/bin/lib/glob.mjs';
import { parseFrontmatter, parseYaml } from '../core/bin/lib/yaml.mjs';

test('yaml: maps, lists, inline lists, comments, scalars', () => {
  const v = parseYaml(`# head
a: 1
b: "x # not a comment"   # trailing
c:
  d: true
  e: null
  f: [one, "two, three", 3]
g:
  - x
  - y
h:
  - name: n1
    v: 2.5
  - name: n2
quoted: 'it''s'
`);
  assert.deepEqual(v, {
    a: 1,
    b: 'x # not a comment',
    c: { d: true, e: null, f: ['one', 'two, three', 3] },
    g: ['x', 'y'],
    h: [{ name: 'n1', v: 2.5 }, { name: 'n2' }],
    quoted: "it's",
  });
});

test('yaml: unsupported syntax fails loudly', () => {
  assert.throws(() => parseYaml('a: |\n  text\n'), /block scalars/);
  assert.throws(() => parseYaml('a: &x 1\n'), /anchors/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tabs/);
});

test('yaml: front matter', () => {
  const { data, body } = parseFrontmatter('---\nblocking_questions: 2\nproposed_path: light\n---\n# Body\n');
  assert.equal(data.blocking_questions, 2);
  assert.equal(data.proposed_path, 'light');
  assert.equal(body.trim(), '# Body');
});

test('glob: gitignore-like semantics', () => {
  assert.ok(matchGlob('src/a.test.ts', '**/*.test.*'));
  assert.ok(matchGlob('a.test.ts', '**/*.test.*'));
  assert.ok(matchGlob('sub/package.json', 'package.json'));
  assert.ok(matchGlob('app/.env.local', '.env*'));
  assert.ok(matchGlob('src/app/api/x/route.ts', '**/app/api/**'));
  assert.ok(!matchGlob('src/app/api/x.ts', 'app/api/**'));
  assert.ok(matchGlob('.team/tasks/TASK-001/task.json', '.team/tasks/*/task.json'));
  assert.ok(matchGlob('SRC\\Payments\\x.ts', '**/*payment*/**'), 'case-insensitive and backslash-tolerant');
  assert.ok(matchGlob('src/lib/PaymentService.ts', '**/*payment*'));
});

test('sensitive paths: auth files count, not only auth/ folders, and apps in a subfolder are covered', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const { globs } = parsePathList(`${read('stacks/common/sensitive-paths.txt')}\n${read('stacks/nextjs/sensitive-paths.txt')}`);
  const sensitive = (f) => globs.some((g) => matchGlob(f, g));
  for (const f of ['auth.ts', 'client/lib/auth.ts', 'src/auth.config.ts', 'client/app/(auth)/login/page.tsx', 'lib/session.ts', 'client/app/api/otp/route.ts', 'client/proxy.ts', 'client/package.json']) {
    assert.ok(sensitive(f), `${f} must be sensitive`);
  }
  for (const f of ['client/app/about/page.tsx', 'client/components/Footer.tsx', 'README.md']) {
    assert.ok(!sensitive(f), `${f} must stay light-path eligible`);
  }
});

test('glob: path lists with content rules', () => {
  const { globs, contentRules } = parsePathList('# c\napp/api/**\ncontent: ^\\s*["\']use server["\']\n');
  assert.deepEqual(globs, ['app/api/**']);
  assert.ok(contentRules[0].test('"use server";\nexport async function x() {}'));
});

test('contracts: SPEC lines must trace to EXEC_PROMPT', () => {
  assert.equal(checkSpecTrace('- **AC-1** (← EXEC §2.1): Given…').errors.length, 0);
  assert.equal(checkSpecTrace('- **AC-1** (R3): Given…').errors.length, 0);
  assert.equal(checkSpecTrace('- **AC-1**: Given…').errors.length, 1);
  assert.equal(checkSpecTrace('no criteria').errors.length, 1);
});

test('contracts: TASKS.json rejects broad or governance allowed_write', () => {
  const base = { task_id: 'TASK-001', path: 'full', items: [{ id: 'T1', title: 't', acceptance: [], allowed_write: ['src/a.ts'] }] };
  assert.deepEqual(validateTasks(base, 'TASK-001'), []);
  assert.ok(validateTasks({ ...base, items: [{ ...base.items[0], allowed_write: ['**'] }] }, 'TASK-001').length);
  assert.ok(validateTasks({ ...base, items: [{ ...base.items[0], allowed_write: ['.team/bin/phase.mjs'] }] }, 'TASK-001').length);
  assert.ok(validateTasks({ ...base, task_id: 'TASK-002' }, 'TASK-001').length);
});

test('contracts: verdicts must match the findings', () => {
  const blocking = { id: 'REV-01', lens: 'money', severity: 'high', proof: 'confirmed', location: 'a:1', scenario: 's', evidence: 'e', fix: 'f' };
  assert.deepEqual(validateReview({ verdict: 'BLOCKED', findings: [blocking] }), []);
  assert.ok(validateReview({ verdict: 'CLEAR_WITHIN_SCOPE', findings: [blocking] }).length);
  assert.ok(validateReview({ verdict: 'BLOCKED', findings: [] }).length);
  assert.ok(validateReview({ verdict: 'BLOCKED', findings: [{ ...blocking, evidence: undefined }] }).length, 'confirmed needs evidence');
  const audit = { profile: 'web', verdict: 'CLEAR_WITHIN_SCOPE', coverage: [{ axis: 'access_control', status: 'NOT_TESTED' }], findings: [] };
  assert.ok(validateAudit(audit).length, 'NOT_TESTED needs a reason');
  assert.deepEqual(validateAudit({ ...audit, coverage: [{ axis: 'access_control', status: 'NOT_TESTED', reason: 'no env' }] }), []);
  assert.ok(validateAudit({ ...audit, coverage: [{ axis: 'x', status: 'TESTED_DYNAMIC' }], summary: 'النظام آمن' }).length, 'no "safe" conclusions');
});
