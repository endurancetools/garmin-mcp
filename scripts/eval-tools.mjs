#!/usr/bin/env node
// Tool selection eval: does a model pick the right MCP tool for a user message?
//
// Runs every scenario of docs/evals/tool-selection.jsonl as one `claude -p` call (the signed-in
// Claude Code, no API key) with only the MCP server of scripts/eval-fake-server.mjs attached: the
// real tools and instructions over stdio, a fake GarminService, nothing reaches Garmin. The first
// tool call of the reply is compared with `expect` / `forbid`.
//
//   pnpm nx build garmin-mcp-server
//   node scripts/eval-tools.mjs [scenarios.jsonl]
//
// EVAL_MODEL (`--model`, default sonnet), EVAL_MIN_PASS (default 0.9). Exit codes: 0 pass rate at
// or above EVAL_MIN_PASS, 1 below it, 2 no `claude` on PATH (so CI never runs it).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SCENARIOS = fileURLToPath(new URL('../docs/evals/tool-selection.jsonl', import.meta.url));
const DEFAULT_MODEL = 'sonnet';
const FAKE_SERVER = fileURLToPath(new URL('./eval-fake-server.mjs', import.meta.url));
const SERVER_NAME = 'garmin';
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const TIMEOUT_MS = 180_000;
const DEFAULT_MIN_PASS = 0.9;

/**
 * Scenarios from JSON Lines: one `{ prompt, expect: { tool, args_include? }, forbid? }` per line,
 * blank lines and lines starting with `//` skipped. `expect.tool` null means no tool call fits; a
 * list of names means any of them fits. With a list, `args_include` keyed only by listed tool names
 * is per tool (checked only for a tool that has an entry), any other object applies to every tool.
 * @param {string} text
 */
export function parseScenarios(text) {
  const scenarios = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    let s;
    try {
      s = JSON.parse(line);
    } catch (error) {
      throw new Error(`line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof s?.prompt !== 'string' || !s.prompt.trim()) throw new Error(`line ${i + 1}: "prompt" must be a non-empty string`);
    if (typeof s.expect !== 'object' || s.expect === null || !('tool' in s.expect)) throw new Error(`line ${i + 1}: "expect.tool" is required (a tool name or null)`);
    const tool = s.expect.tool;
    const isList = Array.isArray(tool) && tool.length > 0 && tool.every((t) => typeof t === 'string' && t !== '');
    if (tool !== null && typeof tool !== 'string' && !isList) throw new Error(`line ${i + 1}: "expect.tool" must be a tool name, a non-empty list of tool names or null`);
    if (s.forbid !== undefined && !(Array.isArray(s.forbid) && s.forbid.every((t) => typeof t === 'string'))) throw new Error(`line ${i + 1}: "forbid" must be a list of tool names`);
    const clash = expectedTools({ expect: { tool } }).find((t) => s.forbid?.includes(t));
    if (clash) throw new Error(`line ${i + 1}: ${clash} is both expected and forbidden`);
    scenarios.push({ line: i + 1, prompt: s.prompt, expect: { tool: s.expect.tool, args_include: s.expect.args_include }, forbid: s.forbid ?? [] });
  });
  return scenarios;
}

/**
 * Tool names that fit a scenario (empty when no tool call fits).
 * @param {{ expect: { tool: string | string[] | null } }} scenario
 * @returns {string[]}
 */
export function expectedTools(scenario) {
  const { tool } = scenario.expect;
  return tool === null ? [] : Array.isArray(tool) ? tool : [tool];
}

/**
 * The `args_include` a call of `name` must satisfy: per tool when the scenario lists several tools
 * and keys `args_include` by their names only, otherwise the shared object.
 * @param {ReturnType<typeof parseScenarios>[number]} scenario
 * @param {string} name
 * @returns {unknown}
 */
function argsFor(scenario, name) {
  const { tool, args_include: args } = scenario.expect;
  if (!Array.isArray(tool) || args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const keys = Object.keys(args);
  const perTool = keys.length > 0 && keys.every((k) => tool.includes(k));
  return perTool ? args[name] : args;
}

/**
 * Whether `actual` contains `expected`: objects key by key (extra keys allowed), arrays element by
 * element (each expected element matches some actual element, order free), numbers also against
 * numeric strings (the server coerces ids), everything else strictly.
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
export function includes(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((e) => actual.some((a) => includes(a, e)));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => includes(/** @type {Record<string, unknown>} */ (actual)[k], v));
  }
  if (typeof expected === 'number' && typeof actual === 'string') return actual.trim() !== '' && Number(actual) === expected;
  return actual === expected;
}

/**
 * Verdict for the first tool call of a reply (`undefined` when the model called no tool).
 * @param {ReturnType<typeof parseScenarios>[number]} scenario
 * @param {{ name: string, input: unknown } | undefined} call
 * @returns {{ pass: boolean, reason: string }}
 */
export function judge(scenario, call) {
  const name = call?.name ?? null;
  if (name !== null && scenario.forbid.includes(name)) return { pass: false, reason: `forbidden ${name}` };
  const allowed = expectedTools(scenario);
  if (name === null ? allowed.length > 0 : !allowed.includes(name)) return { pass: false, reason: `expected ${expectedLabel(scenario)}` };
  const args = name === null ? undefined : argsFor(scenario, name);
  if (call && args !== undefined && !includes(call.input, args)) {
    return { pass: false, reason: `args lack ${JSON.stringify(args)}` };
  }
  return { pass: true, reason: '' };
}

/** @param {{ expect: { tool: string | string[] | null } }} scenario */
function expectedLabel(scenario) {
  const tools = expectedTools(scenario);
  return tools.length ? tools.join(' | ') : 'no tool';
}

/**
 * First tool call of a `claude -p --output-format stream-json` run: the first `tool_use` block of
 * the first assistant message (Claude Code emits one event per content block, all with the same
 * `message.id`), with the `mcp__garmin__` prefix stripped. `call` is `null` when that message has
 * no tool call; `error` carries the result event's message when there was no assistant message.
 * @param {string} text
 * @returns {{ call: { name: string, input: unknown } | null, error?: string }}
 */
export function firstToolCall(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // not an event (e.g. a stray log line)
    }
  }
  const assistant = events.filter((e) => e?.type === 'assistant' && !e.parent_tool_use_id && e.message);
  if (assistant.length === 0) {
    const result = events.find((e) => e?.type === 'result');
    const detail = result ? (Array.isArray(result.errors) && result.errors.length ? result.errors.join('; ') : result.result || result.subtype) : 'no events';
    return { call: null, error: String(detail ?? 'no assistant message') };
  }
  const id = assistant[0].message.id;
  const blocks = (id ? assistant.filter((e) => e.message.id === id) : [assistant[0]]).flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []));
  const block = blocks.find((b) => b?.type === 'tool_use');
  if (!block) return { call: null };
  const name = String(block.name).startsWith(TOOL_PREFIX) ? String(block.name).slice(TOOL_PREFIX.length) : String(block.name);
  return { call: { name, input: block.input ?? {} } };
}

/**
 * One scenario through `claude -p`: no built-in tools, no settings files, only the fake server.
 * @param {string} prompt
 * @param {{ cwd: string, mcpConfig: string, model: string }} opts
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
function runClaude(prompt, { cwd, mcpConfig, model }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', '1',
    '--no-session-persistence',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--setting-sources', '',
    '--tools', '',
    '--allowedTools', `${TOOL_PREFIX}*`,
    '--model', model,
  ];
  // Started from inside a Claude Code session the child would otherwise see itself as nested.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return new Promise((done, fail) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ stdout, stderr, code });
    });
  });
}

/** @param {string[][]} rows */
function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()).join('\n');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function main() {
  if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).error) {
    console.error('`claude` (Claude Code) is not on PATH; the tool selection eval runs through a signed-in `claude -p` and is not run without it.');
    return 2;
  }
  const file = resolve(process.argv[2] ?? DEFAULT_SCENARIOS);
  const scenarios = parseScenarios(readFileSync(file, 'utf8'));
  const model = process.env.EVAL_MODEL || DEFAULT_MODEL;
  const minPass = process.env.EVAL_MIN_PASS ? Number(process.env.EVAL_MIN_PASS) : DEFAULT_MIN_PASS;
  if (!Number.isFinite(minPass) || minPass < 0 || minPass > 1) throw new Error(`EVAL_MIN_PASS must be a number from 0 to 1, got ${process.env.EVAL_MIN_PASS}`);

  // Same tool set as the fake server: destructive tools off.
  const { selectTools } = await import('garmin-mcp-server');
  const known = new Set(selectTools({ destructive: false }).map((t) => t.name));
  for (const s of scenarios) {
    for (const name of [...expectedTools(s), ...s.forbid]) {
      if (!known.has(name)) throw new Error(`${file}:${s.line}: unknown tool ${name}`);
    }
  }

  // A fresh directory as cwd keeps the repo's CLAUDE.md and project memory out of the prompt.
  const cwd = mkdtempSync(join(tmpdir(), 'garmin-mcp-eval-'));
  const mcpConfig = join(cwd, 'mcp-config.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: process.execPath, args: [FAKE_SERVER] } } }));
  try {
    console.log(`${scenarios.length} scenarios, claude -p --model ${model}, ${known.size} tools\n`);
    const rows = [['#', 'result', 'expected', 'called', 'prompt', 'note']];
    let passed = 0;
    for (const [i, s] of scenarios.entries()) {
      const { stdout, stderr, code } = await runClaude(s.prompt, { cwd, mcpConfig, model });
      const { call, error } = firstToolCall(stdout);
      const verdict = error ? { pass: false, reason: `claude error (exit ${code}): ${clip(error || stderr.trim(), 80)}` } : judge(s, call ?? undefined);
      if (verdict.pass) passed++;
      const called = call ? `${call.name} ${JSON.stringify(call.input)}` : '-';
      rows.push([String(i + 1), verdict.pass ? 'ok' : 'MISS', clip(expectedTools(s).join(' | ') || '(none)', 50), clip(called, 70), clip(s.prompt, 50), verdict.reason]);
    }
    const rate = scenarios.length ? passed / scenarios.length : 0;
    console.log(table(rows));
    console.log(`\npass rate ${passed}/${scenarios.length} = ${(rate * 100).toFixed(1)}% (minimum ${(minPass * 100).toFixed(1)}%)`);
    return rate >= minPass ? 0 : 1;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
