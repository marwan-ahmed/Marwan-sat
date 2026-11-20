// Marwan SAT — deterministic checks on the team's contracts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './yaml.mjs';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const PROOFS = ['confirmed', 'suspected'];
export const REVIEW_LENSES = ['logic', 'money', 'test_integrity'];
export const COVERAGE = ['TESTED_DYNAMIC', 'REVIEWED_STATIC', 'NOT_TESTED', 'NOT_APPLICABLE'];
export const AUDIT_VERDICTS = ['BLOCKED', 'INCOMPLETE', 'CLEAR_WITHIN_SCOPE'];
export const REVIEW_VERDICTS = ['BLOCKED', 'CLEAR_WITHIN_SCOPE'];
const TOO_BROAD = new Set(['*', '**', '**/*', '.', './', '/', '**/**']);

export function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function readJSONFile(path) {
  const txt = readText(path);
  if (txt === null) return { value: null, error: `missing file ${path}` };
  try {
    return { value: JSON.parse(txt), error: null };
  } catch (e) {
    return { value: null, error: `invalid JSON in ${path}: ${e.message}` };
  }
}

export function extractIds(text, prefix) {
  if (!text) return [];
  const rx = new RegExp(`\\b${prefix}-\\d+\\b`, 'g');
  return [...new Set(text.match(rx) || [])].sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
}

// AC definitions are list items that start with the id: "- **AC-3** (← EXEC §2.1, R2): ..."
export function checkSpecTrace(specText) {
  const errors = [];
  const defs = [];
  for (const line of specText.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\*{0,2}(AC-\d+)\*{0,2}/.exec(line);
    if (!m) continue;
    defs.push(m[1]);
    if (!/(EXEC|R\d+)/.test(line)) errors.push(`${m[1]} لا يحيل إلى بند في EXEC_PROMPT (أضف "← EXEC §x" أو "R<n>")`);
  }
  if (defs.length === 0) errors.push('SPEC.md لا يحتوي أي معيار قبول بصيغة "- **AC-1** (← EXEC §..)"');
  return { defs, errors };
}

export function readExecPrompt(dir) {
  const txt = readText(join(dir, 'EXEC_PROMPT.md'));
  if (txt === null) return { error: 'EXEC_PROMPT.md غير موجود' };
  const { data } = parseFrontmatter(txt);
  if (!data) return { error: 'EXEC_PROMPT.md بلا front matter (blocking_questions, sensitive_assumptions, proposed_path)' };
  const bq = data.blocking_questions;
  const sa = data.sensitive_assumptions;
  if (!Number.isInteger(bq) || bq < 0) return { error: 'blocking_questions يجب أن يكون عدداً صحيحاً' };
  if (!Number.isInteger(sa) || sa < 0) return { error: 'sensitive_assumptions يجب أن يكون عدداً صحيحاً' };
  if (!['full', 'light'].includes(data.proposed_path)) return { error: 'proposed_path يجب أن يكون full أو light' };
  if (bq > 3) return { error: 'أكثر من 3 أسئلة حاجزة في جولة واحدة (حوّل الباقي إلى افتراضات معلنة)' };
  return { data, text: txt };
}

export function validateTasks(obj, taskId) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['TASKS.json: ليس كائن JSON'];
  if (obj.task_id !== taskId) errors.push(`TASKS.json: task_id يجب أن يكون ${taskId}`);
  if (!['full', 'light'].includes(obj.path)) errors.push('TASKS.json: path يجب أن يكون full أو light');
  if (!Array.isArray(obj.items) || obj.items.length === 0) errors.push('TASKS.json: items فارغة');
  else {
    const ids = new Set();
    obj.items.forEach((it, i) => {
      const where = `TASKS.json items[${i}]`;
      if (!it.id) errors.push(`${where}: id مطلوب`);
      if (ids.has(it.id)) errors.push(`${where}: id مكرر ${it.id}`);
      ids.add(it.id);
      if (!it.title) errors.push(`${where}: title مطلوب`);
      if (!Array.isArray(it.acceptance)) errors.push(`${where}: acceptance يجب أن تكون قائمة`);
      if (!Array.isArray(it.allowed_write) || it.allowed_write.length === 0) errors.push(`${where}: allowed_write يجب أن تحتوي مساراً واحداً على الأقل`);
      else
        for (const p of it.allowed_write) {
          if (typeof p !== 'string' || TOO_BROAD.has(p.trim())) errors.push(`${where}: نمط allowed_write واسع جداً "${p}"`);
          if (typeof p === 'string' && /^\.team\/|^\.agents\/|^\.claude\/|^\.github\/workflows\/sat-/.test(p)) errors.push(`${where}: لا يجوز إدراج ملفات الحوكمة في allowed_write "${p}"`);
        }
    });
  }
  return errors;
}

function validateFinding(f, i, where, kind) {
  const errors = [];
  const at = `${where} findings[${i}]`;
  for (const k of ['id', 'severity', 'proof', 'location', 'fix']) if (!f[k]) errors.push(`${at}: ${k} مطلوب`);
  if (f.severity && !SEVERITIES.includes(f.severity)) errors.push(`${at}: severity غير صالحة`);
  if (f.proof && !PROOFS.includes(f.proof)) errors.push(`${at}: proof غير صالح`);
  if (kind === 'review') {
    if (!REVIEW_LENSES.includes(f.lens)) errors.push(`${at}: lens يجب أن يكون ${REVIEW_LENSES.join(' | ')}`);
    if (!f.scenario) errors.push(`${at}: scenario مطلوب`);
    if (f.proof === 'confirmed' && !f.evidence) errors.push(`${at}: ملاحظة مؤكدة بلا evidence`);
  } else {
    if (!f.axis) errors.push(`${at}: axis مطلوب`);
    if (f.proof === 'confirmed' && !(f.exploit && f.exploit.request && f.exploit.response) && !f.evidence)
      errors.push(`${at}: ملاحظة مؤكدة بلا exploit.request/response أو evidence`);
  }
  return errors;
}

export function isBlocking(f) {
  return f.proof === 'confirmed' && (f.severity === 'critical' || f.severity === 'high');
}

export function validateReview(obj) {
  const errors = [];
  if (!obj) return ['REVIEW.json مفقود'];
  if (!REVIEW_VERDICTS.includes(obj.verdict)) errors.push(`REVIEW.json: verdict يجب أن يكون ${REVIEW_VERDICTS.join(' | ')}`);
  if (!Array.isArray(obj.findings)) errors.push('REVIEW.json: findings يجب أن تكون قائمة');
  else obj.findings.forEach((f, i) => errors.push(...validateFinding(f, i, 'REVIEW.json', 'review')));
  const blocking = (obj.findings || []).some(isBlocking);
  if (blocking && obj.verdict !== 'BLOCKED') errors.push('REVIEW.json: توجد ملاحظة Critical/High مؤكدة والحكم ليس BLOCKED');
  if (!blocking && obj.verdict === 'BLOCKED') errors.push('REVIEW.json: الحكم BLOCKED بلا ملاحظة Critical/High مؤكدة');
  return errors;
}

export function validateAudit(obj) {
  const errors = [];
  if (!obj) return ['SECURITY_AUDIT.json مفقود'];
  if (!['web', 'mobile'].includes(obj.profile)) errors.push('SECURITY_AUDIT.json: profile يجب أن يكون web أو mobile');
  if (!AUDIT_VERDICTS.includes(obj.verdict)) errors.push(`SECURITY_AUDIT.json: verdict يجب أن يكون ${AUDIT_VERDICTS.join(' | ')}`);
  if (!Array.isArray(obj.coverage) || obj.coverage.length === 0) errors.push('SECURITY_AUDIT.json: coverage فارغة');
  else
    obj.coverage.forEach((c, i) => {
      if (!c.axis) errors.push(`SECURITY_AUDIT.json coverage[${i}]: axis مطلوب`);
      if (!COVERAGE.includes(c.status)) errors.push(`SECURITY_AUDIT.json coverage[${i}]: status غير صالح`);
      if ((c.status === 'NOT_TESTED' || c.status === 'NOT_APPLICABLE') && !c.reason)
        errors.push(`SECURITY_AUDIT.json coverage[${i}]: reason مطلوب مع ${c.status}`);
    });
  if (!Array.isArray(obj.findings)) errors.push('SECURITY_AUDIT.json: findings يجب أن تكون قائمة');
  else obj.findings.forEach((f, i) => errors.push(...validateFinding(f, i, 'SECURITY_AUDIT.json', 'audit')));
  const blocking = (obj.findings || []).some(isBlocking);
  if (blocking && obj.verdict !== 'BLOCKED') errors.push('SECURITY_AUDIT.json: توجد ثغرة Critical/High مؤكدة والحكم ليس BLOCKED');
  if (!blocking && obj.verdict === 'BLOCKED') errors.push('SECURITY_AUDIT.json: الحكم BLOCKED بلا ثغرة Critical/High مؤكدة');
  const summary = String(obj.summary || '');
  if (/\b(safe|secure)\b/i.test(summary) || /(^|[^؀-ۿ])آمن([^؀-ۿ]|$)/.test(summary))
    errors.push('SECURITY_AUDIT.json: لا تُستخدم كلمة "آمن/safe" في الملخص (الحكم CLEAR_WITHIN_SCOPE يعني: لم تثبت ثغرة ضمن ما اختُبر)');
  return errors;
}

// Highest-numbered "<prefix>-<n>.md" in a directory, e.g. CHANGE_DECISION-2.md.
export function latestNumbered(dir, prefix) {
  if (!existsSync(dir)) return null;
  const rx = new RegExp(`^${prefix}-(\\d+)\\.md$`);
  const found = readdirSync(dir)
    .map((n) => [n, rx.exec(n)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
  return found.length ? join(dir, found[found.length - 1][0]) : null;
}
