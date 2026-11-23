// Shared helpers for Marwan SAT's own tests: build a throwaway git project and drive the tools.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT; // nested `node --test` must behave like a top-level run
// The tools under test simulate a developer's machine. GitHub Actions sets CI=true (and GITHUB_*),
// which switches verify to CI mode (no task recording, mandatory scanners). Tests that need CI mode pass --ci.
delete ENV.CI;
for (const k of Object.keys(ENV)) if (k.startsWith('GITHUB_')) delete ENV[k];

export function sh(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: ENV });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

export function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
}

export function read(root, rel) {
  return readFileSync(join(root, rel), 'utf8');
}

export function git(root, ...args) {
  const r = sh('git', args, root);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.out}`);
  return r.stdout.trim();
}

// A minimal "custom" project with a passing lint and node's built-in test runner.
export function makeProject({ stack = 'custom' } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'sat-')), 'proj');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'sat@test');
  git(root, 'config', 'user.name', 'sat');
  write(root, 'package.json', '{"name":"demo-app","scripts":{"test":"node --test"}}\n');
  write(root, 'src/a.mjs', 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const init = sh('node', [join(SAT_ROOT, 'cli', 'sat.mjs'), 'init', '--stack', stack], root);
  if (init.code !== 0) throw new Error(init.out);
  let y = read(root, '.team/project.yaml');
  y = y
    .replace('  test: null', '  test: node --test')
    .replace('  lint: null', '  lint: node -e "process.exit(0)"')
    .replace(/    secrets: .*/, '    secrets: null')
    .replace(/    sast: .*/, '    sast: null')
    .replace(/    dependencies: .*/, '    dependencies: null');
  write(root, '.team/project.yaml', y);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'install SAT');
  return root;
}

export const phase = (root, ...args) => sh('node', ['.team/bin/phase.mjs', ...args], root);
export const verify = (root, ...args) => sh('node', ['.team/bin/verify.mjs', ...args], root);
export const report = (root) => sh('node', ['.team/bin/report.mjs'], root);
export const satCli = (root, ...args) => sh('node', [join(SAT_ROOT, 'cli', 'sat.mjs'), ...args], root);

export function guard(root, name, args) {
  const r = sh('node', ['.team/bin/guard.mjs'], root, JSON.stringify({ toolCall: { name, args }, workspacePaths: [root] }));
  return JSON.parse(r.stdout);
}

export function task(root, id = 'TASK-001') {
  return JSON.parse(read(root, `.team/tasks/${id}/task.json`));
}

export const T = '.team/tasks/TASK-001';

export function execPrompt({ blocking = 0, sensitive = 0, path = 'full' } = {}) {
  return `---\ntask: TASK-001\nround: 1\nblocking_questions: ${blocking}\nsensitive_assumptions: ${sensitive}\nproposed_path: ${path}\n---\n# البرومبت التنفيذي\n## 1. الهدف\nحساب أيام التأخير.\n`;
}

// Drives a full-path task up to the start of IMPLEMENT (tests frozen).
// Gate 1 (the plan) and the start gate are two separate replies from the owner, each checked word for word.
export function approvePlanAndStart(root) {
  const a = phase(root, 'approve', 'GATE_1', '--decision', 'approve', '--note', 'اعتمد الخطة');
  if (a.code !== 0) throw new Error(a.out);
  const b = phase(root, 'approve', 'GATE_START', '--decision', 'approve', '--note', 'ابدأ التنفيذ');
  if (b.code !== 0) throw new Error(b.out);
}

// Everything up to Gate 1 (the plan), on the full path: TASKS.json is written, nothing in the project changed.
export function toGate1(root) {
  phase(root, 'new', 'late days', '--path', 'full');
  write(root, `${T}/REQUEST.md`, 'أريد حساب أيام التأخير.\n');
  phase(root, 'next');
  write(root, `${T}/EXEC_PROMPT.md`, execPrompt());
  phase(root, 'next');
  write(root, `${T}/SPEC.md`, '# SPEC\n- **AC-1** (← EXEC §1, R1): Given due 2026-01-01, when today 2026-01-15, then late_days = 14\n');
  write(root, `${T}/ARCH.md`, '# ARCH\nA pure function lateDays(due, today) in src/late.mjs. No schema change, no entry point.\n');
  write(root, `${T}/PLAN.md`, '# PLAN\n| T1 | late days | AC-1 | — | src/late.mjs | test passes |\n');
  phase(root, 'next');
  write(root, `${T}/THREAT_MODEL.md`, '# THREAT\nNO-ABUSE-CASES: pure function without entry point\n');
  phase(root, 'next');
  write(
    root,
    `${T}/TASKS.json`,
    JSON.stringify({ task_id: 'TASK-001', path: 'full', items: [{ id: 'T1', title: 'late days', acceptance: ['AC-1'], abuse_cases: [], allowed_write: ['src/late.mjs'] }] }),
  );
}

export function toImplement(root) {
  toGate1(root);
  approvePlanAndStart(root);
  write(root, 'tests/late.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('AC-1: late days', async () => {\n  const { lateDays } = await import('../src/late.mjs');\n  assert.equal(lateDays('2026-01-01', '2026-01-15'), 14);\n});\n");
  write(root, `${T}/TRACE.md`, '| AC-1 | tests/late.test.mjs | AC-1: late days | red | |\n');
  const r = phase(root, 'next');
  if (r.code !== 0) throw new Error(r.out);
}

export function implementCorrectly(root) {
  write(root, 'src/late.mjs', 'export function lateDays(d, t) {\n  return Math.round((Date.parse(t) - Date.parse(d)) / 864e5);\n}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'feat: late days');
}
