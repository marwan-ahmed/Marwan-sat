// Marwan SAT — detection of stack, package manager, name and base branch in a host project.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git } from '../../core/bin/lib/git.mjs';

const PM = {
  npm: { install: 'npm ci', run: 'npm run', exec: 'npx', audit: 'npm audit --audit-level=high' },
  pnpm: { install: 'pnpm install --frozen-lockfile', run: 'pnpm run', exec: 'pnpm exec', audit: 'pnpm audit --audit-level high' },
  yarn: { install: 'yarn install --frozen-lockfile', run: 'yarn run', exec: 'yarn', audit: 'yarn npm audit --severity high' },
  bun: { install: 'bun install --frozen-lockfile', run: 'bun run', exec: 'bunx', audit: 'bun audit' },
};

export function detectPackageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function pmCommands(pm) {
  return PM[pm] || PM.npm;
}

function readJSONSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function detectStack(root) {
  const files = existsSync(root) ? readdirSync(root) : [];
  if (files.some((f) => /^next\.config\./.test(f))) return 'nextjs';
  if (existsSync(join(root, 'artisan')) && existsSync(join(root, 'composer.json'))) return 'laravel';
  if (existsSync(join(root, 'pubspec.yaml'))) return 'flutter';
  const pkg = readJSONSafe(join(root, 'package.json'));
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  if (deps.next) return 'nextjs';
  if (deps['react-native'] || deps.expo) return 'react-native';
  return null;
}

export function detectName(root) {
  const pkg = readJSONSafe(join(root, 'package.json'));
  if (pkg && pkg.name) return pkg.name;
  const composer = readJSONSafe(join(root, 'composer.json'));
  if (composer && composer.name) return composer.name;
  if (existsSync(join(root, 'pubspec.yaml'))) {
    const m = /^name:\s*(\S+)/m.exec(readFileSync(join(root, 'pubspec.yaml'), 'utf8'));
    if (m) return m[1];
  }
  return basename(root);
}

export function detectBaseBranch(root) {
  const remoteHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root, { allowFail: true });
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  const cur = git(['rev-parse', '--abbrev-ref', 'HEAD'], root, { allowFail: true });
  if (cur && cur !== 'HEAD' && !cur.startsWith('sat/')) return cur;
  return 'main';
}
