#!/usr/bin/env node
// Marwan SAT — phase: the task state machine (charter §5, §6, §7).
//
//   node .team/bin/phase.mjs new "<title>" [--path full|light]
//   node .team/bin/phase.mjs status [--json]
//   node .team/bin/phase.mjs next
//   node .team/bin/phase.mjs approve <GATE_0|GATE_1|GATE_2> --decision <approve|changes|cancel> [--to <PHASE>] --note "<owner's words>"
//   node .team/bin/phase.mjs goto DESIGN --reason "<CHANGE_REQUEST-n>"
//   node .team/bin/phase.mjs escalate "<reason>"
//   node .team/bin/phase.mjs resume --to <PHASE> --note "<owner decision>"
//   node .team/bin/phase.mjs cancel --note "<reason>"
//
// Only this tool changes the phase. Agents cannot write STATE.json or task.json (guard.mjs).
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadProject } from './lib/config.mjs';
import { checkSpecTrace, extractIds, isBlocking, latestNumbered, readExecPrompt, readJSONFile, readText, validateAudit, validateReview, validateTasks } from './lib/contracts.mjs';
import { currentBranch, git, headSha, isGitRepo, porcelainFiles } from './lib/git.mjs';
import { matchAny } from './lib/glob.mjs';
import { reportHash, tmSectionFilled } from './lib/report-hash.mjs';
import { activeTask, appendLedger, GATES, nextTaskId, readState, taskDir, taskRel, TERMINAL, writeState, writeTask } from './lib/state.mjs';
import { parseFrontmatter } from './lib/yaml.mjs';

const NEXT_ACTOR = {
  INTAKE: 'marwan-sat-tech-manager: write REQUEST.md with the owner\'s request verbatim, then run phase next.',
  INTERPRET: 'Call marwan-sat-request-interpreter to write EXEC_PROMPT.md (on the light path the tech manager then writes TASKS.json), then phase next.',
  GATE_0: 'Gate 0: show the questions and assumptions to the owner verbatim, record the reply verbatim in ANSWERS.md, then approve GATE_0.',
  DESIGN: 'Call marwan-sat-architect to write SPEC.md, ARCH.md and PLAN.md, then phase next.',
  THREAT: 'Call marwan-sat-security-auditor (threat model mode) to write THREAT_MODEL.md, then phase next.',
  GATE_1: 'Write TASKS.json from PLAN.md, then show the design summary to the owner. Approve only after their explicit approval.',
  TESTS: 'Call marwan-sat-test-author to write the tests and TRACE.md, then phase next (it creates the freeze commit).',
  IMPLEMENT: 'Call marwan-sat-implementer: implement, commit, then verify. After verify passes, run phase next.',
  REVIEW: 'Call marwan-sat-adversarial-reviewer (and, on the full path, marwan-sat-security-auditor in audit mode) in parallel, then phase next.',
  FIX: 'Call marwan-sat-implementer to fix the blocking findings only, then verify, then phase next.',
  REPORT: 'Run report.mjs, write only the risk assessment section, push the branch and open a PR, then phase next.',
  GATE_2: 'Gate 2: show REPORT.md and the PR link to the owner. Only the owner merges.',
  ESCALATED: 'The task is paused. Present the escalation to the owner in the charter §7.6 format, then resume with their decision.',
  CLOSED: 'The task is closed.',
  CANCELLED: 'The task is cancelled.',
};

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opts[k] = v;
    } else pos.push(a);
  }
  return { pos, opts };
}

class PhaseError extends Error {}
const fail = (msg) => {
  throw new PhaseError(msg);
};

function requireActive(root) {
  const task = activeTask(root);
  if (!task) fail('No active task. Start one with: phase new "<title>"');
  return task;
}

function transition(root, task, to, extra = {}) {
  const from = task.phase;
  task.phase = to;
  task.history = [...(task.history || []), { phase: to, at: new Date().toISOString(), from, ...extra }];
  writeTask(root, task);
  writeState(root, { active_task: TERMINAL.includes(to) ? null : task.id, phase: to, last_task: task.id });
  appendLedger(root, { type: 'phase', task: task.id, from, to, ...extra });
  console.log(`[SAT] ${task.id}: ${from} → ${to}`);
  console.log(`[SAT] Next: ${NEXT_ACTOR[to]}`);
}

function escalate(root, task, reason) {
  task.escalated_from = task.phase;
  transition(root, task, 'ESCALATED', { reason });
}

function effectiveLimit(cfg, task, key) {
  return cfg.limits[key] + ((task.granted && task.granted[key]) || 0);
}

function cmdNew(root, cfg, pos, opts) {
  const title = pos[0];
  if (!title) fail('A title is required: phase new "<title>"');
  const path = opts.path || 'full';
  if (!['full', 'light'].includes(path)) fail('--path must be full or light');
  const st = readState(root);
  if (st && st.active_task) fail(`Task ${st.active_task} is still active. Close or cancel it first.`);
  if (!isGitRepo(root)) fail('The project is not a git repository.');
  const sha = headSha(root);
  if (!sha) fail('The repository has no commits. Make an initial commit first.');
  const dirty = porcelainFiles(root).filter((f) => !f.startsWith('.team/LEDGER.jsonl'));
  if (dirty.length) fail(`The working tree is not clean. Commit or stash first:\n- ${dirty.slice(0, 20).join('\n- ')}`);
  const baseRef = currentBranch(root);
  if (baseRef && baseRef.startsWith(cfg.git.task_branch_prefix)) {
    fail(`You are on a previous task's branch (${baseRef}). Go back to the main branch and update it first:\n  git checkout ${cfg.git.base_branch}\n  git pull`);
  }
  const branches = git(['branch', '--list', `${cfg.git.task_branch_prefix}TASK-*`, '--format=%(refname:short)'], root, { allowFail: true }) || '';
  const id = nextTaskId(root, branches.split('\n').filter(Boolean));
  const branch = `${cfg.git.task_branch_prefix}${id}`;
  git(['checkout', '-b', branch], root);
  mkdirSync(taskDir(root, id), { recursive: true });
  const task = {
    id,
    title,
    path,
    branch,
    base_ref: baseRef,
    base_sha: sha,
    created_at: new Date().toISOString(),
    phase: 'INTAKE',
    interpret_round: 1,
    fix_cycles: 0,
    verify_failures: 0,
    frozen_sha: null,
    cr: null,
    gates: {},
    granted: {},
    last_verify: null,
    report_hash: null,
    history: [{ phase: 'INTAKE', at: new Date().toISOString() }],
  };
  writeTask(root, task);
  writeState(root, { active_task: id, phase: 'INTAKE' });
  appendLedger(root, { type: 'task_created', task: id, title, path, branch, base_ref: baseRef, base_sha: sha });
  console.log(`[SAT] Created task ${id} (${path === 'full' ? 'full path' : 'light path'}) on branch ${branch}`);
  console.log(`[SAT] Next: ${NEXT_ACTOR.INTAKE}`);
}

function cmdStatus(root, cfg, opts) {
  const st = readState(root);
  const task = st && st.active_task ? activeTask(root) : null;
  const out = task
    ? {
        active_task: task.id,
        title: task.title,
        path: task.path,
        phase: task.phase,
        branch: task.branch,
        base_sha: task.base_sha,
        frozen_sha: task.frozen_sha,
        fix_cycles: `${task.fix_cycles}/${effectiveLimit(cfg, task, 'fix_cycles')}`,
        verify_failures: `${task.verify_failures}/${effectiveLimit(cfg, task, 'verify_failures')}`,
        interpret_round: `${task.interpret_round}/${effectiveLimit(cfg, task, 'question_rounds')}`,
        last_verify: task.last_verify,
        next: NEXT_ACTOR[task.phase],
      }
    : { active_task: null, last_task: st ? st.last_task || null : null };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else for (const [k, v] of Object.entries(out)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

function checkTestsPhase(root, cfg, task, dir) {
  const trace = readText(join(dir, 'TRACE.md'));
  if (!trace) fail('TRACE.md is missing.');
  const acs = extractIds(readText(join(dir, 'SPEC.md')) || '', 'AC');
  const abs = extractIds(readText(join(dir, 'THREAT_MODEL.md')) || '', 'AB');
  const missing = [...acs, ...abs].filter((id) => !new RegExp(`\\b${id}\\b`).test(trace));
  if (missing.length) fail(`TRACE.md does not cover: ${missing.join(', ')}`);
  const T = taskRel(task.id);
  const allowed = [...cfg.paths.tests, `${T}/**`, '.team/DECISIONS.md', '.team/LEDGER.jsonl'];
  const changed = porcelainFiles(root);
  const offenders = changed.filter((f) => !matchAny(f, allowed));
  if (offenders.length) fail(`Files outside the scope of the TESTS phase changed:\n- ${offenders.join('\n- ')}`);
}

function freezeTests(root, task) {
  git(['add', '-A'], root);
  const staged = git(['diff', '--cached', '--name-only'], root);
  if (staged) git(['commit', '-m', `sat(${task.id}): freeze tests`], root);
  return headSha(root);
}

function archiveReviews(dir, cycle) {
  for (const name of ['REVIEW', 'SECURITY_AUDIT']) {
    const p = join(dir, `${name}.json`);
    if (existsSync(p)) renameSync(p, join(dir, `${name}.c${cycle}.json`));
  }
}

function cmdNext(root, cfg) {
  const task = requireActive(root);
  const dir = taskDir(root, task.id);
  switch (task.phase) {
    case 'INTAKE': {
      const req = readText(join(dir, 'REQUEST.md'));
      if (!req || req.trim().length < 3) fail('REQUEST.md is empty or missing.');
      return transition(root, task, 'INTERPRET');
    }
    case 'INTERPRET': {
      const ep = readExecPrompt(dir);
      if (ep.error) fail(ep.error);
      if (ep.data.proposed_path === 'full' && task.path === 'light') {
        task.path = 'full';
        appendLedger(root, { type: 'path_upgraded', task: task.id, reason: 'interpreter proposed full path' });
      }
      if (ep.data.blocking_questions > 0 || ep.data.sensitive_assumptions > 0) {
        if (task.interpret_round >= effectiveLimit(cfg, task, 'question_rounds'))
          return escalate(root, task, 'Question rounds are used up and blocking questions or sensitive assumptions remain');
        return transition(root, task, 'GATE_0', { blocking_questions: ep.data.blocking_questions, sensitive_assumptions: ep.data.sensitive_assumptions });
      }
      if (task.path === 'full') return transition(root, task, 'DESIGN');
      const { value, error } = readJSONFile(join(dir, 'TASKS.json'));
      if (error) fail(`The light path needs TASKS.json: ${error}`);
      const errs = validateTasks(value, task.id);
      if (errs.length) fail(errs.join('\n'));
      return transition(root, task, 'IMPLEMENT');
    }
    case 'DESIGN': {
      if (task.cr) {
        const decision = latestNumbered(dir, 'CHANGE_DECISION');
        if (!decision) fail('A change request is open: the architect must write CHANGE_DECISION-<n>.md');
        const { data } = parseFrontmatter(readText(decision));
        const cls = data && data.classification;
        if (!['clarification', 'scope_change'].includes(cls)) fail('CHANGE_DECISION: classification must be clarification or scope_change');
        const spec = checkSpecTrace(readText(join(dir, 'SPEC.md')) || '');
        if (spec.errors.length) fail(spec.errors.join('\n'));
        if (cls === 'clarification') {
          task.cr = null;
          return transition(root, task, 'TESTS', { cr_classification: cls });
        }
        return transition(root, task, 'THREAT', { cr_classification: cls });
      }
      const spec = readText(join(dir, 'SPEC.md'));
      if (!spec) fail('SPEC.md is missing.');
      const trace = checkSpecTrace(spec);
      if (trace.errors.length) fail(trace.errors.join('\n'));
      for (const f of ['ARCH.md', 'PLAN.md']) {
        const t = readText(join(dir, f));
        if (!t || t.trim().length < 40) fail(`${f} is missing or nearly empty.`);
      }
      return transition(root, task, 'THREAT');
    }
    case 'THREAT': {
      const raw = readText(join(dir, 'THREAT_MODEL.md'));
      if (!raw) fail('THREAT_MODEL.md is missing.');
      const tm = raw.replace(/<!--[\s\S]*?-->/g, '');
      if (extractIds(tm, 'AB').length === 0 && !/NO-ABUSE-CASES:\s*\S+/.test(tm))
        fail('THREAT_MODEL.md has no AB-n abuse cases and no "NO-ABUSE-CASES: <reason>" line.');
      return transition(root, task, 'GATE_1');
    }
    case 'TESTS': {
      checkTestsPhase(root, cfg, task, dir);
      const sha = freezeTests(root, task);
      task.frozen_sha = sha;
      task.verify_failures = 0;
      return transition(root, task, 'IMPLEMENT', { frozen_sha: sha });
    }
    case 'IMPLEMENT':
    case 'FIX': {
      const lv = task.last_verify;
      const head = headSha(root);
      if (!lv) fail('verify has not been run yet.');
      if (lv.result !== 'pass') fail(`The last verify run failed (${lv.dir}).`);
      if (lv.sha !== head || lv.dirty) fail('The last passing verify does not match the current HEAD, or ran on a dirty tree. Commit, then run verify again.');
      return transition(root, task, 'REVIEW', { verified_sha: head });
    }
    case 'REVIEW': {
      const rev = readJSONFile(join(dir, 'REVIEW.json'));
      if (rev.error) fail(rev.error);
      const errs = validateReview(rev.value);
      let findings = [...(rev.value.findings || [])];
      if (task.path === 'full') {
        const aud = readJSONFile(join(dir, 'SECURITY_AUDIT.json'));
        if (aud.error) fail(aud.error);
        errs.push(...validateAudit(aud.value));
        findings = findings.concat(aud.value.findings || []);
      }
      if (errs.length) fail(errs.join('\n'));
      const blocking = findings.filter(isBlocking);
      if (blocking.length) {
        if (task.fix_cycles >= effectiveLimit(cfg, task, 'fix_cycles'))
          return escalate(root, task, `Fix cycles are used up and ${blocking.length} blocking finding(s) remain`);
        task.fix_cycles += 1;
        task.verify_failures = 0;
        archiveReviews(dir, task.fix_cycles);
        return transition(root, task, 'FIX', { blocking: blocking.map((f) => f.id), cycle: task.fix_cycles });
      }
      return transition(root, task, 'REPORT');
    }
    case 'REPORT': {
      const rep = readText(join(dir, 'REPORT.md'));
      if (!rep) fail('REPORT.md is missing. Run report.mjs.');
      if (!task.report_hash || reportHash(rep) !== task.report_hash)
        fail('The generated sections of REPORT.md were edited by hand or not generated yet. Rerun report.mjs and edit only the risk section.');
      if (!tmSectionFilled(rep)) fail('The risk assessment section of REPORT.md is not written yet.');
      return transition(root, task, 'GATE_2');
    }
    default:
      if (GATES.includes(task.phase)) fail(`${task.phase} is a gate: it closes only with approve, after the owner decides.`);
      fail(`There is no automatic transition from ${task.phase}.`);
  }
  return undefined;
}

function cmdApprove(root, cfg, pos, opts) {
  const task = requireActive(root);
  const gate = pos[0];
  if (!GATES.includes(gate)) fail('approve needs a gate: GATE_0, GATE_1 or GATE_2');
  if (task.phase !== gate) fail(`The task is in ${task.phase}, not ${gate}.`);
  const decision = opts.decision || 'approve';
  if (!['approve', 'changes', 'cancel'].includes(decision)) fail('--decision: approve | changes | cancel');
  const note = typeof opts.note === 'string' ? opts.note.trim() : '';
  if (note.length < 2) fail('--note is required: quote the owner\'s decision verbatim.');
  const dir = taskDir(root, task.id);
  task.gates[gate] = [...(task.gates[gate] || []), { decision, note, at: new Date().toISOString(), mode: cfg.gates.approval }];
  if (decision === 'cancel') return transition(root, task, 'CANCELLED', { gate, note });
  if (gate === 'GATE_0') {
    if (decision !== 'approve') fail('Gate 0 accepts only approve or cancel.');
    const ans = readText(join(dir, 'ANSWERS.md'));
    if (!ans || ans.trim().length < 2) fail('Record the owner\'s reply verbatim in ANSWERS.md first.');
    task.interpret_round += 1;
    return transition(root, task, 'INTERPRET', { gate, note });
  }
  if (gate === 'GATE_1') {
    if (decision === 'changes') return transition(root, task, 'DESIGN', { gate, note });
    const { value, error } = readJSONFile(join(dir, 'TASKS.json'));
    if (error) fail(`TASKS.json: ${error}`);
    const errs = validateTasks(value, task.id);
    if (value && value.path !== task.path) errs.push(`TASKS.json: path (${value.path}) does not match the task path (${task.path})`);
    if (errs.length) fail(errs.join('\n'));
    task.cr = null;
    return transition(root, task, 'TESTS', { gate, note });
  }
  // GATE_2
  if (decision === 'changes') {
    const to = opts.to || 'FIX';
    if (!['FIX', 'DESIGN'].includes(to)) fail('--to must be FIX or DESIGN');
    task.verify_failures = 0;
    return transition(root, task, to, { gate, note });
  }
  return transition(root, task, 'CLOSED', { gate, note });
}

function cmdGoto(root, cfg, pos, opts) {
  const task = requireActive(root);
  if (pos[0] !== 'DESIGN') fail('goto supports DESIGN only (a change request).');
  if (!['IMPLEMENT', 'FIX'].includes(task.phase)) fail('A change request can be raised from IMPLEMENT or FIX only.');
  const cr = latestNumbered(taskDir(root, task.id), 'CHANGE_REQUEST');
  if (!cr) fail('There is no CHANGE_REQUEST-<n>.md.');
  task.cr = cr.split(/[\\/]/).pop();
  return transition(root, task, 'DESIGN', { reason: opts.reason || task.cr, change_request: task.cr });
}

function cmdResume(root, cfg, opts) {
  const task = requireActive(root);
  if (task.phase !== 'ESCALATED') fail('resume works only from ESCALATED.');
  const to = opts.to;
  const allowed = ['INTERPRET', 'DESIGN', 'TESTS', 'IMPLEMENT', 'FIX', 'REVIEW', 'REPORT'];
  if (!allowed.includes(to)) fail(`--to must be one of: ${allowed.join(', ')}`);
  const note = typeof opts.note === 'string' ? opts.note.trim() : '';
  if (note.length < 2) fail('--note is required: the owner\'s decision verbatim.');
  task.granted = task.granted || {};
  if (to === 'FIX' || to === 'IMPLEMENT') {
    task.granted.fix_cycles = (task.granted.fix_cycles || 0) + (task.fix_cycles >= effectiveLimit(cfg, task, 'fix_cycles') ? 1 : 0);
    task.verify_failures = 0;
  }
  if (to === 'INTERPRET') task.granted.question_rounds = (task.granted.question_rounds || 0) + 1;
  return transition(root, task, to, { note, resumed_from: task.escalated_from });
}

function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  const root = findRoot();
  if (!root) fail('Could not find .team/project.yaml in this folder or above it.');
  const cfg = loadProject(root);
  switch (cmd) {
    case 'new':
      return cmdNew(root, cfg, pos, opts);
    case 'status':
      return cmdStatus(root, cfg, opts);
    case 'next':
      return cmdNext(root, cfg);
    case 'approve':
      return cmdApprove(root, cfg, pos, opts);
    case 'goto':
      return cmdGoto(root, cfg, pos, opts);
    case 'escalate': {
      const task = requireActive(root);
      if (!pos[0]) fail('A reason is required.');
      return escalate(root, task, pos[0]);
    }
    case 'resume':
      return cmdResume(root, cfg, opts);
    case 'cancel': {
      const task = requireActive(root);
      return transition(root, task, 'CANCELLED', { note: opts.note || '' });
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).join('\n'));
      return process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (e) {
  console.error(`[SAT] ✗ ${e.message}`);
  process.exit(e instanceof PhaseError ? 2 : 1);
}
