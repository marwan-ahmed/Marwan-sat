// Marwan SAT — doctor: is this project ready for the team? (charter §14.2)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../../core/bin/lib/yaml.mjs';
import { COMMAND_ORDER, loadProject } from '../../core/bin/lib/config.mjs';
import { headSha, isGitRepo, porcelainFiles, remoteUrl } from '../../core/bin/lib/git.mjs';
import { commandExists, firstToken, runShell } from '../../core/bin/lib/proc.mjs';
import { readLock } from '../../core/bin/lib/scope.mjs';
import { HOOK_KEY } from '../../adapters/antigravity/generate.mjs';
import { SAT_PATHS, locallyModified, satVersion } from './install.mjs';
import { satCommand } from './invoke.mjs';

const ROLE_IDS = ['tech-manager', 'request-interpreter', 'architect', 'security-auditor', 'test-author', 'implementer', 'adversarial-reviewer'].map((r) => `marwan-sat-${r}`);

export function doctor({ root, satRoot, run = true }) {
  const results = [];
  const add = (level, title, detail = '') => results.push({ level, title, detail });

  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 20 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? '' : 'version 20 or newer is required');

  if (!isGitRepo(root)) {
    add('fail', 'git', 'this folder is not a git repository');
  } else {
    add(headSha(root) ? 'ok' : 'fail', 'git: initial commit', headSha(root) ? '' : 'there are no commits yet');
    const url = remoteUrl(root);
    add(url && /github\.com/i.test(url) ? 'ok' : 'warn', 'GitHub remote', url || 'no remote named origin');
    // Uncommitted work: SAT's own files vs the owner's. Mixing them in one commit hides the project's changes.
    const runtime = /^\.team\/(STATE\.json|LEDGER\.jsonl|evidence\/|tasks\/)/;
    const dirty = porcelainFiles(root).filter((f) => !runtime.test(f));
    const isSat = (f) => SAT_PATHS.some((p) => f === p || f.startsWith(`${p}/`));
    const satDirty = dirty.filter(isSat);
    const ownDirty = dirty.filter((f) => !isSat(f));
    add(satDirty.length ? 'warn' : 'ok', 'SAT files are committed', satDirty.length ? `${satDirty.length} uncommitted: git add ${SAT_PATHS.join(' ')}` : '');
    add(ownDirty.length ? 'warn' : 'ok', 'no uncommitted project changes', ownDirty.length ? `${ownDirty.length} files (e.g. ${ownDirty.slice(0, 3).join(', ')}): commit them in their own commit, not with SAT. A task cannot start on a dirty tree.` : '');
  }

  const lock = readLock(root);
  if (!lock) {
    add('fail', 'SAT install', `sat.lock is missing: run ${satCommand(satRoot, satVersion(satRoot))} init`);
    return results;
  }
  const cliVersion = satVersion(satRoot);
  add(lock.sat_version === cliVersion ? 'ok' : 'warn', `SAT version in the project: ${lock.sat_version}`, lock.sat_version === cliVersion ? '' : `this sat is ${cliVersion}: run ${satCommand(satRoot, cliVersion)} update`);

  let cfg;
  try {
    cfg = loadProject(root);
    add('ok', 'project.yaml is valid');
  } catch (e) {
    add('fail', 'project.yaml', e.message);
    return results;
  }

  const modified = locallyModified(root, lock);
  add(modified.length ? 'fail' : 'ok', 'managed and generated template files are intact', modified.join(', '));

  const agentsDir = join(root, '.agents', 'agents');
  const missing = ROLE_IDS.filter((id) => !existsSync(join(agentsDir, `${id}.md`)));
  add(missing.length ? 'fail' : 'ok', 'the seven agent files in .agents/agents', missing.length ? `missing: ${missing.join(', ')}` : '');
  const hooksPath = join(root, '.agents', 'hooks.json');
  let hookOk = false;
  try {
    hookOk = Boolean(JSON.parse(readFileSync(hooksPath, 'utf8'))[HOOK_KEY]);
  } catch {
    hookOk = false;
  }
  add(hookOk ? 'ok' : 'fail', 'guard is registered in .agents/hooks.json');
  // Live self-test: run the hook command exactly as Antigravity does (`node .team/bin/guard.mjs`, JSON on stdin),
  // from the project root and from .agents/ (where Antigravity actually runs workspace hooks), and expect both
  // to block a protected file. No workspacePaths in the payload: the guard must find the root by itself.
  const probeIn = JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: join(root, '.team', 'CHARTER.md') } } });
  const probeFails = [];
  for (const [where, cwd] of [['project root', root], ['.agents/', join(root, '.agents')]]) {
    const probe = spawnSync(process.execPath, [join('.team', 'bin', 'guard.mjs')], { cwd, encoding: 'utf8', timeout: 10000, input: probeIn });
    let decision = null;
    try {
      decision = JSON.parse(probe.stdout).decision;
    } catch {
      decision = null;
    }
    if (decision !== 'deny') {
      const err = (probe.stderr || (probe.error && probe.error.message) || 'no output').trim().split('\n').slice(-2).join(' | ');
      probeFails.push(`from ${where}: ${decision || err}`);
    }
  }
  add(probeFails.length ? 'fail' : 'ok', 'guard works on this machine (live test from the root and from .agents/: it blocks a protected file)', probeFails.length ? `${probeFails.join('; ')} — run: ${satCommand(satRoot, satVersion(satRoot))} update` : '');
  if (existsSync(agentsDir)) {
    const known = JSON.parse(readFileSync(join(satRoot, 'adapters', 'antigravity', 'tools.json'), 'utf8'));
    const used = new Set();
    const subagents = [];
    for (const f of readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
      const { data } = parseFrontmatter(readFileSync(join(agentsDir, f), 'utf8'));
      for (const t of (data && data.tools) || []) used.add(t);
      if (data && data.subagent !== false && data.name) subagents.push(String(data.name));
    }
    const t = toolNamesVerdict(known, used, { subagents, seen: delegationsSeen(root, subagents) });
    add(t.level, t.title, t.detail);
  }
  add(existsSync(join(root, '.github', 'workflows', 'sat-verify.yml')) ? 'ok' : 'fail', 'CI workflow: .github/workflows/sat-verify.yml');

  const gi = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
  add(gi.includes('.team/STATE.json') ? 'ok' : 'warn', '.gitignore excludes the SAT temporary files');
  add(existsSync(join(root, 'AGENTS.md')) ? 'ok' : 'warn', 'AGENTS.md (project rules)', existsSync(join(root, 'AGENTS.md')) ? '' : 'not found: consider adding one, for example from the arabic-agents template');

  for (const name of [...COMMAND_ORDER, 'start']) {
    const cmd = cfg.commands[name];
    if (!cmd) {
      add(name === 'test' ? 'warn' : 'info', `command ${name}`, 'not configured');
      continue;
    }
    const bin = firstToken(cmd);
    if (!commandExists(bin)) {
      add('fail', `command ${name}`, `${bin} was not found: ${cmd}`);
      continue;
    }
    if (!run || name === 'start') {
      add('ok', `command ${name}`, `${cmd} (not run)`);
      continue;
    }
    const r = runShell(cmd, { cwd: root, timeoutMs: cfg.timeouts.step_minutes * 60 * 1000 });
    add(r.exitCode === 0 ? 'ok' : 'fail', `command ${name}`, r.exitCode === 0 ? cmd : `${cmd} → exit ${r.exitCode}\n${(r.stderr || r.stdout).split('\n').slice(-8).join('\n')}`);
  }

  for (const [k, cmd] of Object.entries(cfg.security.scanners)) {
    if (!cmd) {
      add('warn', `scanner ${k}`, 'not configured: the report will list it under what was not tested');
      continue;
    }
    const bin = firstToken(cmd);
    add(commandExists(bin) ? 'ok' : 'warn', `scanner ${k}`, commandExists(bin) ? cmd : `${bin} is not installed locally (required in CI)`);
  }
  add(
    cfg.security.scan_scope === 'diff' ? 'info' : 'warn',
    `scanner scope: ${cfg.security.scan_scope}`,
    cfg.security.scan_scope === 'diff'
      ? 'scanners judge only each change against its base; pre-existing debt is reported, not blocking'
      : 'whole-repository scans: any pre-existing finding in the project fails every task',
  );

  const env = cfg.security.attack_env;
  if (cfg.security.profile === 'web' && env === 'none') add('warn', 'attack environment', 'attack_env = none: the security audit will be INCOMPLETE on the axes that need dynamic testing');
  else if (env !== 'none' && !cfg.security.env_up) add('warn', 'attack environment', `attack_env = ${env} but env_up is not configured`);
  else if (env === 'neon-branch') add(commandExists('neonctl') ? 'ok' : 'warn', 'attack environment: neonctl');
  else if (env.startsWith('docker')) add(commandExists('docker') ? 'ok' : 'warn', 'attack environment: docker');

  const bp = protectionVerdict(cfg.git.branch_protection, cfg.git.base_branch, readProtection(root, cfg.git.base_branch));
  add(bp.level, bp.title, bp.detail);

  return results;
}

// Branch protection — the third guarantee (charter §14.2): only the owner merges into the base branch.
// SAT agents act with the owner's GitHub identity, so a rule the owner can bypass does not stop them:
// it counts only if it requires a pull request and admins cannot bypass it.
const PROTECT_HOW = 'GitHub → Settings → Branches → a rule for the base branch with "Require a pull request before merging" and "Do not allow bypassing the above settings"';
const ACCEPT_HOW = 'or, if you accept the risk, set git.branch_protection: accepted_risk in .team/project.yaml and record why in .team/DECISIONS.md';

// Reads the protection of the base branch through gh. Returns a state for protectionVerdict.
export function readProtection(root, base) {
  if (!commandExists('gh')) return { state: 'unverifiable', why: 'GitHub CLI (gh) is not installed, so it cannot be checked: winget install GitHub.cli, then gh auth login' };
  const gh = (args) => spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const name = repo.status === 0 ? repo.stdout.trim() : '';
  if (!name) return { state: 'unverifiable', why: 'gh could not read this repository (no GitHub remote, or gh is not signed in: gh auth login)' };
  const branch = encodeURIComponent(base);
  return interpretProtection(gh(['api', `repos/${name}/branches/${branch}/protection`]), () => gh(['api', `repos/${name}/rules/branches/${branch}`]));
}

// Pure: classic is the answer of GET …/branches/<base>/protection; rules() fetches GET …/rules/branches/<base>.
export function interpretProtection(classic, rules) {
  const text = (r) => `${r.stdout || ''}\n${r.stderr || ''}`;
  const planBlocked = (r) => /upgrade to github pro|make this repository public/i.test(text(r));
  if (classic.status === 0) {
    let p;
    try {
      p = JSON.parse(classic.stdout);
    } catch {
      return { state: 'unverifiable', why: 'GitHub returned an unreadable answer' };
    }
    const missing = [];
    if (!p.required_pull_request_reviews) missing.push('"Require a pull request before merging"');
    if (!(p.enforce_admins && p.enforce_admins.enabled)) missing.push('"Do not allow bypassing the above settings"');
    return missing.length ? { state: 'weak', missing } : { state: 'enforced' };
  }
  if (planBlocked(classic)) return { state: 'plan' };
  if (!/branch not protected|HTTP 404/i.test(text(classic))) return { state: 'unverifiable', why: 'your GitHub account could not read the protection settings' };
  // No classic rule: the branch may still be protected by a repository ruleset.
  const r = rules();
  if (r.status !== 0) return planBlocked(r) ? { state: 'plan' } : { state: 'unverifiable', why: 'the repository rulesets could not be read' };
  let list = [];
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return { state: 'unverifiable', why: 'GitHub returned an unreadable answer' };
  }
  return Array.isArray(list) && list.some((x) => x && x.type === 'pull_request') ? { state: 'ruleset' } : { state: 'off' };
}

// Pure: the doctor line for a protection state under the project's policy (git.branch_protection).
export function protectionVerdict(policy, base, s) {
  const title = `Branch protection on ${base}`;
  if (s.state === 'enforced') return { level: 'ok', title, detail: 'a pull request is required and admins cannot bypass it' };
  if (s.state === 'ruleset') return { level: 'ok', title, detail: 'a ruleset requires a pull request; make sure you are not in its bypass list (SAT agents act with your GitHub identity)' };
  const why = {
    weak: `on, but missing ${(s.missing || []).join(' and ')}: SAT agents act with your GitHub identity, so whatever you can bypass, they can too`,
    off: `off: ${PROTECT_HOW}`,
    plan: 'GitHub offers it for private repositories on paid plans only (GitHub Pro or higher): upgrade, then turn it on',
    unverifiable: `not verified: ${s.why}`,
  }[s.state] || `not verified: ${s.why || s.state}`;
  if (policy === 'accepted_risk')
    return { level: 'warn', title, detail: `${why}. Risk accepted in project.yaml (git.branch_protection: accepted_risk): only guard stands between an agent and ${base}, and guard is not a final guarantee` };
  return { level: 'fail', title, detail: `${why}; ${ACCEPT_HOW}` };
}

// Pure: are the tool names used by the generated agents known, and confirmed by a real run in Antigravity?
// A confirmation is recorded in adapters/antigravity/tools.json only after such a run; it covers the names it lists.
export function toolNamesVerdict(known, used, { subagents = [], seen = new Set() } = {}) {
  const title = 'Antigravity tool names';
  const knownNames = new Set(Object.values(known.capabilities || {}).flat());
  const unknown = [...used].filter((t) => !knownNames.has(t));
  if (unknown.length) return { level: 'fail', title, detail: `unknown: ${unknown.join(', ')}` };
  const confirmed = new Set(known.confirmed && Array.isArray(known.confirmed.names) ? known.confirmed.names : []);
  const unconfirmed = [...used].filter((t) => !confirmed.has(t));
  if (!unconfirmed.length) return { level: 'ok', title, detail: `confirmed in a real run on ${known.confirmed.on}; if Antigravity renames a tool, an agent can hang: report it` };
  // Evidence from this project: Antigravity's own hook recorded the tech manager starting every subagent.
  if (subagents.length && subagents.every((a) => seen.has(a)))
    return { level: 'ok', title, detail: `all ${subagents.length} subagents were started in this project (hook evidence: .team/evidence/delegations.jsonl)` };
  return { level: 'warn', title, detail: `${unconfirmed.join(', ')} — documented, but open each agent once in Antigravity to confirm (a wrong name can hang an agent)` };
}

// Which subagents the hook saw the tech manager start (guard records every invoke_subagent call).
export function delegationsSeen(root, names) {
  const seen = new Set();
  const p = join(root, '.team', 'evidence', 'delegations.jsonl');
  if (!existsSync(p)) return seen;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const text = Object.values(e.args || {}).join(' ');
    for (const n of names) if (new RegExp(`(^|[^a-z0-9-])${n}($|[^a-z0-9-])`).test(text)) seen.add(n);
  }
  return seen;
}
