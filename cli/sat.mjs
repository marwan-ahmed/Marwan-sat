#!/usr/bin/env node
// Marwan SAT — the `sat` command: install the agent team in a project and keep it up to date.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, STACKS } from '../core/bin/lib/config.mjs';
import { readLock } from '../core/bin/lib/scope.mjs';
import { closeMergedTasks, closurePaths, commitPaths, DeliveryError, openPullRequest, prepareBase, pushBranch, UPDATE_BRANCH_PREFIX } from '../core/bin/lib/delivery.mjs';
import { currentBranch, git, porcelainFiles } from '../core/bin/lib/git.mjs';
import { phraseMatches } from '../core/bin/lib/plain.mjs';
import { readState, writeState } from '../core/bin/lib/state.mjs';
import { detectBaseBranch, detectName, detectPackageManager, detectStack, pmCommands } from './lib/detect.mjs';
import { doctor } from './lib/doctor.mjs';
import { satCommand } from './lib/invoke.mjs';
import {
  buildLock,
  currentTrackedHash,
  ensureGitignore,
  generatedFiles,
  locallyModified,
  managedFiles,
  removeStale,
  renderPreset,
  SAT_PATHS,
  satVersion,
  trackedHash,
  writeFiles,
  writeLock,
} from './lib/install.mjs';

const SAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Printed in every "run this next" hint, so the hint matches how this run was started (npx, npm link or node).
const SAT = satCommand(SAT_ROOT, satVersion(SAT_ROOT));

const HELP = `Marwan SAT — Marwan Software Agents Team

Usage:
  sat init [--stack nextjs|laravel|flutter|react-native|custom] [--platform antigravity] [--name <name>] [--audience simple|developer] [--dir <path>]
      Installs the team in the project: .team/, project.yaml, the Antigravity files and the CI workflow.
  sat doctor [--quick] [--dir <path>]
      Checks readiness and runs the project.yaml commands (--quick only checks that the tools exist).
  sat update --check [--dir <path>]
      Says what is new between the installed version and this one. Changes nothing.
  sat update --approve "<owner's reply>" [--force] [--major] [--dir <path>]
      The owner's team update («نفّذ التحديث»): from an up-to-date main branch, on a branch of its own, it updates,
      commits, pushes and opens the pull request. The owner presses Merge.
  sat update [--force] [--major] [--dir <path>]
      Updates the managed and generated files in place (developers; never on a task branch). Never touches project files.
  sat regenerate [--force] [--dir <path>]
      Regenerates the platform and CI files after you edit project.yaml.
  sat version

After installing, day-to-day work from inside the project:
  node .team/bin/phase.mjs status | new | next | approve | ship | goto | escalate | resume | cancel
  node .team/bin/verify.mjs
  node .team/bin/report.mjs
Reference: .team/CHARTER.md`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      opts[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else pos.push(a);
  }
  return { pos, opts };
}

class CliError extends Error {}
const fail = (m) => {
  throw new CliError(m);
};

function cmdInit(root, opts) {
  if (existsSync(join(root, '.team', 'project.yaml'))) fail(`SAT is already installed in this project. Use: ${SAT} update or ${SAT} regenerate`);
  const stack = opts.stack || detectStack(root);
  if (!stack) fail(`Could not detect the stack. Set it with: --stack ${STACKS.join('|')}`);
  if (!STACKS.includes(stack)) fail(`Unsupported stack: ${stack}`);
  const platform = opts.platform || 'antigravity';
  if (platform !== 'antigravity') fail(`Platform ${platform} is planned for a later release. This version supports antigravity.`);
  const audience = opts.audience || 'simple';
  if (!['simple', 'developer'].includes(audience)) fail('--audience must be simple (the owner does not program) or developer');
  const pm = detectPackageManager(root);
  const pmc = pmCommands(pm);
  const version = satVersion(SAT_ROOT);
  const vars = {
    sat_version: version,
    name: String(opts.name || detectName(root)).replace(/["\\]/g, ''),
    platform,
    audience,
    base_branch: detectBaseBranch(root),
    pm_install: pmc.install,
    pm_run: pmc.run,
    pm_exec: pmc.exec,
    pm_audit: pmc.audit,
  };
  const yaml = renderPreset(SAT_ROOT, stack, vars);
  mkdirSync(join(root, '.team'), { recursive: true });
  writeFileSync(join(root, '.team', 'project.yaml'), yaml, 'utf8');
  const cfg = loadProject(root);

  const managed = managedFiles(SAT_ROOT, stack);
  const generated = generatedFiles(SAT_ROOT, cfg, root);
  writeFiles(root, { ...managed, ...generated });

  const decisions = join(root, '.team', 'DECISIONS.md');
  if (!existsSync(decisions))
    writeFileSync(decisions, `# سجل القرارات — ${vars.name}\n\n> ملك المشروع. يضيف المعماري قرارات العمارة (ADR)، وتُسجَّل هنا قرارات قبول المخاطر بنص صاحب القرار. القالب: \`.team/templates/DECISION.md\`.\n`, 'utf8');
  const seed = join(root, '.team', 'seed', 'README.md');
  if (!existsSync(seed)) {
    mkdirSync(dirname(seed), { recursive: true });
    writeFileSync(seed, '# البيانات الاصطناعية للاختبار والهجوم\n\nضع هنا بيانات اصطناعية فقط: مستأجران على الأقل، ومستخدمون بأدوار مختلفة. ممنوع أي بيانات عملاء حقيقية أو نسخ من الإنتاج.\n', 'utf8');
  }
  const keep = join(root, '.team', 'tasks', '.gitkeep');
  if (!existsSync(keep)) {
    mkdirSync(dirname(keep), { recursive: true });
    writeFileSync(keep, '', 'utf8');
  }
  appendFileSync(join(root, '.team', 'LEDGER.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type: 'sat_installed', version, stack, platform })}\n`, 'utf8');
  ensureGitignore(root);
  writeLock(root, buildLock(SAT_ROOT, stack, platform, managed, generated));

  console.log(`[SAT] ✓ Installed Marwan SAT ${version} (stack: ${stack}, platform: ${platform}, package manager: ${pm}).`);
  console.log(`[SAT]   ${Object.keys(managed).length} managed files, ${Object.keys(generated).length} generated files.`);
  console.log('[SAT] Next steps:');
  console.log('  1) Review .team/project.yaml (commands, paths, security profile, attack environment).');
  console.log(`  2) Run: ${SAT} doctor`);
  console.log('  3) Commit only the SAT files (keep your own changes in a separate commit):');
  console.log(`       git add ${SAT_PATHS.join(' ')}`);
  console.log(`       git commit -m "chore: install Marwan SAT ${version}"`);
  console.log('  4) Protect the main branch on GitHub: "Require a pull request before merging" and "Do not allow bypassing the above settings"');
  console.log('     (a private repository needs GitHub Pro). doctor verifies it through gh and is NOT READY until it can.');
  console.log('  5) Start in the Antigravity app: pick the marwan-sat-tech-manager agent (in the model menu) and send "New task: <your request>" (Arabic works too).');
  if (!existsSync(join(root, 'AGENTS.md'))) console.log('  ! No AGENTS.md: consider adding one for project-specific rules (for example from the arabic-agents template).');
}

const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

// The CHANGELOG sections newer than <from>, up to this version: their first paragraph, for the owner.
function changesSince(from, to) {
  const p = join(SAT_ROOT, 'CHANGELOG.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/^## \[/m)
    .slice(1)
    .map((part) => ({ version: part.slice(0, part.indexOf(']')), body: part.slice(part.indexOf('\n') + 1).trim() }))
    .filter((x) => cmpVersion(x.version, from) > 0 && cmpVersion(x.version, to) <= 0)
    .map((x) => ({ version: x.version, summary: x.body.split(/\n\s*\n/)[0].trim() }));
}

function updatePreconditions(root, lock, version, opts) {
  const major = (v) => Number(String(v).split('.')[0]);
  if (major(version) > major(lock.sat_version) && !opts.major) fail(`Moving from ${lock.sat_version} to ${version} is a major upgrade and may break compatibility. Read the CHANGELOG, then rerun with --major.`);
  const modified = locallyModified(root, lock);
  if (modified.length && !opts.force)
    fail(`Managed or generated files were edited locally, so they will not be overwritten:\n- ${modified.join('\n- ')}\nMove your edits into the SAT repository (or into project.yaml / AGENTS.md), then rerun. To overwrite them: --force`);
}

// Write the new managed and generated files, the lock, .gitignore and the ledger line.
function applyUpdate(root, cfg, lock, version) {
  const managed = managedFiles(SAT_ROOT, cfg.project.stack);
  const generated = generatedFiles(SAT_ROOT, cfg, root);
  const changed = [...Object.entries(managed), ...Object.entries(generated)].filter(([rel, text]) => currentTrackedHash(root, rel) !== trackedHash(rel, text)).map(([rel]) => rel);
  const removed = removeStale(root, lock, managed, generated);
  writeFiles(root, { ...managed, ...generated });
  writeLock(root, buildLock(SAT_ROOT, cfg.project.stack, cfg.project.platform, managed, generated));
  ensureGitignore(root);
  appendFileSync(join(root, '.team', 'LEDGER.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type: 'sat_updated', from: lock.sat_version, to: version })}\n`, 'utf8');
  console.log(`[SAT] ✓ Updated SAT from ${lock.sat_version} to ${version}: ${changed.length} files changed, ${removed.length} removed.`);
  for (const r of changed) console.log(`  ~ ${r}`);
  for (const r of removed) console.log(`  - ${r}`);
  return { changed, removed };
}

function updateCheck(root, cfg, lock, version) {
  const cmp = cmpVersion(version, lock.sat_version);
  if (cmp === 0) return console.log(`[SAT] The team is up to date (${version}). Nothing to update.`);
  if (cmp < 0) return console.log(`[SAT] The installed version (${lock.sat_version}) is newer than this one (${version}). Nothing to update.`);
  console.log(`[SAT] Installed: ${lock.sat_version} · available: ${version}`);
  console.log('[SAT] What is new (CHANGELOG.md, in Arabic — tell the owner in plain words):');
  for (const c of changesSince(lock.sat_version, version)) console.log(`  ${c.version} — ${c.summary.replace(/\s*\n\s*/g, ' ')}`);
  console.log(`[SAT] The update changes only the team's files (never your program). The owner approves it by replying exactly «${cfg.gates.phrases.update}». Then run:`);
  console.log(`       ${SAT} update --approve "<the owner's reply, verbatim>"`);
  return undefined;
}

// The owner's team update: one approval, then everything on a branch of its own, and a pull request.
function updateApproved(root, cfg, lock, version, opts) {
  const reply = typeof opts.approve === 'string' ? opts.approve : '';
  if (!phraseMatches(reply, cfg.gates.phrases.update))
    fail(`This reply does not approve the team update. The owner must reply exactly: «${cfg.gates.phrases.update}». Nothing was changed.`);
  const dirty = porcelainFiles(root).filter((f) => !f.startsWith('.team/LEDGER.jsonl'));
  if (dirty.length) fail(`The working tree is not clean. Commit or stash first:\n- ${dirty.slice(0, 20).join('\n- ')}`);
  let toClose = [];
  try {
    ({ toClose } = prepareBase(root, cfg));
  } catch (e) {
    if (e instanceof DeliveryError) fail(e.message);
    throw e;
  }
  const st = readState(root) || {};
  if (st.active_task) fail(`Task ${st.active_task} is still active. The team is updated between tasks: finish or cancel it first.`);
  if (currentBranch(root) !== cfg.git.base_branch) fail(`Switch to ${cfg.git.base_branch} first: the team is updated from the main branch.`);
  const fresh = loadProject(root);
  const current = readLock(root);
  if (cmpVersion(version, current.sat_version) <= 0) return console.log(`[SAT] The team is already at ${current.sat_version}. Nothing to update.`);
  updatePreconditions(root, current, version, opts);
  const branch = `${UPDATE_BRANCH_PREFIX}${version}`;
  const closed = closeMergedTasks(root, toClose);
  for (const c of closed) console.log(`[SAT] ${c.id} closed: the owner merged it on GitHub.`);
  git(['checkout', '-q', '-B', branch], root);
  applyUpdate(root, fresh, current, version);
  commitPaths(root, [...SAT_PATHS, ...closurePaths(closed)], `chore: update Marwan SAT to ${version}`);
  const push = pushBranch(root, branch);
  let pr = null;
  if (push.ok) {
    pr = openPullRequest(root, {
      base: fresh.git.base_branch,
      branch,
      title: `chore: update Marwan SAT to ${version}`,
      body: `Marwan SAT ${current.sat_version} → ${version}. Only the team's files change (.team, .agents, the SAT workflow). Approved by the owner: «${reply}».\n\nMerging this pull request applies the update.`,
    });
  }
  writeState(root, { ...(readState(root) || {}), pending_update: { branch, from: current.sat_version, version, pr: pr && pr.url, approved: reply, at: new Date().toISOString() } });
  if (!push.ok) return console.log(`[SAT] ! Committed on ${branch}, not pushed: ${push.why}`);
  if (pr && pr.how === 'gh') console.log(`[SAT] Pull request: ${pr.url}`);
  else if (pr && pr.url) console.log(`[SAT] Pull request link (the owner presses "Create pull request" once, then Merge): ${pr.url}`);
  else console.log('[SAT] Pushed. The remote is not GitHub: open the pull request on your Git host.');
  console.log('[SAT] Next: the owner presses Merge. Then start a new conversation with the tech manager, so the team reads its new instructions.');
  return undefined;
}

function cmdUpdate(root, opts) {
  const lock = readLock(root);
  if (!lock) fail(`SAT is not installed here (sat.lock is missing). Use: ${SAT} init`);
  const cfg = loadProject(root);
  const version = satVersion(SAT_ROOT);
  if (opts.check) return updateCheck(root, cfg, lock, version);
  if (opts.approve !== undefined) return updateApproved(root, cfg, lock, version, opts);
  const cur = currentBranch(root);
  if (cur && cur.startsWith(cfg.git.task_branch_prefix))
    fail(`You are on a task branch (${cur}). The team is updated on ${cfg.git.base_branch}, between tasks — or ask the tech manager: «حدّث الفريق».`);
  updatePreconditions(root, lock, version, opts);
  applyUpdate(root, cfg, lock, version);
  console.log(`[SAT] project.yaml, DECISIONS.md and the tasks were not touched. Run: ${SAT} doctor`);
  console.log('[SAT] Then commit only the SAT files:');
  console.log(`       git add ${SAT_PATHS.join(' ')}`);
  console.log(`       git commit -m "chore: update Marwan SAT to ${version}"`);
  return undefined;
}

function cmdRegenerate(root, opts) {
  const lock = readLock(root);
  if (!lock) fail('SAT is not installed here.');
  const cfg = loadProject(root);
  const modified = Object.entries(lock.generated || {})
    .filter(([rel, hash]) => {
      const now = currentTrackedHash(root, rel);
      return now !== null && now !== hash;
    })
    .map(([rel]) => rel);
  if (modified.length && !opts.force) fail(`Generated files were edited by hand:\n- ${modified.join('\n- ')}\nTo overwrite them: --force`);
  const generated = generatedFiles(SAT_ROOT, cfg, root);
  removeStale(root, { managed: {}, generated: lock.generated }, {}, generated);
  writeFiles(root, generated);
  const managedLock = lock.managed;
  const next = buildLock(SAT_ROOT, cfg.project.stack, cfg.project.platform, {}, generated);
  next.managed = managedLock;
  next.sat_version = lock.sat_version;
  writeLock(root, next);
  console.log(`[SAT] ✓ Regenerated ${Object.keys(generated).length} files.`);
  if (lock.stack !== cfg.project.stack) console.log(`[SAT] ! The stack changed in project.yaml: run ${SAT} update to refresh the sensitive paths.`);
}

function cmdDoctor(root, opts) {
  const results = doctor({ root, satRoot: SAT_ROOT, run: !opts.quick });
  const icon = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.title}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n[SAT] Verdict: ${fails ? 'NOT READY' : 'READY'} (${fails} blocking, ${warns} warnings).`);
  process.exitCode = fails ? 1 : 0;
}

function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const root = resolve(typeof opts.dir === 'string' ? opts.dir : process.cwd());
  switch (cmd) {
    case 'init':
      return cmdInit(root, opts);
    case 'update':
      return cmdUpdate(root, opts);
    case 'regenerate':
      return cmdRegenerate(root, opts);
    case 'doctor':
      return cmdDoctor(root, opts);
    case 'version':
    case '--version':
      return console.log(satVersion(SAT_ROOT));
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
  return undefined;
}

try {
  main();
} catch (e) {
  console.error(`[SAT] ✗ ${e.message}`);
  process.exitCode = e instanceof CliError ? 2 : 1;
}
