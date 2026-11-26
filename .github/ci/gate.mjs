#!/usr/bin/env node
// The Gate: `mise run check` runs this file. It runs the same mise tasks that the CI jobs run,
// and skips the tasks whose Change flag is false for the local diff.
// Managed by ci-setup. It lives at .github/ci/gate.mjs in the target repo.
//
// Usage: gate.mjs [--all] [--base-ref REF] [--dry-run] [--json] [--config FILE]
//
//   --all          Take the flags from `classify.mjs --all`: every flag true, then `requires`
//                  forces off a flag whose files the repo lacks (no e2e without Playwright).
//   --base-ref REF Compare against merge-base(REF, HEAD). Default: origin/HEAD, then origin/main.
//   --dry-run      Print the task list and run nothing.
//   --json         Print one JSON result object on stdout.
//
// Steps:
//   1. Run `classify.mjs --local` (`--all` under --all), next to this file, to get the Change
//      flags and the merge-base. When the Classifier fails, times out or prints no valid
//      flags, every flag is true (fail open). An unknown path or a missing ref also makes the
//      Classifier print every flag true.
//   2. Build the task list from the `gate` map in classify.json: `always` first, then each
//      flag's tasks in map order when the flag is true. A task runs at most once.
//   3. Run each task as `mise run <task>` in order. A failed task does not stop the others.
//      SCAN_BASE is set to the Classifier's merge-base, so the secrets task scans the same
//      commits as CI and not untracked or ignored files; it is unset when there is no base.
//   4. Print one summary line per task. Exit 1 if any task failed (a task killed by a signal
//      counts as failed), 2 if mise is missing.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXIT = { OK: 0, FAIL: 1, INCOMPLETE: 2 };
const FLAG_NAMES = ['code', 'e2e', 'docs', 'workflows', 'deps'];
const CLASSIFY_TIMEOUT_MS = 120_000;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function taskList(gateMap, flags, { all = false } = {}) {
  const run = [];
  const skipped = [];
  const add = (t) => { if (!run.includes(t)) run.push(t); };
  for (const t of gateMap.always || []) add(t);
  for (const [flag, tasks] of Object.entries(gateMap)) {
    if (flag === 'always') continue;
    if (all || flags[flag] === true) tasks.forEach(add);
  }
  for (const tasks of Object.values(gateMap)) {
    for (const t of tasks) if (!run.includes(t) && !skipped.includes(t)) skipped.push(t);
  }
  return { run, skipped };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-ref' || a === '--config') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a === '--base-ref' ? 'base_ref' : 'config'] = argv[++i];
    } else if (['--all', '--dry-run', '--json', '--help'].includes(a)) {
      o[a.slice(2).replace('-', '_')] = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return o;
}

// Parse the Classifier's github-output text: one `<flag>=true|false` line per flag and a
// `base=<sha or empty>` line. Returns null when any flag line is missing or invalid.
export function parseClassifierOutput(text) {
  const kv = {};
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
    if (!m) return null;
    kv[m[1]] = m[2];
  }
  const flags = {};
  for (const f of FLAG_NAMES) {
    if (kv[f] !== 'true' && kv[f] !== 'false') return null;
    flags[f] = kv[f] === 'true';
  }
  const base = SHA_RE.test(kv.base || '') ? kv.base : '';
  return { flags, base };
}

function classify(configFile, { all, baseRef }, gateMap) {
  const args = [join(HERE, 'classify.mjs'), all ? '--all' : '--local', '--config', configFile, '--format', 'github-output'];
  if (baseRef && !all) args.push('--base-ref', baseRef);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CLASSIFY_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  const allTrue = Object.fromEntries(Object.keys(gateMap).filter((k) => k !== 'always').map((k) => [k, true]));
  const failOpen = (note) => ({ flags: allTrue, base: '', note, stderr: r.stderr || '' });
  if (r.error && r.error.code === 'ETIMEDOUT') return failOpen(`classifier timed out after ${CLASSIFY_TIMEOUT_MS / 1000}s; every flag true`);
  if (r.status !== 0) return failOpen(`classifier exited ${r.status === null ? `on signal ${r.signal}` : r.status}; every flag true`);
  const parsed = parseClassifierOutput(r.stdout);
  if (!parsed) return failOpen('classifier printed no valid flags; every flag true');
  return { ...parsed, note: null, stderr: r.stderr };
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let o;
  try { o = parseArgs(argv); } catch (e) { io.stderr.write(`gate: ${e.message}\n`); return EXIT.INCOMPLETE; }
  if (o.help) { io.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).join('\n') + '\n'); return EXIT.OK; }
  const configFile = resolve(o.config || join(HERE, 'classify.json'));
  let gateMap;
  try {
    gateMap = JSON.parse(readFileSync(configFile, 'utf8')).gate;
    if (!gateMap || typeof gateMap !== 'object') throw new Error('no "gate" map');
  } catch (e) { io.stderr.write(`gate: config ${configFile}: ${e.message}\n`); return EXIT.INCOMPLETE; }

  const c = classify(configFile, { all: Boolean(o.all), baseRef: o.base_ref }, gateMap);
  const { flags, base } = c;
  if (c.stderr) io.stderr.write(c.stderr);
  if (c.note) io.stderr.write(`gate: ${c.note}\n`);
  const { run, skipped } = taskList(gateMap, flags);
  const taskEnv = { ...process.env };
  if (base) taskEnv.SCAN_BASE = base;
  else delete taskEnv.SCAN_BASE;

  if (o.dry_run) {
    if (o.json) io.stdout.write(`${JSON.stringify({ flags, base, run, skipped })}\n`);
    else {
      io.stderr.write(`gate: would run: ${run.join(' ') || '(none)'}\n`);
      if (skipped.length) io.stderr.write(`gate: skipped by flags: ${skipped.join(' ')}\n`);
    }
    return EXIT.OK;
  }

  const results = [];
  for (const task of run) {
    const started = Date.now();
    // With --json, task output goes to stderr so stdout holds only the JSON result.
    const r = spawnSync('mise', ['run', task], { env: taskEnv, stdio: ['inherit', o.json ? 2 : 'inherit', 'inherit'] });
    if (r.error && r.error.code === 'ENOENT') {
      io.stderr.write('gate: mise is not on PATH; install it (https://mise.jdx.dev) and run again\n');
      return EXIT.INCOMPLETE;
    }
    const code = r.status === null ? 1 : r.status;
    results.push({ task, status: code === 0 ? 'ok' : 'failed', code, signal: r.signal || null, seconds: Math.round((Date.now() - started) / 100) / 10 });
  }

  const failed = results.filter((r) => r.status !== 'ok');
  for (const r of results) io.stderr.write(`gate: ${r.status === 'ok' ? 'ok  ' : 'FAIL'} ${r.task} (${r.seconds}s${r.status === 'ok' ? '' : `, ${r.signal ? `signal ${r.signal}` : `exit ${r.code}`}`})\n`);
  if (skipped.length) io.stderr.write(`gate: skipped by flags: ${skipped.join(' ')}\n`);
  io.stderr.write(`gate: ${failed.length ? `${failed.length} of ${results.length} tasks failed` : `all ${results.length} tasks passed`}\n`);
  if (o.json) io.stdout.write(`${JSON.stringify({ flags, base, run, skipped, results })}\n`);
  return failed.length ? EXIT.FAIL : EXIT.OK;
}

// Run as a CLI only when this file is the entry point (realpath: tmp dirs are often symlinks).
function isMain() {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
