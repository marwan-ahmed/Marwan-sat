#!/usr/bin/env node
// Marwan SAT — phase: the task state machine (charter §5, §6, §7).
//
//   node .team/bin/phase.mjs new "<title>" [--path full|light]
//   node .team/bin/phase.mjs new "<title>" --kind audit          # discover work: findings → backlog (charter §5.5)
//   node .team/bin/phase.mjs new --from TASK-<n>:B-<m>            # open a task from an approved audit backlog
//   node .team/bin/phase.mjs status [--json]
//   node .team/bin/phase.mjs next
//   node .team/bin/phase.mjs approve <GATE_0|GATE_1|GATE_START|GATE_2|GATE_A> --decision <approve|changes|cancel> [--to <PHASE>] --note "<owner's words>"
//     An approval of GATE_1 (plan), GATE_START (start), GATE_2 (result) or GATE_A (backlog) is recorded only when
//     --note is exactly the owner's reply phrase from project.yaml (gates.phrases).
//   node .team/bin/phase.mjs goto DESIGN --reason "<CHANGE_REQUEST-n>"
//   node .team/bin/phase.mjs escalate "<reason>"
//   node .team/bin/phase.mjs resume --to <PHASE> --note "<owner decision>"
//   node .team/bin/phase.mjs cancel --note "<reason>"
//
// Only this tool changes the phase. Agents cannot write STATE.json or task.json (guard.mjs).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadProject } from './lib/config.mjs';
import { auditScopeErrors, checkAudit, FROM_MARKER } from './lib/audit.mjs';
import { checkSpecTrace, extractIds, isBlocking, latestNumbered, readExecPrompt, readJSONFile, readText, validateAudit, validateReview, validateTasks } from './lib/contracts.mjs';
import { currentBranch, git, headSha, isGitRepo, porcelainFiles } from './lib/git.mjs';
import { matchAny } from './lib/glob.mjs';
import { reportHash, tmSectionFilled } from './lib/report-hash.mjs';
import { activeTask, appendLedger, AUDIT_PHASES, GATES, listTasks, nextTaskId, readJSON, readState, taskDir, taskRel, TERMINAL, writeState, writeTask } from './lib/state.mjs';
import { GATE_PHRASE, hasStarted, phraseMatches, stageOf } from './lib/plain.mjs';
import { parseFrontmatter } from './lib/yaml.mjs';

const NEXT_ACTOR = {
  INTAKE: 'marwan-sat-tech-manager: write REQUEST.md with the owner\'s request verbatim, then run phase next.',
  INTERPRET: 'Call marwan-sat-request-interpreter to write EXEC_PROMPT.md (on the light path the tech manager then writes TASKS.json), then phase next.',
  GATE_0: 'Gate 0: show the questions and assumptions to the owner verbatim, record the reply verbatim in ANSWERS.md, then approve GATE_0.',
  DESIGN: 'Call marwan-sat-architect to write SPEC.md, ARCH.md and PLAN.md, then phase next.',
  THREAT: 'Call marwan-sat-security-auditor (threat model mode) to write THREAT_MODEL.md, then phase next.',
  GATE_1: 'Gate 1 — plan approval (preparation; nothing changes yet). On the full path write TASKS.json from PLAN.md. Present the plan to the owner in your Gate 1 format ({audience} audience). Record it only when the owner replies exactly «{plan}»: approve GATE_1 --note "{plan}".',
  GATE_START: 'Start permission — a separate question from the plan. Ask the owner whether the team may start changing the project now. Record it only when the owner replies exactly «{start}»: approve GATE_START --note "{start}". Any other reply, including an approval of the plan, "ok" or "تمام", is not permission: the task waits here.',
  TESTS: 'Call marwan-sat-test-author to write the tests and TRACE.md, then phase next (it creates the freeze commit).',
  IMPLEMENT: 'Call marwan-sat-implementer: implement, commit, then verify. After verify passes, run phase next.',
  REVIEW: 'Call marwan-sat-adversarial-reviewer (and, on the full path, marwan-sat-security-auditor in audit mode) in parallel, then phase next.',
  FIX: 'Call marwan-sat-implementer to fix the blocking findings only, then verify, then phase next.',
  REPORT: 'Run report.mjs, write only the risk assessment section, push the branch and open a PR, then phase next.',
  GATE_2: 'Gate 2: show REPORT.md and the PR link to the owner ({audience} audience). Only the owner merges. Record the approval only when the owner replies exactly «{result}».',
  ESCALATED: 'The task is paused. Present the escalation to the owner in the charter §7.6 format, then resume with their decision.',
  INVENTORY: 'Run node .team/bin/verify.mjs once (scanner evidence), then call marwan-sat-architect (inventory mode) to write INVENTORY.json, then phase next.',
  FINDINGS: 'Call marwan-sat-security-auditor, marwan-sat-adversarial-reviewer and marwan-sat-architect (audit mode) in parallel; each writes only its own findings file. Then phase next.',
  CHALLENGE: 'Call marwan-sat-adversarial-reviewer (challenges security.json and gaps.json) and marwan-sat-security-auditor (challenges logic-money.json) in parallel. Then phase next.',
  BACKLOG: 'Run node .team/bin/backlog.mjs and write only the tech-manager section of BACKLOG.md, then phase next.',
  GATE_A: 'Commit the task folder only, push the branch and open a PR. Then Gate A: show BACKLOG.md and the PR link to the owner ({audience} audience). The owner merges; record the approval only when the owner replies exactly «{backlog}». Approving the list starts nothing: each item is prepared later, on the owner\'s request.',
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

// The next-actor hint with this project's reply phrases and audience filled in.
function nextText(cfg, phase) {
  const t = NEXT_ACTOR[phase] || '';
  const ph = (cfg && cfg.gates && cfg.gates.phrases) || {};
  return t
    .replace(/\{(plan|start|result|backlog)\}/g, (_, k) => ph[k] || k)
    .replace(/\{audience\}/g, () => (cfg && cfg.owner ? cfg.owner.audience : 'simple'));
}

function transition(root, task, to, extra = {}) {
  const from = task.phase;
  task.phase = to;
  task.history = [...(task.history || []), { phase: to, at: new Date().toISOString(), from, ...extra }];
  writeTask(root, task);
  writeState(root, { active_task: TERMINAL.includes(to) ? null : task.id, phase: to, last_task: task.id });
  appendLedger(root, { type: 'phase', task: task.id, from, to, ...extra });
  console.log(`[SAT] ${task.id}: ${from} → ${to}`);
  let cfg = null;
  try {
    cfg = loadProject(root);
  } catch {
    /* the hint falls back to the default phrases */
  }
  const stage = stageOf(task);
  if (stage.badge) console.log(`[SAT] Stage for the owner: ${stage.badge}`);
  console.log(`[SAT] Next: ${nextText(cfg, to)}`);
}

function escalate(root, task, reason) {
  task.escalated_from = task.phase;
  transition(root, task, 'ESCALATED', { reason });
}

function effectiveLimit(cfg, task, key) {
  return cfg.limits[key] + ((task.granted && task.granted[key]) || 0);
}

// "TASK-002:B-03" → the backlog item of a merged audit, its draft request and its dependencies.
function loadBacklogItem(root, ref) {
  const m = /^(TASK-\d+):(B-\d+)$/.exec(String(ref || ''));
  if (!m) fail('--from needs an audit task and a backlog item, e.g. --from TASK-002:B-03');
  const [, auditId, itemId] = m;
  const dir = taskDir(root, auditId);
  const audit = readJSON(join(dir, 'task.json'), null);
  if (!audit || audit.kind !== 'audit') fail(`${auditId} is not an audit task on this branch. Merge the audit PR, then: git checkout <base branch> and git pull.`);
  const { value: backlog, error } = readJSONFile(join(dir, 'BACKLOG.json'));
  if (error) fail(`${auditId} has no BACKLOG.json on this branch: merge the audit PR first (${error})`);
  const item = (backlog.items || []).find((x) => x.id === itemId);
  if (!item) fail(`${auditId} has no backlog item ${itemId}. Items: ${(backlog.items || []).map((x) => x.id).join(', ')}`);
  const request = readText(join(dir, 'requests', `${itemId}.md`));
  if (!request || !request.includes(FROM_MARKER(auditId, itemId))) fail(`requests/${itemId}.md of ${auditId} is missing or was edited by hand: rerun backlog.mjs in the audit.`);
  return { auditId, item, request };
}

// Items already delivered: a task opened from the item whose files reached this (base) branch through a merged
// PR. A PR carries the task at GATE_2 (it is committed after the report), or CLOSED if committed later.
function doneFromBacklog(root, auditId) {
  const done = new Set();
  for (const id of listTasks(root)) {
    const t = readJSON(join(taskDir(root, id), 'task.json'), null);
    if (t && t.source && t.source.audit === auditId && ['GATE_2', 'CLOSED'].includes(t.phase)) done.add(t.source.item);
  }
  if (existsSync(join(root, 'AGENTS.md'))) done.add('__agents_md__');
  return done;
}

function cmdNew(root, cfg, pos, opts) {
  const kind = opts.kind || 'change';
  if (!['change', 'audit'].includes(kind)) fail('--kind must be change or audit');
  if (opts.from && kind === 'audit') fail('--from opens a change task from a backlog item; it cannot be combined with --kind audit');
  const from = opts.from ? loadBacklogItem(root, opts.from) : null;
  const title = pos[0] || (from && from.item.title);
  if (!title) fail('A title is required: phase new "<title>"');
  if (kind === 'audit' && opts.path) fail('An audit task has no path: it changes no code. Drop --path.');
  const path = kind === 'audit' ? null : opts.path || (from ? from.item.path : 'full');
  if (kind !== 'audit' && !['full', 'light'].includes(path)) fail('--path must be full or light');
  if (from && from.item.path === 'full' && path === 'light') fail(`${from.item.id} needs the full path (${from.item.path_reason || 'sensitive'}): a backlog item cannot be downgraded to light.`);
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
    kind,
    path,
    source: from ? { audit: from.auditId, item: from.item.id } : null,
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
  appendLedger(root, { type: 'task_created', task: id, title, kind, path, branch, base_ref: baseRef, base_sha: sha, ...(from ? { from: `${from.auditId}:${from.item.id}` } : {}) });
  const label = kind === 'audit' ? 'audit' : path === 'full' ? 'full path' : 'light path';
  console.log(`[SAT] Created task ${id} (${label}) on branch ${branch}`);
  if (from) {
    // The owner approved this request at Gate A of the audit; it is copied verbatim, like any request.
    writeFileSync(join(taskDir(root, id), 'REQUEST.md'), from.request, 'utf8');
    console.log(`[SAT] REQUEST.md copied from ${from.auditId} requests/${from.item.id}.md (priority ${from.item.priority}).`);
    const done = doneFromBacklog(root, from.auditId);
    for (const d of from.item.depends_on || []) if (!done.has(d.item) && !(d.type === 'governance' && done.has('__agents_md__'))) console.log(`[SAT] ! ${from.item.id} depends on ${d.item} (${d.type}: ${d.reason}), which has not been delivered on this branch yet.`);
    for (const c of from.item.conflicts_with || []) console.log(`[SAT] ! ${from.item.id} conflicts with ${c.item}: ${c.note}`);
    if ((from.item.confirm_first || []).length) console.log(`[SAT] ! Confirm first: ${from.item.confirm_first.map((c) => c.id).join(', ')} (see REQUEST.md).`);
    console.log('[SAT] Next: REQUEST.md is ready — run phase next.');
    return;
  }
  console.log(`[SAT] Next: ${nextText(cfg, 'INTAKE')}`);
}

function cmdStatus(root, cfg, opts) {
  const st = readState(root);
  const task = st && st.active_task ? activeTask(root) : null;
  const out = task
    ? {
        active_task: task.id,
        title: task.title,
        kind: task.kind || 'change',
        path: task.path,
        source: task.source || null,
        phase: task.phase,
        branch: task.branch,
        base_sha: task.base_sha,
        frozen_sha: task.frozen_sha,
        fix_cycles: `${task.fix_cycles}/${effectiveLimit(cfg, task, 'fix_cycles')}`,
        verify_failures: `${task.verify_failures}/${effectiveLimit(cfg, task, 'verify_failures')}`,
        interpret_round: `${task.interpret_round}/${effectiveLimit(cfg, task, 'question_rounds')}`,
        last_verify: task.last_verify,
        started: hasStarted(task),
        stage: stageOf(task).badge,
        audience: cfg.owner.audience,
        required_reply: GATE_PHRASE[task.phase] ? cfg.gates.phrases[GATE_PHRASE[task.phase]] : null,
        next: nextText(cfg, task.phase),
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
      return transition(root, task, task.kind === 'audit' ? 'INVENTORY' : 'INTERPRET');
    }
    case 'INVENTORY':
    case 'FINDINGS':
    case 'CHALLENGE': {
      const scope = auditScopeErrors(root, task, cfg);
      if (scope.length) fail(scope.join('\n'));
      const stage = task.phase.toLowerCase();
      const { errors } = checkAudit(root, cfg, task, stage);
      if (errors.length) fail(`${task.phase} is not complete:\n- ${errors.join('\n- ')}`);
      return transition(root, task, { INVENTORY: 'FINDINGS', FINDINGS: 'CHALLENGE', CHALLENGE: 'BACKLOG' }[task.phase]);
    }
    case 'BACKLOG': {
      const scope = auditScopeErrors(root, task, cfg);
      if (scope.length) fail(scope.join('\n'));
      const md = readText(join(dir, 'BACKLOG.md'));
      if (!md || !existsSync(join(dir, 'BACKLOG.json'))) fail('BACKLOG.md or BACKLOG.json is missing. Run backlog.mjs.');
      if (!task.backlog_hash || reportHash(md) !== task.backlog_hash)
        fail('The generated sections of BACKLOG.md were edited by hand or not generated yet. Rerun backlog.mjs and edit only the tech-manager section.');
      if (!tmSectionFilled(md)) fail('The tech-manager section of BACKLOG.md is not written yet.');
      return transition(root, task, 'GATE_A');
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
      return transition(root, task, 'GATE_1');
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
      if (cfg.owner.audience === 'simple')
        for (const f of findings)
          if (['critical', 'high', 'medium'].includes(f.severity) && !(typeof f.plain === 'string' && f.plain.trim()))
            errs.push(`${f.id}: "plain" is required (owner.audience is simple): one sentence a non-programmer understands — what could happen, to whom.`);
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
  if (!GATES.includes(gate)) fail(`approve needs a gate: ${GATES.join(', ')}`);
  if (task.phase !== gate) fail(`The task is in ${task.phase}, not ${gate}.`);
  const decision = opts.decision || 'approve';
  if (!['approve', 'changes', 'cancel'].includes(decision)) fail('--decision: approve | changes | cancel');
  const note = typeof opts.note === 'string' ? opts.note.trim() : '';
  if (note.length < 2) fail('--note is required: quote the owner\'s decision verbatim.');
  // An approval is the owner's exact phrase, never a paraphrase: "ok", "تمام", or the plan's phrase at the
  // start gate are not approvals (charter §6.2). Nothing is recorded when the reply does not match.
  const key = GATE_PHRASE[gate];
  if (decision === 'approve' && key && !phraseMatches(note, cfg.gates.phrases[key]))
    fail(
      `This reply does not approve ${gate}. The owner must reply exactly: «${cfg.gates.phrases[key]}». Nothing was recorded; the task stays in ${gate}.` +
        (gate === 'GATE_START' ? ' Approving the plan is not permission to start.' : ''),
    );
  const dir = taskDir(root, task.id);
  task.gates[gate] = [...(task.gates[gate] || []), { decision, note, at: new Date().toISOString(), mode: cfg.gates.approval }];
  if (decision === 'cancel') return transition(root, task, 'CANCELLED', { gate, note });
  if (gate === 'GATE_A') {
    if (decision === 'changes') {
      const to = opts.to || 'FINDINGS';
      if (!['INVENTORY', 'FINDINGS', 'CHALLENGE'].includes(to)) fail('--to must be INVENTORY, FINDINGS or CHALLENGE');
      return transition(root, task, to, { gate, note });
    }
    return transition(root, task, 'CLOSED', { gate, note });
  }
  if (gate === 'GATE_0') {
    if (decision !== 'approve') fail('Gate 0 accepts only approve or cancel.');
    const ans = readText(join(dir, 'ANSWERS.md'));
    if (!ans || ans.trim().length < 2) fail('Record the owner\'s reply verbatim in ANSWERS.md first.');
    task.interpret_round += 1;
    return transition(root, task, 'INTERPRET', { gate, note });
  }
  const backToPlan = task.path === 'light' ? 'INTERPRET' : 'DESIGN';
  if (gate === 'GATE_1') {
    if (decision === 'changes') return transition(root, task, backToPlan, { gate, note });
    const { value, error } = readJSONFile(join(dir, 'TASKS.json'));
    if (error) fail(`TASKS.json: ${error}`);
    const errs = validateTasks(value, task.id);
    if (value && value.path !== task.path) errs.push(`TASKS.json: path (${value.path}) does not match the task path (${task.path})`);
    if (errs.length) fail(errs.join('\n'));
    task.cr = null;
    return transition(root, task, 'GATE_START', { gate, note });
  }
  if (gate === 'GATE_START') {
    if (decision === 'changes') return transition(root, task, backToPlan, { gate, note });
    task.started = { at: new Date().toISOString(), note };
    return transition(root, task, task.path === 'light' ? 'IMPLEMENT' : 'TESTS', { gate, note });
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
  const allowed = task.kind === 'audit' ? AUDIT_PHASES.filter((p) => p !== 'GATE_A') : ['INTERPRET', 'DESIGN', 'TESTS', 'IMPLEMENT', 'FIX', 'REVIEW', 'REPORT'];
  if (!allowed.includes(to)) fail(`--to must be one of: ${allowed.join(', ')}`);
  if (['TESTS', 'IMPLEMENT', 'FIX', 'REVIEW', 'REPORT'].includes(to) && !hasStarted(task))
    fail(`${to} changes the project, and the owner has not given start permission yet. Resume to ${task.path === 'light' ? 'INTERPRET' : 'INTERPRET or DESIGN'}; the start gate comes after the plan.`);
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
