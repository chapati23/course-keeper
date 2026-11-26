#!/usr/bin/env node
// Skill lint for docs-repo shapes: checks every SKILL.md in the repo, without dependencies.
// Managed by ci-setup. It lives at .github/ci/lint-skills.mjs in the target repo.
// The `lint-skills` mise task runs it.
//
// Usage: lint-skills.mjs [ROOT] [--json]     (ROOT defaults to the current directory)
//
// Checks per SKILL.md:
//   - The file starts with a `---` line and a second `---` line closes the frontmatter.
//   - `name` equals the name of the directory that holds the file (not checked for a SKILL.md
//     at ROOT: the checkout directory name differs between CI and a local clone), matches
//     ^[a-z0-9]+(-[a-z0-9]+)*$ and has 1 to 64 characters.
//   - `description` has 1 to 1024 characters.
//   - Every relative Markdown link target ([text](path) or ![alt](path)) exists, resolved
//     against the file's directory (a leading `/` resolves against ROOT). URLs with a scheme,
//     fragment-only links and links inside code spans or fenced code blocks are not checked.
//
// Frontmatter reader limits: top-level `key: value` lines only; single- or double-quoted
// values; block scalars (`|`, `>` and their `-`/`+` variants); indented continuation lines of a
// plain value. It does not read lists, maps, anchors or escape sequences.
//
// At the top of a git work tree it lints the SKILL.md files that `git ls-files --cached --others
// --exclude-standard` lists (30 s deadline), so gitignored trees are skipped; elsewhere, or when
// git fails, it walks ROOT. It skips .git and node_modules directories. In GitHub Actions (GITHUB_ACTIONS=true) each
// problem is also printed as an escaped ::error workflow command.
// Exit codes: 0 no problems, 1 problems found, 2 bad usage.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowCommand } from './classify.mjs';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
export const GIT_TIMEOUT_MS = 30_000;

// git without the user's global or system config, so a local run lists what CI lists.
function gitList(root) {
  const opts = {
    cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  };
  const cfg = ['-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null'];
  const top = spawnSync('git', [...cfg, 'rev-parse', '--show-toplevel'], opts);
  if (top.error || top.status !== 0) return null;
  let same = false;
  try { same = realpathSync(top.stdout.trim()) === realpathSync(root); } catch { same = false; }
  if (!same) return null;
  const ls = spawnSync('git', [...cfg, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], opts);
  if (ls.error || ls.status !== 0) return null;
  return [...new Set(ls.stdout.split('\0').filter(Boolean))].sort();
}

// Every SKILL.md of the repo. When ROOT is the top of a git work tree, the list comes from git
// (tracked plus untracked files that .gitignore does not exclude), so ignored trees such as
// dist/ or .claude/worktrees/ are not linted. Otherwise, or when git fails, it walks the tree.
export function findSkills(root) {
  const listed = gitList(root);
  if (listed) {
    return listed.filter((p) => p === 'SKILL.md' || p.endsWith('/SKILL.md'))
      .filter((p) => !p.split('/').some((seg) => SKIP_DIRS.has(seg)))
      .map((p) => join(root, p))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  }
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); } else if (name === 'SKILL.md') out.push(p);
    }
  };
  walk(root);
  return out;
}

export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return { error: 'missing opening frontmatter delimiter (---) on line 1' };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { error: 'missing closing frontmatter delimiter (---)' };
  const fields = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(body[i]);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] || '').trim();
    const block = /^([|>])[-+]?$/.exec(value);
    const cont = [];
    while (i + 1 < body.length && (body[i + 1] === '' || /^\s/.test(body[i + 1]))) cont.push(body[++i]);
    while (cont.length && cont[cont.length - 1].trim() === '') cont.pop();
    if (block) {
      const parts = cont.map((l) => l.trim());
      value = block[1] === '|' ? parts.join('\n') : parts.join(' ').replace(/ {2,}/g, ' ');
    } else if (/^"(.*)"$/.test(value) || /^'(.*)'$/.test(value)) {
      value = value.slice(1, -1);
    } else if (cont.length) {
      value = [value, ...cont.map((l) => l.trim())].filter(Boolean).join(' ');
    }
    fields[key] = value.trim();
  }
  return { fields, bodyStart: end + 1, lines };
}

export function relativeLinks(markdown) {
  const links = [];
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = raw.replace(/`[^`]*`/g, '');
    const re = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      let target = m[1].replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
      target = target.replace(/[#?].*$/, '');
      if (!target) continue;
      try { target = decodeURIComponent(target); } catch { /* keep the raw target */ }
      links.push(target);
    }
  }
  return links;
}

export function lintSkill(file, root) {
  const problems = [];
  const text = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(text);
  if (fm.error) return [fm.error];
  // A SKILL.md at ROOT sits in the checkout directory, whose name differs between a CI runner
  // and a local clone, so its name is not compared with a directory.
  const atRoot = resolve(dirname(file)) === resolve(root);
  const dir = basename(dirname(file));
  const { name, description } = fm.fields;
  if (name === undefined || name === '') problems.push('frontmatter has no name');
  else {
    if (!atRoot && name !== dir) problems.push(`name "${name}" differs from its directory "${dir}"`);
    if (!NAME_RE.test(name)) problems.push(`name "${name}" does not match ^[a-z0-9]+(-[a-z0-9]+)*$`);
    if (name.length > 64) problems.push(`name has ${name.length} characters; the limit is 64`);
  }
  if (description === undefined || description === '') problems.push('frontmatter has no description');
  else if (description.length > 1024) problems.push(`description has ${description.length} characters; the limit is 1024`);
  const body = fm.lines.slice(fm.bodyStart).join('\n');
  for (const target of relativeLinks(body)) {
    const abs = target.startsWith('/') ? join(root, target) : resolve(dirname(file), target);
    if (!existsSync(abs)) problems.push(`broken relative link: ${target}`);
  }
  return problems;
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }, env = process.env) {
  let root = '.';
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a === '--help') { io.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith('//'))).join('\n') + '\n'); return 0; }
    else if (!a.startsWith('--')) root = a;
    else { io.stderr.write(`lint-skills: unknown argument: ${a}\n`); return 2; }
  }
  root = resolve(root);
  const results = [];
  const skills = findSkills(root);
  for (const file of skills) {
    const rel = relative(root, file);
    for (const message of lintSkill(file, root)) results.push({ file: rel, message });
  }
  const gh = env.GITHUB_ACTIONS === 'true';
  for (const r of results) {
    io.stderr.write(`${JSON.stringify(r.file)}: ${JSON.stringify(r.message)}\n`);
    if (gh) io.stdout.write(`${workflowCommand('error', { file: r.file, title: 'lint-skills' }, r.message)}\n`);
  }
  const count = skills.length;
  io.stderr.write(`lint-skills: ${count} SKILL.md files, ${results.length} problems\n`);
  if (json) io.stdout.write(`${JSON.stringify({ skills: count, problems: results })}\n`);
  return results.length ? 1 : 0;
}

// Run as a CLI only when this file is the entry point (realpath: tmp dirs are often symlinks).
function isMain() {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
