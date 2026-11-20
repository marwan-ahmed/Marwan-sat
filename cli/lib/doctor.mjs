// Marwan SAT — doctor: is this project ready for the team? (charter §14.2)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../../core/bin/lib/yaml.mjs';
import { COMMAND_ORDER, loadProject } from '../../core/bin/lib/config.mjs';
import { headSha, isGitRepo, remoteUrl } from '../../core/bin/lib/git.mjs';
import { commandExists, firstToken, runShell } from '../../core/bin/lib/proc.mjs';
import { readLock } from '../../core/bin/lib/scope.mjs';
import { HOOK_KEY } from '../../adapters/antigravity/generate.mjs';
import { locallyModified, satVersion } from './install.mjs';

const ROLE_IDS = ['tech-manager', 'request-interpreter', 'architect', 'security-auditor', 'test-author', 'implementer', 'adversarial-reviewer'];

export function doctor({ root, satRoot, run = true }) {
  const results = [];
  const add = (level, title, detail = '') => results.push({ level, title, detail });

  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 20 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? '' : 'يلزم الإصدار 20 أو أحدث');

  if (!isGitRepo(root)) {
    add('fail', 'git', 'المجلد ليس مستودع git');
  } else {
    add(headSha(root) ? 'ok' : 'fail', 'git: commit أولي', headSha(root) ? '' : 'لا يوجد أي commit');
    const url = remoteUrl(root);
    add(url && /github\.com/i.test(url) ? 'ok' : 'warn', 'remote على GitHub', url || 'لا يوجد remote باسم origin');
  }

  const lock = readLock(root);
  if (!lock) {
    add('fail', 'تثبيت SAT', 'sat.lock مفقود: شغّل sat init');
    return results;
  }
  const cliVersion = satVersion(satRoot);
  add(lock.sat_version === cliVersion ? 'ok' : 'warn', `إصدار SAT في المشروع ${lock.sat_version}`, lock.sat_version === cliVersion ? '' : `أداة sat الحالية ${cliVersion}: شغّل sat update`);

  let cfg;
  try {
    cfg = loadProject(root);
    add('ok', 'project.yaml صالح');
  } catch (e) {
    add('fail', 'project.yaml', e.message);
    return results;
  }

  const modified = locallyModified(root, lock);
  add(modified.length ? 'fail' : 'ok', 'ملفات القالب المُدارة والمولّدة سليمة', modified.join(', '));

  const agentsDir = join(root, '.agents', 'agents');
  const missing = ROLE_IDS.filter((id) => !existsSync(join(agentsDir, `${id}.md`)));
  add(missing.length ? 'fail' : 'ok', 'ملفات الوكلاء السبعة في .agents/agents', missing.length ? `مفقود: ${missing.join(', ')}` : '');
  const hooksPath = join(root, '.agents', 'hooks.json');
  let hookOk = false;
  try {
    hookOk = Boolean(JSON.parse(readFileSync(hooksPath, 'utf8'))[HOOK_KEY]);
  } catch {
    hookOk = false;
  }
  add(hookOk ? 'ok' : 'fail', 'guard مسجّل في .agents/hooks.json');
  // Live self-test: run the guard exactly as Antigravity does (JSON on stdin) and expect it to block a protected file.
  const probe = spawnSync(process.execPath, [join(root, '.team', 'bin', 'guard.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    input: JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: join(root, '.team', 'CHARTER.md') } }, workspacePaths: [root] }),
  });
  let probeDecision = null;
  try {
    probeDecision = JSON.parse(probe.stdout).decision;
  } catch {
    probeDecision = null;
  }
  const probeErr = (probe.stderr || (probe.error && probe.error.message) || 'لا مخرجات').trim().split('\n').slice(-3).join(' | ');
  add(probeDecision === 'deny' ? 'ok' : 'fail', 'guard يعمل على هذا الجهاز (اختبار حي: يرفض تعديل ملف محمي)', probeDecision === 'deny' ? '' : `النتيجة: ${probeDecision || probeErr}`);
  if (existsSync(agentsDir)) {
    const known = JSON.parse(readFileSync(join(satRoot, 'adapters', 'antigravity', 'tools.json'), 'utf8'));
    const knownNames = new Set(Object.values(known.capabilities).flat());
    const used = new Set();
    for (const f of readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
      const { data } = parseFrontmatter(readFileSync(join(agentsDir, f), 'utf8'));
      for (const t of (data && data.tools) || []) used.add(t);
    }
    const unknown = [...used].filter((t) => !knownNames.has(t));
    add(unknown.length ? 'fail' : 'warn', 'أسماء أدوات Antigravity', unknown.length ? `غير معروفة: ${unknown.join(', ')}` : `${[...used].join(', ')} — موثّقة، لكن افتح كل وكيل مرة في Antigravity للتأكد (اسم خاطئ قد يعلّق الوكيل)`);
  }
  add(existsSync(join(root, '.github', 'workflows', 'sat-verify.yml')) ? 'ok' : 'fail', 'workflow الـCI: .github/workflows/sat-verify.yml');

  const gi = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
  add(gi.includes('.team/STATE.json') ? 'ok' : 'warn', '.gitignore يستثني ملفات SAT المؤقتة');
  add(existsSync(join(root, 'AGENTS.md')) ? 'ok' : 'warn', 'AGENTS.md (قواعد المشروع)', existsSync(join(root, 'AGENTS.md')) ? '' : 'غير موجود: يُنصح بإنشائه، مثلاً من قالب arabic-agents');

  for (const name of [...COMMAND_ORDER, 'start']) {
    const cmd = cfg.commands[name];
    if (!cmd) {
      add(name === 'test' ? 'warn' : 'info', `الأمر ${name}`, 'غير مُعدّ');
      continue;
    }
    const bin = firstToken(cmd);
    if (!commandExists(bin)) {
      add('fail', `الأمر ${name}`, `الأداة ${bin} غير موجودة: ${cmd}`);
      continue;
    }
    if (!run || name === 'start') {
      add('ok', `الأمر ${name}`, `${cmd} (لم يُشغَّل)`);
      continue;
    }
    const r = runShell(cmd, { cwd: root, timeoutMs: cfg.timeouts.step_minutes * 60 * 1000 });
    add(r.exitCode === 0 ? 'ok' : 'fail', `الأمر ${name}`, r.exitCode === 0 ? cmd : `${cmd} → exit ${r.exitCode}\n${(r.stderr || r.stdout).split('\n').slice(-8).join('\n')}`);
  }

  for (const [k, cmd] of Object.entries(cfg.security.scanners)) {
    if (!cmd) {
      add('warn', `الماسح ${k}`, 'غير مُعدّ: سيظهر في التقرير ضمن «ما لم يُختبر»');
      continue;
    }
    const bin = firstToken(cmd);
    add(commandExists(bin) ? 'ok' : 'warn', `الماسح ${k}`, commandExists(bin) ? cmd : `${bin} غير مثبت محلياً (إلزامي في CI)`);
  }

  const env = cfg.security.attack_env;
  if (cfg.security.profile === 'web' && env === 'none') add('warn', 'بيئة الهجوم', 'attack_env = none: سيكون التدقيق الأمني INCOMPLETE في المحاور التي تحتاج اختباراً ديناميكياً');
  else if (env !== 'none' && !cfg.security.env_up) add('warn', 'بيئة الهجوم', `attack_env = ${env} لكن env_up غير مُعدّ`);
  else if (env === 'neon-branch') add(commandExists('neonctl') ? 'ok' : 'warn', 'بيئة الهجوم: neonctl');
  else if (env.startsWith('docker')) add(commandExists('docker') ? 'ok' : 'warn', 'بيئة الهجوم: docker');

  if (commandExists('gh')) {
    const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: root, encoding: 'utf8' });
    if (repo.status === 0 && repo.stdout.trim()) {
      const name = repo.stdout.trim();
      const prot = spawnSync('gh', ['api', `repos/${name}/branches/${cfg.git.base_branch}/protection`, '--silent'], { cwd: root, encoding: 'utf8' });
      add(prot.status === 0 ? 'ok' : 'fail', `Branch protection على ${cfg.git.base_branch}`, prot.status === 0 ? '' : 'غير مفعّلة أو لا صلاحية لقراءتها: فعّلها واشترط مراجعتك قبل الدمج');
    } else add('warn', 'GitHub', 'تعذّر قراءة المستودع عبر gh');
  } else add('warn', 'Branch protection', 'أداة gh غير مثبتة: تحقق يدوياً من حماية الفرع الرئيسي');

  return results;
}
