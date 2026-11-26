import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { SAT_ROOT } from './helpers.mjs';

// The version a reader sees in the docs must be the version the code carries.
// 0.4.1 and 0.5.0 shipped with READMEs still saying 0.4.0 and install commands pinned to #v0.4.0,
// so anyone following them installed an older SAT. These checks make a release fail instead.
// Not checked: CHANGELOG.md and charter/ (their history names older versions on purpose) and
// upgrade notes such as «الترقية إلى 0.4.0», which name the version they describe.

const VERSION = JSON.parse(readFileSync(join(SAT_ROOT, 'package.json'), 'utf8')).version;

function markdownUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownUnder(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );
}

const DOCS = [join(SAT_ROOT, 'README.md'), join(SAT_ROOT, 'README.en.md'), ...markdownUnder(join(SAT_ROOT, 'docs'))];

// Each pattern captures a version that must equal package.json.
const PINNED = [
  { what: 'pinned install command', re: /marwan-sat#v(\d+\.\d+\.\d+)/g },
  { what: 'install commit message', re: /install Marwan SAT (\d+\.\d+\.\d+)/g },
];

test('docs: every pinned version equals package.json', () => {
  const wrong = [];
  for (const file of DOCS) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { what, re } of PINNED)
        for (const m of line.matchAll(re))
          if (m[1] !== VERSION) wrong.push(`${relative(SAT_ROOT, file)}:${i + 1} ${what} says ${m[1]}`);
    });
  }
  assert.deepEqual(wrong, [], `package.json is ${VERSION}. Update these lines:\n${wrong.join('\n')}`);
});

test('docs: the README version banners equal package.json', () => {
  for (const [file, re] of [
    ['README.md', /^> الإصدار `(\d+\.\d+\.\d+)`/m],
    ['README.en.md', /^> Version `(\d+\.\d+\.\d+)`/m],
  ]) {
    const m = readFileSync(join(SAT_ROOT, file), 'utf8').match(re);
    assert.ok(m, `${file}: the version banner is missing or changed shape; update it or this test`);
    assert.equal(m[1], VERSION, `${file}: the banner says ${m[1]}, package.json says ${VERSION}`);
  }
});

test('CHANGELOG: the newest entry is the package.json version', () => {
  const m = readFileSync(join(SAT_ROOT, 'CHANGELOG.md'), 'utf8').match(/^## \[([^\]]+)\]/m);
  assert.ok(m, 'CHANGELOG.md has no "## [x.y.z]" entry');
  assert.equal(m[1], VERSION, `CHANGELOG.md starts at ${m[1]}, package.json says ${VERSION}`);
});
