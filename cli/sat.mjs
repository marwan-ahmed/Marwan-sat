#!/usr/bin/env node
// Marwan SAT — the `sat` command: install the agent team in a project and keep it up to date.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, STACKS } from '../core/bin/lib/config.mjs';
import { readLock } from '../core/bin/lib/scope.mjs';
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
  satVersion,
  trackedHash,
  writeFiles,
  writeLock,
} from './lib/install.mjs';

const SAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Printed in every "run this next" hint, so the hint matches how this run was started (npx, npm link or node).
const SAT = satCommand(SAT_ROOT, satVersion(SAT_ROOT));

const HELP = `Marwan SAT — Marwan Software Agents Team

الاستخدام:
  sat init [--stack nextjs|laravel|flutter|react-native|custom] [--platform antigravity] [--name <الاسم>] [--dir <المسار>]
      يثبّت الفريق في المشروع: .team/ و project.yaml وملفات Antigravity وworkflow الـCI.
  sat doctor [--quick] [--dir <المسار>]
      يفحص الجاهزية ويشغّل أوامر project.yaml (--quick يكتفي بفحص وجود الأدوات).
  sat update [--force] [--major] [--dir <المسار>]
      يحدّث الملفات المُدارة والمولّدة إلى إصدار أداة sat الحالية. لا يلمس ملفات المشروع.
  sat regenerate [--force] [--dir <المسار>]
      يعيد توليد ملفات المنصة وCI بعد تعديل project.yaml.
  sat version

بعد التثبيت، العمل اليومي من داخل المشروع:
  node .team/bin/phase.mjs status | new | next | approve | goto | escalate | resume | cancel
  node .team/bin/verify.mjs
  node .team/bin/report.mjs
المرجع: .team/CHARTER.md`;

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
  if (existsSync(join(root, '.team', 'project.yaml'))) fail(`SAT مثبت في هذا المشروع. استخدم: ${SAT} update أو ${SAT} regenerate`);
  const stack = opts.stack || detectStack(root);
  if (!stack) fail(`تعذّر اكتشاف المكدس. حدده: --stack ${STACKS.join('|')}`);
  if (!STACKS.includes(stack)) fail(`مكدس غير مدعوم: ${stack}`);
  const platform = opts.platform || 'antigravity';
  if (platform !== 'antigravity') fail(`المنصة ${platform} مخطط لها في إصدار لاحق. الإصدار الحالي يدعم antigravity.`);
  const pm = detectPackageManager(root);
  const pmc = pmCommands(pm);
  const version = satVersion(SAT_ROOT);
  const vars = {
    sat_version: version,
    name: String(opts.name || detectName(root)).replace(/["\\]/g, ''),
    platform,
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

  console.log(`[SAT] ✓ ثُبّت Marwan SAT ${version} (المكدس: ${stack}، المنصة: ${platform}، مدير الحزم: ${pm}).`);
  console.log(`[SAT]   ${Object.keys(managed).length} ملفاً مُداراً، ${Object.keys(generated).length} ملفاً مولّداً.`);
  console.log('[SAT] الخطوات التالية:');
  console.log('  1) راجع .team/project.yaml (الأوامر، والمسارات، والملف الأمني، وبيئة الهجوم).');
  console.log(`  2) شغّل: ${SAT} doctor`);
  console.log('  3) اعمل commit لملفات SAT، وفعّل Branch protection على الفرع الرئيسي في GitHub.');
  console.log('  4) ابدأ العمل في Antigravity: اختر الوكيل tech-manager واكتب له: «مهمة جديدة: <طلبك>».');
  if (!existsSync(join(root, 'AGENTS.md'))) console.log('  ! لا يوجد AGENTS.md: يُنصح بإنشائه لقواعد المشروع الخاصة.');
}

function cmdUpdate(root, opts) {
  const lock = readLock(root);
  if (!lock) fail(`SAT غير مثبت هنا (sat.lock مفقود). استخدم: ${SAT} init`);
  const cfg = loadProject(root);
  const version = satVersion(SAT_ROOT);
  const major = (v) => Number(String(v).split('.')[0]);
  if (major(version) > major(lock.sat_version) && !opts.major) fail(`الانتقال من ${lock.sat_version} إلى ${version} إصدار رئيسي قد يكسر التوافق. اقرأ CHANGELOG ثم أعد التشغيل مع --major.`);
  const modified = locallyModified(root, lock);
  if (modified.length && !opts.force)
    fail(`ملفات مُدارة أو مولّدة عُدّلت محلياً، ولن أكتب فوقها:\n- ${modified.join('\n- ')}\nانقل تعديلاتك إلى مستودع SAT (أو إلى project.yaml/AGENTS.md)، ثم أعد التشغيل. للكتابة فوقها: --force`);
  const managed = managedFiles(SAT_ROOT, cfg.project.stack);
  const generated = generatedFiles(SAT_ROOT, cfg, root);
  const changed = [...Object.entries(managed), ...Object.entries(generated)].filter(([rel, text]) => currentTrackedHash(root, rel) !== trackedHash(rel, text)).map(([rel]) => rel);
  const removed = removeStale(root, lock, managed, generated);
  writeFiles(root, { ...managed, ...generated });
  writeLock(root, buildLock(SAT_ROOT, cfg.project.stack, cfg.project.platform, managed, generated));
  ensureGitignore(root);
  appendFileSync(join(root, '.team', 'LEDGER.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type: 'sat_updated', from: lock.sat_version, to: version })}\n`, 'utf8');
  console.log(`[SAT] ✓ حُدّث SAT من ${lock.sat_version} إلى ${version}: ${changed.length} ملفاً تغيّر، ${removed.length} حُذف.`);
  for (const r of changed) console.log(`  ~ ${r}`);
  for (const r of removed) console.log(`  - ${r}`);
  console.log(`[SAT] لم يُلمس project.yaml ولا DECISIONS.md ولا المهام. شغّل: ${SAT} doctor`);
}

function cmdRegenerate(root, opts) {
  const lock = readLock(root);
  if (!lock) fail('SAT غير مثبت هنا.');
  const cfg = loadProject(root);
  const modified = Object.entries(lock.generated || {})
    .filter(([rel, hash]) => {
      const now = currentTrackedHash(root, rel);
      return now !== null && now !== hash;
    })
    .map(([rel]) => rel);
  if (modified.length && !opts.force) fail(`ملفات مولّدة عُدّلت يدوياً:\n- ${modified.join('\n- ')}\nللكتابة فوقها: --force`);
  const generated = generatedFiles(SAT_ROOT, cfg, root);
  removeStale(root, { managed: {}, generated: lock.generated }, {}, generated);
  writeFiles(root, generated);
  const managedLock = lock.managed;
  const next = buildLock(SAT_ROOT, cfg.project.stack, cfg.project.platform, {}, generated);
  next.managed = managedLock;
  next.sat_version = lock.sat_version;
  writeLock(root, next);
  console.log(`[SAT] ✓ أُعيد توليد ${Object.keys(generated).length} ملفاً.`);
  if (lock.stack !== cfg.project.stack) console.log(`[SAT] ! تغيّر المكدس في project.yaml: شغّل ${SAT} update لتحديث المسارات الحساسة.`);
}

function cmdDoctor(root, opts) {
  const results = doctor({ root, satRoot: SAT_ROOT, run: !opts.quick });
  const icon = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.title}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n[SAT] الحكم: ${fails ? 'غير جاهز' : 'جاهز'} (${fails} عائق، ${warns} تنبيه).`);
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
