#!/usr/bin/env node
// Classifier: turns the list of changed files into Change flags.
// Managed by ci-setup. It lives at .github/ci/classify.mjs in the target repo.
// It has no dependencies, so it runs with the runner image's Node before any install.
//
// Usage:
//   classify.mjs [--config FILE] [--stdin | --base SHA --head SHA] [--all]
//                [--local [--base-ref REF]] [--languages] [--protected [--manifest FILE]]
//                [--format json|github-output] [--test [FILE]] [--repo-dir DIR]
//
// Modes (pick one; the default classifies a diff):
//   default      Read changed paths and print Change flags. Paths come from stdin, or from
//                `git diff --name-only -z --no-renames BASE...HEAD` when --base and --head
//                are given. A rename counts as a delete plus an add.
//   --all        Print every flag true (push, schedule, workflow_dispatch).
//   --local      Diff merge-base(REF, HEAD) against the working tree, plus untracked files.
//                REF defaults to origin/HEAD, then origin/main. A missing REF acts like --all.
//                The github-output format prints that merge-base as `base` (the Gate passes
//                it to the secret scan as SCAN_BASE).
//   --languages  Scan the tracked files against `warn_languages`. Print one ::warning per
//                language that has files but no job. Never fails.
//   --protected  Match the changed paths against the manifest's `protected_paths`
//                (CODEOWNERS patterns). Print one ::notice per match. Never fails.
//   --test       Run the fixture rows (default: classify.fixtures.json next to the config).
//
// Stdin: NUL-separated paths when the input holds a NUL byte, else one path per line.
// Use `git diff --name-only -z`: without -z, git quotes unusual names, the quoted name matches
// no pattern, and the Classifier fails open.
//
// Fail open: an unknown path, a missing or invalid base, an empty diff or a git error turns
// every flag true. `requires` applies last, also after a fail-open result, whenever the tracked
// file list is known: a flag is forced false when no tracked file matches its patterns.
// A flag that the config does not list under `flags` is always false (the shape has no job).
//
// Exit codes: 0 ok, 1 a fixture row failed, 2 bad usage or an invalid config.
//
// Glob syntax (globToRegExp): patterns match the whole repo-relative path (anchored).
//   **   as a whole segment matches zero or more directories (`**/x`, `a/**/x`, `a/**`).
//   *    matches any run of characters except `/`.
//   ?    matches one character except `/`.
//   {a,b} matches one of the comma-separated alternatives; alternatives may nest and may
//        hold other glob tokens.
//   Every other character is literal, `[`, `]` and `\` included. There is no negation and no
//   character class. Dotfiles match `*` and `**` like any other name. Matching is
//   case-sensitive.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLAGS = ['code', 'e2e', 'docs', 'workflows', 'deps'];
export const EXIT = { OK: 0, FAIL: 1, INCOMPLETE: 2 };
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- workflow-command escaping ----------

// Escape a value for the message part of a workflow command (`::notice::<data>`).
// GitHub reads %, CR and LF as control characters there; a raw LF starts a new command.
export function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// Escape a value for a property (`::notice title=<prop>::`). Colon and comma end a property.
export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function workflowCommand(command, props, message) {
  const p = Object.entries(props || {})
    .map(([k, v]) => `${k}=${escapeProperty(v)}`)
    .join(',');
  return `::${command}${p ? ` ${p}` : ''}::${escapeData(message)}`;
}

// ---------- glob matcher ----------

const RE_SPECIAL = /[.+^$()|[\]\\/]/;

export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern === '') throw new Error(`invalid glob: ${JSON.stringify(pattern)}`);
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/';
        const next = pattern[i + 2];
        if (atStart && next === '/') { out += '(?:.*/)?'; i += 3; continue; }
        if (atStart && next === undefined) { out += '.*'; i += 2; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { out += '[^/]'; i += 1; continue; }
    if (c === '{') { depth += 1; out += '(?:'; i += 1; continue; }
    if (c === '}' && depth > 0) { depth -= 1; out += ')'; i += 1; continue; }
    if (c === ',' && depth > 0) { out += '|'; i += 1; continue; }
    if (c === '}') throw new Error(`invalid glob (unbalanced "}"): ${pattern}`);
    out += RE_SPECIAL.test(c) ? `\\${c}` : c;
    i += 1;
  }
  if (depth !== 0) throw new Error(`invalid glob (unbalanced "{"): ${pattern}`);
  return new RegExp(`^${out}$`, 's');
}

export function compileGlobs(patterns) {
  const res = (patterns || []).map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

export function globMatch(pattern, path) {
  return globToRegExp(pattern).test(path);
}

// CODEOWNERS pattern -> matcher. A leading `/` anchors at the root. A pattern without a `/`
// (other than a trailing one) matches at any depth. A trailing `/` matches a directory's
// contents. A pattern without a trailing `/` matches the path itself or anything below it.
export function codeownersMatcher(pattern) {
  let p = String(pattern).trim();
  if (!p || p.startsWith('#')) return () => false;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  if (!anchored && !p.includes('/')) p = `**/${p}`;
  const globs = dirOnly ? [`${p}/**`] : [p, `${p}/**`];
  return compileGlobs(globs);
}

// ---------- config ----------

export function loadConfig(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('config is not an object');
  if (!config.flags || typeof config.flags !== 'object') throw new Error('config has no "flags" map');
  for (const flag of Object.keys(config.flags)) {
    if (!FLAGS.includes(flag)) throw new Error(`config flag "${flag}" is not one of ${FLAGS.join(', ')}`);
  }
  const lists = [
    ...Object.values(config.flags),
    config.always_all || [],
    config.ignore || [],
    ...Object.values(config.requires || {}),
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) throw new Error('every pattern list must be an array');
    list.forEach(globToRegExp);
  }
  for (const [lang, spec] of Object.entries(config.warn_languages || {})) {
    languagePatterns(lang, spec).forEach(globToRegExp);
  }
}

// warn_languages value: an array of globs (a v1 language that has no job here), or
// {"patterns": [...], "v1": false} for a language that ci-setup v1 does not support.
function languagePatterns(lang, spec) {
  const patterns = Array.isArray(spec) ? spec : spec && spec.patterns;
  if (!Array.isArray(patterns)) throw new Error(`warn_languages.${lang} needs an array of globs`);
  return patterns;
}

// ---------- core (pure) ----------

export function allFlags(config, value) {
  const out = {};
  for (const f of FLAGS) out[f] = Boolean(value) && Object.hasOwn(config.flags, f);
  return out;
}

// paths: changed repo-relative paths. tracked: every tracked path, or null when unknown.
// Returns { flags, reason } where reason explains a fail-open result.
export function classifyPaths(paths, config, tracked, { all = false } = {}) {
  let flags = allFlags(config, false);
  let reason = null;
  if (all) {
    flags = allFlags(config, true);
    reason = 'all';
  } else if (!paths || paths.length === 0) {
    flags = allFlags(config, true);
    reason = 'empty diff';
  } else {
    const ignored = compileGlobs(config.ignore);
    const always = compileGlobs(config.always_all);
    const matchers = Object.entries(config.flags).map(([f, pats]) => [f, compileGlobs(pats)]);
    for (const path of paths) {
      if (ignored(path)) continue;
      if (always(path)) { flags = allFlags(config, true); reason = `always_all: ${path}`; break; }
      const hit = matchers.filter(([, m]) => m(path)).map(([f]) => f);
      if (hit.length === 0) { flags = allFlags(config, true); reason = `unknown path: ${path}`; break; }
      for (const f of hit) flags[f] = true;
    }
  }
  if (tracked) {
    for (const [flag, pats] of Object.entries(config.requires || {})) {
      if (!flags[flag]) continue;
      const m = compileGlobs(pats);
      if (!tracked.some(m)) flags[flag] = false;
    }
  }
  return { flags, reason };
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function validBase(base) {
  return typeof base === 'string' && SHA_RE.test(base) && !/^0+$/.test(base) ? base : '';
}

export function formatFlags(flags, format, base) {
  if (format === 'github-output') {
    const lines = FLAGS.map((f) => `${f}=${flags[f] ? 'true' : 'false'}`);
    lines.push(`base=${validBase(base)}`);
    return `${lines.join('\n')}\n`;
  }
  const obj = {};
  for (const f of FLAGS) obj[f] = Boolean(flags[f]);
  return `${JSON.stringify(obj)}\n`;
}

export function languageWarnings(tracked, config, acknowledged = []) {
  const lines = [];
  const ack = new Set(acknowledged);
  for (const [lang, spec] of Object.entries(config.warn_languages || {})) {
    if (ack.has(lang)) continue;
    const m = compileGlobs(languagePatterns(lang, spec));
    if (!tracked.some(m)) continue;
    const v1 = Array.isArray(spec) || spec.v1 !== false;
    const tail = v1 ? 'Run /ci-setup again to add one.' : 'not supported by ci-setup v1.';
    lines.push({ lang, line: workflowCommand('warning', { title: 'ci-setup' },
      `${lang} files found, but CI has no ${lang} job. ${tail}`) });
  }
  return lines;
}

export function protectedNotices(paths, protectedPaths) {
  const matchers = (protectedPaths || []).map(codeownersMatcher);
  return paths
    .filter((p) => matchers.some((m) => m(p)))
    .map((p) => workflowCommand('notice', { title: 'ci-setup' }, `protected path changed: ${p}`));
}

export function splitPaths(text) {
  if (!text) return [];
  const sep = text.includes('\0') ? '\0' : '\n';
  return text.split(sep).filter((p) => p !== '');
}

// ---------- git (never through a shell) ----------

// Every git call runs under a deadline; a timeout throws, and the caller fails open.
const GIT_TIMEOUT_MS = 60_000;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28,
    timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
}

function gitOk(cwd, args) {
  try { git(cwd, args); return true; } catch { return false; }
}

export function repoRoot(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']).trim(); } catch { return null; }
}

export function trackedFiles(root) {
  try {
    return splitPaths(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  } catch { return null; }
}

// Returns { paths, base, error }.
export function diffPaths(root, base, head) {
  const b = validBase(base);
  if (!b) return { paths: null, base: '', error: 'missing or invalid base SHA' };
  if (typeof head !== 'string' || !/^[0-9a-f]{40,64}$/.test(head)) return { paths: null, base: '', error: 'missing or invalid head SHA' };
  if (!gitOk(root, ['cat-file', '-e', `${b}^{commit}`])) return { paths: null, base: '', error: `base ${b} is not in the clone` };
  if (!gitOk(root, ['cat-file', '-e', `${head}^{commit}`])) return { paths: null, base: '', error: `head ${head} is not in the clone` };
  try {
    return { paths: splitPaths(git(root, ['diff', '--name-only', '-z', '--no-renames', `${b}...${head}`])), base: b, error: null };
  } catch (e) {
    return { paths: null, base: '', error: `git diff failed: ${firstLine(e)}` };
  }
}

function defaultBaseRef(root) {
  try { return git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim(); } catch { return 'origin/main'; }
}

// Returns { paths, base, error }; base is the merge-base the diff starts from.
export function localPaths(root, ref) {
  const r = ref || defaultBaseRef(root);
  if (r.startsWith('-')) return { paths: null, base: '', error: `invalid ref ${r}` };
  if (!gitOk(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])) return { paths: null, base: '', error: `ref ${r} not found` };
  try {
    const mb = git(root, ['merge-base', r, 'HEAD']).trim();
    const changed = splitPaths(git(root, ['diff', '--name-only', '-z', '--no-renames', mb]));
    const untracked = splitPaths(git(root, ['ls-files', '-z', '--others', '--exclude-standard']));
    return { paths: [...new Set([...changed, ...untracked])], base: validBase(mb), error: null };
  } catch (e) {
    return { paths: null, base: '', error: `git failed: ${firstLine(e)}` };
  }
}

function firstLine(e) {
  return String((e && (e.stderr || e.message)) || e).split('\n')[0];
}

// ---------- fixture runner ----------

export function runFixtures(config, fixtures) {
  const results = [];
  for (const row of fixtures.rows || []) {
    const tracked = row.tracked || fixtures.tracked || [];
    const problems = [];
    const mode = row.mode || 'diff';
    if (mode === 'languages') {
      const got = languageWarnings(tracked, config, row.acknowledged || []);
      const langs = got.map((w) => w.lang).sort();
      const want = [...(row.expect_warnings || [])].sort();
      if (JSON.stringify(langs) !== JSON.stringify(want)) problems.push(`warnings ${JSON.stringify(langs)} != ${JSON.stringify(want)}`);
      for (const w of got) if (w.line.includes('\n') || !w.line.startsWith('::warning ')) problems.push(`unsafe warning line ${JSON.stringify(w.line)}`);
    } else if (mode === 'protected') {
      const notices = protectedNotices(row.paths || [], row.protected_paths || fixtures.protected_paths || []);
      const want = row.expect_notices || [];
      const wantLines = want.map((p) => workflowCommand('notice', { title: 'ci-setup' }, `protected path changed: ${p}`));
      if (JSON.stringify(notices) !== JSON.stringify(wantLines)) problems.push(`notices ${JSON.stringify(notices)} != ${JSON.stringify(wantLines)}`);
      for (const n of notices) if (/[\r\n]/.test(n)) problems.push(`unsafe notice line ${JSON.stringify(n)}`);
    } else {
      const known = mode === 'git-error' ? null : tracked;
      const { flags } = classifyPaths(row.paths || [], config, known, { all: mode === 'all' });
      if (row.expect) {
        for (const f of FLAGS) {
          const want = Boolean(row.expect[f]);
          if (flags[f] !== want) problems.push(`${f}: got ${flags[f]}, want ${want}`);
        }
      }
      if (row.expect_output) {
        const base = mode === 'all' || mode === 'git-error' ? '' : row.base;
        const text = formatFlags(flags, 'github-output', base);
        const kv = Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
        for (const [k, v] of Object.entries(row.expect_output)) {
          if (kv[k] !== String(v)) problems.push(`output ${k}: got ${JSON.stringify(kv[k])}, want ${JSON.stringify(String(v))}`);
        }
      }
    }
    results.push({ id: row.id, name: row.name, ok: problems.length === 0, problems });
  }
  return results;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const o = { format: 'json' };
  const takesValue = new Set(['--config', '--base', '--head', '--base-ref', '--manifest', '--format', '--repo-dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (takesValue.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2).replace('-', '_')] = argv[++i];
    } else if (a === '--test') {
      o.test = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o.test_file = argv[++i];
    } else if (['--stdin', '--all', '--local', '--languages', '--protected', '--help'].includes(a)) {
      o[a.slice(2)] = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!['json', 'github-output'].includes(o.format)) throw new Error(`--format must be json or github-output`);
  if ((o.base && !o.head) || (o.head && !o.base)) {
    if (!o.stdin) throw new Error('--base and --head go together');
  }
  return o;
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function appendSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file || lines.length === 0) return;
  try { appendFileSync(file, `${lines.join('\n')}\n`); } catch { /* the summary is best effort */ }
}

function readManifest(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let o;
  try { o = parseArgs(argv); } catch (e) { io.stderr.write(`classify: ${e.message}\n`); return EXIT.INCOMPLETE; }
  if (o.help) { io.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n') + '\n'); return EXIT.OK; }
  const repoDir = resolve(o.repo_dir || '.');
  const configFile = resolve(o.config || join(HERE, 'classify.json'));
  let config;
  try { config = loadConfig(configFile); } catch (e) { io.stderr.write(`classify: config ${configFile}: ${e.message}\n`); return EXIT.INCOMPLETE; }

  if (o.test) {
    const file = resolve(o.test_file || join(dirname(configFile), 'classify.fixtures.json'));
    let fixtures;
    try { fixtures = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { io.stderr.write(`classify: fixtures ${file}: ${e.message}\n`); return EXIT.INCOMPLETE; }
    const results = runFixtures(config, fixtures);
    for (const r of results) io.stderr.write(`${escapeData(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id || ''} ${r.name || ''}${r.ok ? '' : `: ${r.problems.join('; ')}`}`)}\n`);
    const failed = results.filter((r) => !r.ok).length;
    io.stderr.write(`${results.length - failed} passed, ${failed} failed\n`);
    if (o.format === 'json') io.stdout.write(`${JSON.stringify({ passed: results.length - failed, failed, results })}\n`);
    return failed ? EXIT.FAIL : EXIT.OK;
  }

  const root = repoRoot(repoDir);

  if (o.languages) {
    const tracked = root ? trackedFiles(root) : null;
    if (!tracked) { io.stderr.write('classify: cannot list tracked files; language scan skipped\n'); return EXIT.OK; }
    const manifest = readManifest(resolve(o.manifest || join(root, '.github/ci-setup.json')));
    const ack = (manifest && Array.isArray(manifest.acknowledged_languages)) ? manifest.acknowledged_languages : [];
    const lines = languageWarnings(tracked, config, ack).map((w) => w.line);
    for (const l of lines) io.stdout.write(`${l}\n`);
    appendSummary(lines);
    return EXIT.OK;
  }

  // Collect changed paths.
  let paths = null;
  let base = '';
  let error = null;
  if (o.all) {
    paths = [];
  } else if (o.local) {
    if (!root) error = 'not a git repository';
    else ({ paths, base, error } = localPaths(root, o.base_ref));
  } else if (o.base && o.head && !o.stdin) {
    if (!root) error = 'not a git repository';
    else ({ paths, base, error } = diffPaths(root, o.base, o.head));
  } else {
    paths = splitPaths(readStdin());
    base = o.base || '';
  }

  if (o.protected) {
    if (!paths) { io.stderr.write(`classify: ${escapeData(error)}; protected-path scan skipped\n`); return EXIT.OK; }
    const manifestFile = resolve(o.manifest || join(root || repoDir, '.github/ci-setup.json'));
    const manifest = readManifest(manifestFile);
    if (!manifest || !Array.isArray(manifest.protected_paths)) {
      io.stdout.write(`${workflowCommand('warning', { title: 'ci-setup' }, `no protected_paths in ${manifestFile}`)}\n`);
      return EXIT.OK;
    }
    const lines = protectedNotices(paths, manifest.protected_paths);
    for (const l of lines) io.stdout.write(`${l}\n`);
    appendSummary(lines);
    return EXIT.OK;
  }

  const tracked = root ? trackedFiles(root) : null;
  let result;
  if (error) {
    // Fail open. `requires` still applies when the tracked list is known.
    result = tracked ? classifyPaths([], config, tracked, { all: true }) : { flags: allFlags(config, true) };
    result.reason = error;
    base = '';
  } else if (root && !tracked) {
    // A git error. Outside a git repo (stdin only) the paths still classify, without `requires`.
    result = { flags: allFlags(config, true), reason: 'git ls-files failed' };
    base = '';
  } else {
    result = classifyPaths(paths, config, tracked, { all: Boolean(o.all) });
  }
  if (result.reason && result.reason !== 'all') io.stderr.write(`classify: fail open (${escapeData(result.reason)})\n`);
  io.stdout.write(formatFlags(result.flags, o.format, base));
  return EXIT.OK;
}

// Run as a CLI only when this file is the entry point (realpath: tmp dirs are often symlinks).
function isMain() {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
