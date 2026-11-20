#!/usr/bin/env node
// Marwan SAT — guard: PreToolUse hook for Google Antigravity (charter §10, §15.1).
//
// Reads the hook payload on stdin ({ toolCall: { name, args }, workspacePaths, ... })
// and prints a decision: {"decision":"allow"|"deny"|"ask","reason":"..."}.
//
// What it enforces (first line of defence; Git + CI remain the last line):
//   - Writes only to the files allowed in the current phase (and allowed_write in IMPLEMENT/FIX).
//   - SAT-managed, generated and tool-owned files are never written by agents.
//   - Reviewers do not read the implementer's notes (clean context).
//   - Dangerous shell commands; network targets outside localhost during REVIEW;
//     gate approvals by agents when gates.approval = owner.
// Limitation (documented): a shell command can still write files. verify.mjs and CI catch that.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from './lib/config.mjs';
import { matchAny, toPosix } from './lib/glob.mjs';
import { phaseWritable, protectedGlobs, readTasksJson } from './lib/scope.mjs';
import { readJSON, statePath, taskDir } from './lib/state.mjs';

const WRITE_TOOLS = /^(write_to_file|replace_file_content|multi_replace_file_content|create_file|edit_file|delete_file|move_file|rename_file)$/;
const READ_TOOLS = /^(view_file|read_file|view_file_outline|view_code_item)$/;
const SHELL_TOOLS = /^(run_command|run_terminal_command|bash|shell)$/;
const PATH_KEYS = ['TargetFile', 'AbsolutePath', 'FilePath', 'File', 'Path', 'path', 'file_path', 'target_file', 'DestinationFile', 'SourceFile'];

const DANGEROUS = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, 'حذف تكراري قسري (rm -rf) محظور'],
  [/\bsudo\b/, 'sudo محظور'],
  [/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, 'git push --force محظور'],
  [/\bgit\s+push\b[^\n]*\s(main|master)\b/, 'الدفع إلى الفرع الرئيسي محظور: الدمج بيد صاحب القرار عبر PR'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard محظور'],
  [/\bgit\s+(commit|push)\b[^\n]*--no-verify\b/, '--no-verify محظور'],
  [/\bgit\s+config\b[^\n]*\bcore\.hooksPath\b/, 'تغيير مسار git hooks محظور'],
];

function out(decision, reason) {
  process.stdout.write(`${JSON.stringify(reason ? { decision, reason: `[Marwan SAT] ${reason}` } : { decision })}\n`);
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function targetPath(args) {
  for (const k of PATH_KEYS) if (typeof args[k] === 'string' && args[k].trim()) return args[k];
  return null;
}

function sameOrInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function decide(payload, { cwd = process.cwd() } = {}) {
  const call = payload && payload.toolCall ? payload.toolCall : {};
  const tool = String(call.name || '');
  const args = call.args || {};
  const root = resolve((payload.workspacePaths && payload.workspacePaths[0]) || cwd);
  if (!existsSync(join(root, '.team', 'project.yaml'))) return { decision: 'allow' };

  let cfg;
  try {
    cfg = loadProject(root);
  } catch (e) {
    return { decision: 'ask', reason: `project.yaml غير صالح: ${e.message}` };
  }
  const state = readJSON(statePath(root), null);
  const task = state && state.active_task ? readJSON(join(taskDir(root, state.active_task), 'task.json'), null) : null;
  const phase = task ? task.phase : null;

  if (SHELL_TOOLS.test(tool)) {
    const cmd = String(args.CommandLine || args.command || args.cmd || '');
    for (const [rx, why] of DANGEROUS) if (rx.test(cmd)) return { decision: 'deny', reason: why };
    if (cfg.gates.approval === 'owner' && /phase(\.mjs)?\s+(approve|resume)\b/.test(cmd))
      return { decision: 'deny', reason: 'الموافقة على البوابات واستئناف المهام يشغّلها صاحب القرار بنفسه (gates.approval = owner)' };
    if (phase === 'REVIEW') {
      const hosts = [...cmd.matchAll(/\bhttps?:\/\/([^/\s:'"]+)/gi)].map((m) => m[1].toLowerCase());
      const external = hosts.filter((h) => !['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(h));
      if (external.length) return { decision: 'deny', reason: `أثناء المراجعة لا يُسمح إلا بأهداف localhost (قواعد الاشتباك): ${external.join(', ')}` };
    }
    return { decision: 'allow' };
  }

  if (READ_TOOLS.test(tool)) {
    const p = targetPath(args);
    if (p && phase === 'REVIEW' && /IMPLEMENTATION_NOTES\.md$/i.test(toPosix(p)))
      return { decision: 'deny', reason: 'المراجعان يعملان بسياق نظيف: لا قراءة لملاحظات المنفّذ' };
    return { decision: 'allow' };
  }

  if (!WRITE_TOOLS.test(tool)) return { decision: 'allow' };

  const p = targetPath(args);
  if (!p) return { decision: 'ask', reason: `تعذّر تحديد الملف المستهدف للأداة ${tool}` };
  const abs = resolve(root, p);
  const gemCfg = join(homedir(), '.gemini', 'config');
  if (sameOrInside(abs, gemCfg)) return { decision: 'deny', reason: 'لا يعدّل الوكلاء إعدادات Antigravity العامة' };
  if (!sameOrInside(abs, root)) return { decision: 'allow' };
  const rel = toPosix(relative(root, abs));

  if (matchAny(rel, protectedGlobs(root))) return { decision: 'deny', reason: `${rel} ملف تملكه أدوات SAT أو القالب، ولا يكتبه أي وكيل` };

  if (!task) {
    const policy = cfg.guard.no_task_policy;
    if (policy === 'allow') return { decision: 'allow' };
    const why = 'لا توجد مهمة SAT نشطة. ابدأ عبر المدير التقني: node .team/bin/phase.mjs new "<العنوان>"';
    return { decision: policy === 'deny' ? 'deny' : 'ask', reason: why };
  }

  const allowed = phaseWritable(phase, task, cfg, readTasksJson(root, task));
  if (matchAny(rel, allowed)) return { decision: 'allow' };
  return {
    decision: 'deny',
    reason: `المرحلة الحالية ${phase} لا تسمح بالكتابة في ${rel}. المسموح: ${allowed.length ? allowed.join(', ') : 'لا شيء (بوابة أو مرحلة متوقفة)'}`,
  };
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  let payload = {};
  try {
    const raw = readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    out('ask', 'تعذّر قراءة مدخلات الـhook');
  }
  try {
    const d = decide(payload);
    out(d.decision, d.reason);
  } catch (e) {
    out('ask', `خطأ داخلي في guard: ${e.message}`);
  }
}
