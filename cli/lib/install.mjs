// Marwan SAT — install / update / regenerate primitives.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { generate as generateAntigravity, HOOK_KEY } from '../../adapters/antigravity/generate.mjs';
import { toPosix } from '../../core/bin/lib/glob.mjs';
import { sha256, sha256File } from '../../core/bin/lib/proc.mjs';

export const LOCK_REL = '.team/sat.lock';
export const GITIGNORE_BLOCK = ['# Marwan SAT — runtime files (not committed)', '.team/STATE.json', '.team/evidence/', '.team/tasks/*/evidence/', 'sat-evidence/'];

export function satVersion(satRoot) {
  return JSON.parse(readFileSync(join(satRoot, 'package.json'), 'utf8')).version;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(toPosix(relative(base, p)));
  }
  return out;
}

const norm = (text) => text.replace(/\r\n/g, '\n');
export const contentHash = (text) => sha256(norm(text));

// Files SAT owns inside the host project. They are replaced on update.
export function managedFiles(satRoot, stack) {
  const files = {};
  files['.team/CHARTER.md'] = readFileSync(join(satRoot, 'charter', 'CHARTER.md'), 'utf8');
  // MIT requires the copyright notice to travel with every copy of SAT, including installed ones.
  files['.team/LICENSE'] = readFileSync(join(satRoot, 'LICENSE'), 'utf8');
  for (const [src, dest] of [
    ['core/roles', '.team/roles'],
    ['core/templates', '.team/templates'],
    ['core/schemas', '.team/schemas'],
    ['core/bin', '.team/bin'],
  ]) {
    for (const rel of walk(join(satRoot, src))) files[`${dest}/${rel}`] = readFileSync(join(satRoot, src, rel), 'utf8');
  }
  const common = readFileSync(join(satRoot, 'stacks', 'common', 'sensitive-paths.txt'), 'utf8');
  const stackList = join(satRoot, 'stacks', stack, 'sensitive-paths.txt');
  files['.team/sensitive-paths.txt'] = existsSync(stackList) ? `${common.trimEnd()}\n\n${readFileSync(stackList, 'utf8')}` : common;
  return files;
}

// Files SAT regenerates from project.yaml (platform adapter + CI).
export function generatedFiles(satRoot, cfg, root) {
  if (cfg.project.platform !== 'antigravity') throw new Error(`المنصة ${cfg.project.platform} مخطط لها في إصدار لاحق. استخدم antigravity.`);
  const files = generateAntigravity({ satRoot, cfg, root });
  const stack = cfg.project.stack;
  const setupPath = join(satRoot, 'stacks', stack, 'ci-setup.yml');
  const setup = existsSync(setupPath) ? readFileSync(setupPath, 'utf8').trimEnd() : '      # no stack-specific setup';
  const tpl = readFileSync(join(satRoot, 'ci', 'sat-verify.yml.tpl'), 'utf8');
  const ciVersions = JSON.parse(readFileSync(join(satRoot, 'ci', 'versions.json'), 'utf8'));
  files['.github/workflows/sat-verify.yml'] = tpl
    .replace('@@STACK_SETUP@@', () => `${setup}\n`)
    .replace('@@GITLEAKS_VERSION@@', () => ciVersions.gitleaks)
    .replace(/@@BASE_BRANCH@@/g, () => cfg.git.base_branch);
  return files;
}

// hooks.json is shared with the project's own hooks: only our key is tracked.
export function trackedHash(rel, text) {
  if (rel === '.agents/hooks.json') {
    try {
      const obj = JSON.parse(text);
      return sha256(JSON.stringify(obj[HOOK_KEY] || null));
    } catch {
      return 'invalid-json';
    }
  }
  return contentHash(text);
}

export function currentTrackedHash(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return rel === '.agents/hooks.json' ? trackedHash(rel, readFileSync(p, 'utf8')) : sha256File(p);
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

export function buildLock(satRoot, stack, platform, managed, generated) {
  const lock = { sat_version: satVersion(satRoot), stack, platform, written_at: new Date().toISOString(), managed: {}, generated: {} };
  for (const [rel, text] of Object.entries(managed)) lock.managed[rel] = contentHash(text);
  for (const [rel, text] of Object.entries(generated)) lock.generated[rel] = trackedHash(rel, text);
  return lock;
}

export function writeLock(root, lock) {
  writeFileSync(join(root, LOCK_REL), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

export function locallyModified(root, lock) {
  const out = [];
  for (const section of ['managed', 'generated']) {
    for (const [rel, hash] of Object.entries(lock[section] || {})) {
      const now = currentTrackedHash(root, rel);
      if (now !== null && now !== hash) out.push(rel);
    }
  }
  return out;
}

export function removeStale(root, lock, managed, generated) {
  const removed = [];
  for (const section of ['managed', 'generated']) {
    const next = section === 'managed' ? managed : generated;
    for (const rel of Object.keys(lock[section] || {})) {
      if (rel in next) continue;
      const p = join(root, rel);
      if (existsSync(p)) {
        rmSync(p);
        removed.push(rel);
      }
    }
  }
  return removed;
}

export function ensureGitignore(root) {
  const p = join(root, '.gitignore');
  const current = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const missing = GITIGNORE_BLOCK.slice(1).filter((l) => !current.split(/\r?\n/).includes(l));
  if (!missing.length) return false;
  const block = current.includes(GITIGNORE_BLOCK[0]) ? missing : [GITIGNORE_BLOCK[0], ...missing];
  writeFileSync(p, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block.join('\n')}\n`, 'utf8');
  return true;
}

export function renderPreset(satRoot, stack, vars) {
  const presetPath = join(satRoot, 'stacks', stack, 'preset.yaml');
  if (!existsSync(presetPath)) throw new Error(`لا يوجد إعداد مسبق للمكدس ${stack}`);
  let text = readFileSync(presetPath, 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), () => v);
  const left = /\{\{(\w+)\}\}/.exec(text);
  if (left) throw new Error(`متغير غير معرّف في preset.yaml: ${left[1]}`);
  return text;
}
