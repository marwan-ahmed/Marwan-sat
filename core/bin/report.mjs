#!/usr/bin/env node
// Marwan SAT — report: builds REPORT.md from the contracts and the evidence (charter §8, template 12.6).
// Every section is generated except the tech-manager risk section. The generated part is hash-locked.
//
//   node .team/bin/report.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadProject } from './lib/config.mjs';
import { extractIds, isBlocking, readJSONFile, readText } from './lib/contracts.mjs';
import { git } from './lib/git.mjs';
import { commandExists } from './lib/proc.mjs';
import { reportHash, TM_BEGIN, TM_END, TM_PLACEHOLDER } from './lib/report-hash.mjs';
import { activeTask, appendLedger, readLedger, taskDir, writeTask } from './lib/state.mjs';
import { spawnSync } from 'node:child_process';

const SEV_AR = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const PROOF_AR = { confirmed: 'مؤكد', suspected: 'مشتبه' };
const STATUS_AR = { pass: 'نجح', fail: 'فشل', skipped: 'تُخطّي', missing: 'الأداة غير مثبتة', not_configured: 'غير مُعدّ', warn: 'تحذير' };

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function section(md, heading) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(heading));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function prUrl(root) {
  if (!commandExists('gh')) return null;
  const r = spawnSync('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function main() {
  const root = findRoot();
  if (!root) throw new Error('Could not find .team/project.yaml');
  loadProject(root);
  const task = activeTask(root);
  if (!task) throw new Error('No active task.');
  if (!['REPORT', 'GATE_2'].includes(task.phase)) throw new Error(`report runs in the REPORT phase only (current phase: ${task.phase}).`);
  const dir = taskDir(root, task.id);
  const request = readText(join(dir, 'REQUEST.md')) || '(REQUEST.md مفقود)';
  const exec = readText(join(dir, 'EXEC_PROMPT.md'));
  const goal = section(exec, '## 1.') || '(غير متاح)';
  const tasks = readJSONFile(join(dir, 'TASKS.json')).value;
  const review = readJSONFile(join(dir, 'REVIEW.json')).value;
  const audit = task.path === 'full' ? readJSONFile(join(dir, 'SECURITY_AUDIT.json')).value : null;
  const lv = task.last_verify;
  const vsum = lv ? readJSONFile(join(root, lv.dir, 'summary.json')).value : null;
  const head = git(['rev-parse', 'HEAD'], root);
  const diffStat = (git(['diff', '--stat', `${task.base_sha}..HEAD`], root, { allowFail: true, raw: true }) || '').replace(/\s+$/, '') || '(لا تغييرات)';
  const spec = readText(join(dir, 'SPEC.md'));
  const threat = readText(join(dir, 'THREAT_MODEL.md'));
  const trace = readText(join(dir, 'TRACE.md')) || '';
  const ids = [...extractIds(spec, 'AC'), ...extractIds(threat, 'AB')];
  const uncovered = ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(trace));
  const findings = [...((review && review.findings) || []).map((f) => ({ ...f, src: 'المراجع' })), ...((audit && audit.findings) || []).map((f) => ({ ...f, src: 'المدقق الأمني' }))];
  const pr = prUrl(root);

  // 1. Decisions required.
  const decisions = ['اعتماد النتيجة والدمج، أو طلب تعديل، أو الإلغاء (البوابة 2).'];
  if (!vsum || vsum.result !== 'pass' || (vsum.sha && vsum.sha !== head)) decisions.unshift('**لا يجوز الدمج:** آخر تشغيل لـ verify لم ينجح أو لا يطابق HEAD.');
  for (const f of findings.filter((x) => x.severity === 'medium')) decisions.push(`ملاحظة Medium ${f.id} (${f.src}): إصلاح أم قبول المخاطرة؟`);
  for (const f of findings.filter((x) => x.proof === 'suspected' && ['critical', 'high'].includes(x.severity)))
    decisions.push(`ملاحظة ${SEV_AR[f.severity]} **مشتبهة** ${f.id} (${f.src}): بند إلزامي. هل تطلب دورة إصلاح وقائية؟`);
  if (audit && audit.verdict === 'INCOMPLETE') decisions.push('التدقيق الأمني INCOMPLETE: هل تقبل التغطية الجزئية؟');

  // 6. Not done / failed / not tested.
  const gaps = [];
  if (vsum) {
    for (const s of vsum.steps) if (s.status !== 'pass') gaps.push(`خطوة verify «${s.name}»: ${STATUS_AR[s.status] || s.status}${s.reason ? ` — ${s.reason}` : ''}`);
    for (const c of vsum.checks) if (c.status !== 'pass') gaps.push(`فحص «${c.name}» فشل: ${Array.isArray(c.details) ? c.details.join(', ') : c.details}`);
  } else gaps.push('لا يوجد تشغيل verify مسجّل.');
  for (const id of uncovered) gaps.push(`${id} غير مغطى في TRACE.md`);
  if (audit) for (const c of audit.coverage || []) if (c.status === 'NOT_TESTED') gaps.push(`محور أمني لم يُختبر: ${c.axis} — ${c.reason}`);
  if (task.path === 'light') gaps.push('مسار خفيف: لا نموذج تهديدات ولا تدقيق أمني بوكيل (الماسحات فقط).');
  for (const f of findings.filter((x) => x.proof === 'suspected')) gaps.push(`ملاحظة مشتبهة غير مثبتة: ${f.id}`);
  if (tasks && Array.isArray(tasks.items))
    for (const it of tasks.items) {
      const missingIds = (it.acceptance || []).concat(it.abuse_cases || []).filter((id) => !new RegExp(`\\b${id}\\b`).test(trace));
      if (missingIds.length) gaps.push(`المهمة ${it.id} — ${it.title}: معرّفات بلا اختبار في TRACE (${missingIds.join(', ')})`);
    }

  // 8. Consumption.
  const events = readLedger(root).filter((e) => e.task === task.id);
  const verifyRuns = events.filter((e) => e.type === 'verify').length;
  const credits = events.filter((e) => e.type === 'usage' && Number.isFinite(e.credits)).reduce((a, e) => a + e.credits, 0);
  const hours = ((Date.now() - Date.parse(task.created_at)) / 36e5).toFixed(1);

  const L = [];
  L.push(`# تقرير المهمة — ${task.id}: ${task.title}`);
  L.push('');
  L.push('> مولَّد آلياً بأداة `report.mjs`، باستثناء القسم 7. أي تعديل يدوي على الأقسام المولّدة يُبطل التقرير.');
  L.push(`> المسار: ${task.path === 'full' ? 'كامل' : 'خفيف'} · الفرع: \`${task.branch}\` · HEAD: \`${head.slice(0, 10)}\`${pr ? ` · PR: ${pr}` : ' · PR: لم يُفتح بعد أو أداة gh غير متاحة'}`);
  L.push('');
  L.push('## 1. القرار المطلوب منك');
  for (const d of decisions) L.push(`- ${d}`);
  L.push('');
  L.push('## 2. الطلب وفهمه');
  L.push('**نص طلبك كما حُفظ (REQUEST.md):**');
  L.push('');
  for (const line of request.trim().split(/\r?\n/)) L.push(`> ${line}`);
  L.push('');
  L.push('**الهدف كما صاغه مفسّر الطلب (EXEC_PROMPT §1):**');
  L.push('');
  L.push(goal);
  L.push('');
  L.push('## 3. ما تغيّر');
  L.push('```text');
  L.push(diffStat);
  L.push('```');
  if (tasks && Array.isArray(tasks.items)) {
    L.push('');
    L.push('| المهمة | العنوان | معايير القبول | حالات الإساءة | الملفات المسموحة |');
    L.push('|---|---|---|---|---|');
    for (const it of tasks.items) L.push(`| ${esc(it.id)} | ${esc(it.title)} | ${esc((it.acceptance || []).join(', '))} | ${esc((it.abuse_cases || []).join(', ') || '—')} | ${esc((it.allowed_write || []).map((p) => `\`${p}\``).join(', '))} |`);
  }
  L.push('');
  L.push('## 4. التحقق');
  if (vsum) {
    L.push(`آخر تشغيل: \`${lv.dir}\` على \`${String(vsum.sha).slice(0, 10)}\` — **${vsum.result === 'pass' ? 'نجاح' : 'فشل'}**${vsum.dirty ? ' (على شجرة غير نظيفة)' : ''}`);
    L.push('');
    L.push('| الخطوة | الحالة | رمز الخروج | السجل |');
    L.push('|---|---|---|---|');
    for (const s of vsum.steps) L.push(`| ${esc(s.name)} | ${STATUS_AR[s.status] || s.status} | ${s.exit_code ?? '—'} | ${s.log ? `\`${s.log}\`` : '—'} |`);
    for (const c of vsum.checks) L.push(`| check:${esc(c.name)} | ${STATUS_AR[c.status] || c.status} | — | — |`);
  } else L.push('**لا يوجد تشغيل verify مسجّل.**');
  L.push('');
  L.push(`نتيجة CI على PR هي المرجع النهائي (الميثاق §8.1).${pr ? ` راجعها في ${pr}` : ''}`);
  L.push('');
  L.push(`تغطية TRACE: ${ids.length - uncovered.length} من ${ids.length} معرّفاً (معايير القبول وحالات الإساءة).`);
  L.push('');
  L.push('## 5. المراجعة والتدقيق الأمني');
  L.push(`- حكم المراجع: **${review ? review.verdict : 'غير متاح'}**`);
  if (task.path === 'full') L.push(`- حكم المدقق الأمني: **${audit ? audit.verdict : 'غير متاح'}** (CLEAR_WITHIN_SCOPE تعني: لم تثبت ثغرة Critical/High ضمن ما اختُبر فعلاً، لا أن النظام آمن)`);
  L.push(`- دورات الإصلاح: ${task.fix_cycles}`);
  L.push('');
  if (findings.length) {
    L.push('| المعرّف | المصدر | الخطورة | الإثبات | الموقع | السيناريو / الإصلاح |');
    L.push('|---|---|---|---|---|---|');
    for (const f of findings) L.push(`| ${esc(f.id)} | ${f.src} | ${SEV_AR[f.severity] || f.severity}${isBlocking(f) ? ' ⛔' : ''} | ${PROOF_AR[f.proof] || f.proof} | ${esc(f.location)} | ${esc(f.scenario || (f.exploit && f.exploit.request) || '')} ← ${esc(f.fix)} |`);
  } else L.push('لا ملاحظات مسجّلة في آخر جولة مراجعة.');
  if (audit && Array.isArray(audit.coverage)) {
    L.push('');
    L.push('| المحور الأمني | التغطية | السبب |');
    L.push('|---|---|---|');
    for (const c of audit.coverage) L.push(`| ${esc(c.axis)} | ${c.status} | ${esc(c.reason || '')} |`);
  }
  L.push('');
  L.push('## 6. ما لم يُنفّذ أو فشل أو لم يُختبر');
  if (gaps.length) for (const g of gaps) L.push(`- ${g}`);
  else L.push('- لا شيء مسجّل. (هذا القسم إلزامي حتى لو كان فارغاً.)');
  L.push('');
  L.push('## 7. تقدير المخاطر');
  L.push(TM_BEGIN);
  L.push(TM_PLACEHOLDER);
  L.push(TM_END);
  L.push('');
  L.push('## 8. الاستهلاك');
  L.push(`- الزمن منذ فتح المهمة: ${hours} ساعة`);
  L.push(`- مرات تشغيل verify: ${verifyRuns}`);
  L.push(`- دورات الإصلاح: ${task.fix_cycles}`);
  L.push(`- التكلفة (AI Credits): ${credits > 0 ? credits : 'غير مسجّلة آلياً'}`);
  L.push('');

  const text = L.join('\n');
  const out = join(dir, 'REPORT.md');
  // Preserve an already-written risk section when the report is regenerated.
  let finalText = text;
  if (existsSync(out)) {
    const old = readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
    const a = old.indexOf(TM_BEGIN);
    const b = old.indexOf(TM_END);
    if (a >= 0 && b > a) {
      const inner = old.slice(a + TM_BEGIN.length, b);
      finalText = text.replace(`${TM_BEGIN}\n${TM_PLACEHOLDER}\n${TM_END}`, `${TM_BEGIN}${inner}${TM_END}`);
    }
  }
  writeFileSync(out, finalText, 'utf8');
  task.report_hash = reportHash(finalText);
  writeTask(root, task);
  appendLedger(root, { type: 'report', task: task.id, sha: head });
  console.log(`[SAT] ✓ Wrote ${task.id}/REPORT.md. Now write only the risk assessment section, then phase next.`);
}

try {
  main();
} catch (e) {
  console.error(`[SAT] ✗ ${e.message}`);
  process.exit(1);
}
