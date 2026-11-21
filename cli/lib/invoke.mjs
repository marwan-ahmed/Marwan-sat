// How the owner should call SAT again: the same way they called it this time.
// A message that says "run: sat doctor" to someone who installed with npx sends them to a command that does not exist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists } from '../../core/bin/lib/proc.mjs';

// "github:<owner>/<repo>" from package.json's repository URL, so forks print their own address.
export function githubSpec(satRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(satRoot, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.#]+)/i);
    if (m) return `github:${m[1]}/${m[2]}`;
  } catch {
    /* fall through */
  }
  return 'github:marwan-ahmed/marwan-sat';
}

// The command prefix to print before "doctor", "update", etc.
export function satCommand(satRoot, version, env = process.env, hasSat = () => commandExists('sat')) {
  const viaNpx = /[\\/]_npx[\\/]/.test(satRoot) || env.npm_command === 'exec';
  if (viaNpx) return `npx ${githubSpec(satRoot)}#v${version}`;
  if (hasSat()) return 'sat';
  return `node "${join(satRoot, 'cli', 'sat.mjs')}"`;
}
