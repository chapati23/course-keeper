#!/usr/bin/env node
// Test-baseline check: fails when executed tests drop below the baseline or skipped tests
// rise above it. It guards against test weakening (deleted or skipped tests).
// Managed by ci-setup. It lives at .github/ci/test-baseline.mjs in the target repo.
// The `test-baseline` mise task runs it after the test tasks.
//
// Usage: test-baseline.mjs [REPORTS_DIR] [--baseline FILE] [--seed [--require-reports] | --update]
//                          [--json]
//
//   REPORTS_DIR  Directory with JUnit XML reports (default: reports). Every *.xml file below
//                it counts. An absent directory counts as zero tests.
//   --baseline   Baseline file (default: .github/ci/test-baseline.json):
//                {"schema": 1, "min_tests": N, "max_skipped": M, "reports_expected": B}
//                reports_expected is optional (default false).
//   --seed       Set min_tests to the current executed count and max_skipped to the current
//                skipped count, and set reports_expected to true when at least one report
//                file exists. Run it once after the first test run. It may lower either value.
//   --require-reports  With --seed only: exit 1 and write nothing when no report file exists.
//                A test stack that writes no reports must not seed a baseline of 0.
//   --update     Raise min_tests to the current executed count. It never lowers min_tests
//                and never changes max_skipped or reports_expected. The check still runs
//                after the update.
//   --json       Print the counts and the verdict as JSON on stdout.
//
// Exit codes: 0 pass, 1 executed < min_tests, skipped > max_skipped, no report file while
// reports_expected is true, or no report file for --seed --require-reports; 2 bad usage or an
// unreadable baseline.
//
// JUnit reader limits: this is a regex reader, not an XML parser. It removes comments and
// CDATA sections, then counts <testcase> elements. A testcase that holds a <skipped> element
// counts as skipped; every other testcase counts as executed. <failure> and <error> elements
// are counted and reported, but the test task, not this check, fails on them. It ignores the
// testsuite count attributes, does not decode entities, and does not support a testcase
// nested in another testcase. Quarantined tests count as skipped when the reporter marks them
// skipped.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT = { OK: 0, FAIL: 1, INCOMPLETE: 2 };

export function countJUnit(xml) {
  // Remove comments and CDATA until none is left: one pass over `<!-<!---->-` leaves `<!--`,
  // and a testcase inside the comment it opens would count.
  let text = String(xml);
  for (let prev = null; prev !== text;) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  }
  const counts = { total: 0, skipped: 0, failures: 0, errors: 0 };
  const re = /<testcase\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    counts.total += 1;
    const body = m[2] || '';
    if (/<skipped\b/.test(body)) counts.skipped += 1;
    if (/<failure\b/.test(body)) counts.failures += 1;
    if (/<error\b/.test(body)) counts.errors += 1;
  }
  counts.executed = counts.total - counts.skipped;
  return counts;
}

function xmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...xmlFiles(p));
    else if (name.endsWith('.xml')) out.push(p);
  }
  return out;
}

export function countReports(dir) {
  const total = { files: 0, total: 0, executed: 0, skipped: 0, failures: 0, errors: 0 };
  if (!existsSync(dir)) return total;
  for (const f of xmlFiles(dir)) {
    const c = countJUnit(readFileSync(f, 'utf8'));
    total.files += 1;
    for (const k of ['total', 'executed', 'skipped', 'failures', 'errors']) total[k] += c[k];
  }
  return total;
}

export function readBaseline(file) {
  const b = JSON.parse(readFileSync(file, 'utf8'));
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('baseline is not an object');
  for (const k of ['min_tests', 'max_skipped']) {
    if (!Number.isInteger(b[k]) || b[k] < 0) throw new Error(`${k} must be a non-negative integer`);
  }
  if (b.reports_expected !== undefined && typeof b.reports_expected !== 'boolean') {
    throw new Error('reports_expected must be true or false');
  }
  return b;
}

export function judge(counts, baseline) {
  const problems = [];
  if (baseline.reports_expected === true && counts.files === 0) {
    problems.push('no JUnit report files found, but the baseline expects reports (reports_expected true)');
  }
  if (counts.executed < baseline.min_tests) {
    problems.push(`executed tests dropped: ${counts.executed} < min_tests ${baseline.min_tests}`);
  }
  if (counts.skipped > baseline.max_skipped) {
    problems.push(`skipped tests rose: ${counts.skipped} > max_skipped ${baseline.max_skipped}`);
  }
  return problems;
}

function parseArgs(argv) {
  const o = { dir: 'reports', baseline: '.github/ci/test-baseline.json' };
  let dirSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--baseline') {
      if (i + 1 >= argv.length) throw new Error('--baseline needs a value');
      o.baseline = argv[++i];
    } else if (['--seed', '--update', '--json', '--help', '--require-reports'].includes(a)) {
      o[a.slice(2)] = true;
    } else if (!a.startsWith('--') && !dirSet) {
      o.dir = a; dirSet = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (o.seed && o.update) throw new Error('--seed and --update exclude each other');
  if (o['require-reports'] && !o.seed) throw new Error('--require-reports needs --seed');
  return o;
}

// The baseline that --seed writes: the current counts become the limits.
export function seedBaseline(baseline, counts) {
  return { ...baseline, min_tests: counts.executed, max_skipped: counts.skipped, reports_expected: counts.files > 0 };
}

// The header comment block, without the shebang line.
function helpText() {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return `${lines.slice(0, end).join('\n')}\n`;
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let o;
  try { o = parseArgs(argv); } catch (e) { io.stderr.write(`test-baseline: ${e.message}\n`); return EXIT.INCOMPLETE; }
  if (o.help) { io.stdout.write(helpText()); return EXIT.OK; }
  const baselineFile = resolve(o.baseline);
  let baseline;
  try { baseline = readBaseline(baselineFile); } catch (e) {
    io.stderr.write(`test-baseline: cannot read ${baselineFile}: ${e.message}\n`);
    return EXIT.INCOMPLETE;
  }
  let counts;
  try { counts = countReports(resolve(o.dir)); } catch (e) {
    io.stderr.write(`test-baseline: cannot read reports in ${o.dir}: ${e.message}\n`);
    return EXIT.INCOMPLETE;
  }
  if (o.seed && o['require-reports'] && counts.files === 0) {
    io.stderr.write(`test-baseline: FAIL --seed --require-reports: no JUnit report files in ${o.dir}; the test tasks wrote no reports, so the baseline was not seeded\n`);
    return EXIT.FAIL;
  }
  if (o.seed && o['require-reports'] && counts.executed === 0) {
    io.stderr.write(`test-baseline: FAIL --seed --require-reports: the reports in ${o.dir} hold 0 executed tests, so the baseline was not seeded. ` +
      'Check that the test include patterns match the repo test files, or seed without --require-reports when the repo has no tests yet\n');
    return EXIT.FAIL;
  }
  let updated = false;
  if (o.seed) {
    baseline = seedBaseline(baseline, counts);
    updated = true;
  } else if (o.update && counts.executed > baseline.min_tests) {
    baseline = { ...baseline, min_tests: counts.executed };
    updated = true;
  }
  if (updated) {
    try { writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`); } catch (e) {
      io.stderr.write(`test-baseline: cannot write ${baselineFile}: ${e.message}\n`);
      return EXIT.INCOMPLETE;
    }
  }
  const problems = judge(counts, baseline);
  io.stderr.write(`test-baseline: ${counts.executed} executed, ${counts.skipped} skipped in ${counts.files} report files (min_tests ${baseline.min_tests}, max_skipped ${baseline.max_skipped})\n`);
  if (updated && o.seed) io.stderr.write(`test-baseline: seeded min_tests ${baseline.min_tests}, max_skipped ${baseline.max_skipped}, reports_expected ${baseline.reports_expected} in ${o.baseline}\n`);
  else if (updated) io.stderr.write(`test-baseline: raised min_tests to ${baseline.min_tests} in ${o.baseline}\n`);
  for (const p of problems) io.stderr.write(`test-baseline: FAIL ${p}\n`);
  if (o.json) io.stdout.write(`${JSON.stringify({ counts, baseline, updated, ok: problems.length === 0, problems })}\n`);
  return problems.length ? EXIT.FAIL : EXIT.OK;
}

// Run as a CLI only when this file is the entry point (realpath: tmp dirs are often symlinks).
function isMain() {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
