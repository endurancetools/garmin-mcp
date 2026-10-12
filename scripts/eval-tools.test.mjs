import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedTools, firstToolCall, includes, judge, parseScenarios } from './eval-tools.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('eval-tools', () => {
  it('parses JSON Lines scenarios and names the bad line', () => {
    const text = [
      '{"prompt":"Jak spałem w tym tygodniu?","expect":{"tool":"query_health","args_include":{"metrics":["sleep"]}},"forbid":["garmin_sync"]}',
      '',
      '// comment',
      '{"prompt":"Usuń aktywność 123","expect":{"tool":null}}',
    ].join('\n');
    expect(parseScenarios(text)).toEqual([
      { line: 1, prompt: 'Jak spałem w tym tygodniu?', expect: { tool: 'query_health', args_include: { metrics: ['sleep'] } }, forbid: ['garmin_sync'] },
      { line: 4, prompt: 'Usuń aktywność 123', expect: { tool: null, args_include: undefined }, forbid: [] },
    ]);
    expect(() => parseScenarios('{"prompt":"x","expect":{}}\n{oops')).toThrow('line 1: "expect.tool" is required');
    expect(() => parseScenarios('{oops')).toThrow(/^line 1: /);
  });

  it('matches args_include as a subset of the tool input', () => {
    const input = { metrics: ['hrv', 'sleep', 'resting_hr'], granularity: 'day', from: '2026-10-06' };
    expect(includes(input, { metrics: ['sleep', 'hrv'] })).toBe(true);
    expect(includes(input, { metrics: ['steps'] })).toBe(false);

    const schedule = { items: [{ date: '2026-10-15', workout_id: '1727354116' }], unschedule: [] };
    expect(includes(schedule, { items: [{ date: '2026-10-15', workout_id: 1727354116 }] })).toBe(true);
    expect(includes(schedule, { items: [{ date: '2026-10-16' }] })).toBe(false);
  });

  it('fails a forbidden first call, a wrong tool and any call where none fits', () => {
    const [preview, del] = parseScenarios(
      '{"prompt":"Zrób mi 6x400 m","expect":{"tool":"preview_workout"},"forbid":["create_workout"]}\n{"prompt":"Usuń aktywność 123","expect":{"tool":null}}',
    );
    expect(judge(preview, { name: 'preview_workout', input: {} }).pass).toBe(true);
    expect(judge(preview, { name: 'create_workout', input: {} })).toEqual({ pass: false, reason: 'forbidden create_workout' });
    expect(judge(del, undefined).pass).toBe(true);
    expect(judge(del, { name: 'get_activity', input: { id: 123 } }).pass).toBe(false);
  });

  it('accepts any tool of an expect.tool list, with shared or per-tool args_include', () => {
    const [workout, week, sleep] = parseScenarios(
      [
        '{"prompt":"Zrób mi trening 6x400 m","expect":{"tool":["preview_workout","get_training_status","list_workouts"]},"forbid":["create_workout","schedule_workouts"]}',
        '{"prompt":"What did I do last week?","expect":{"tool":["get_activities","get_period_summary"],"args_include":{"from":"2026-10-05"}}}',
        '{"prompt":"Jak spałem w tym tygodniu?","expect":{"tool":["query_health","get_sleep"],"args_include":{"query_health":{"metrics":["sleep"]}}}}',
      ].join('\n'),
    );
    expect(workout.expect.tool).toEqual(['preview_workout', 'get_training_status', 'list_workouts']);
    expect(judge(workout, { name: 'get_training_status', input: {} }).pass).toBe(true);
    expect(judge(workout, { name: 'list_workouts', input: { from: '2026-10-12' } }).pass).toBe(true);
    expect(judge(workout, { name: 'get_activities', input: {} })).toEqual({ pass: false, reason: 'expected preview_workout | get_training_status | list_workouts' });
    expect(judge(workout, undefined).pass).toBe(false);

    // Shared args_include applies to every listed tool.
    expect(judge(week, { name: 'get_period_summary', input: { period: 'range', from: '2026-10-05', to: '2026-10-11' } }).pass).toBe(true);
    expect(judge(week, { name: 'get_activities', input: { limit: 20 } }).pass).toBe(false);

    // Per-tool args_include is checked only for a tool that has an entry.
    expect(judge(sleep, { name: 'query_health', input: { metrics: ['sleep'] } }).pass).toBe(true);
    expect(judge(sleep, { name: 'query_health', input: { metrics: ['steps'] } }).pass).toBe(false);
    expect(judge(sleep, { name: 'get_sleep', input: { from: '2026-10-06', to: '2026-10-12' } }).pass).toBe(true);

    expect(() => parseScenarios('{"prompt":"x","expect":{"tool":[]}}')).toThrow('line 1: "expect.tool" must be');
    expect(() => parseScenarios('{"prompt":"x","expect":{"tool":["preview_workout",null]}}')).toThrow('line 1: "expect.tool" must be');
  });

  it('fails a forbidden first call when expect.tool is a list, and rejects a tool both listed and forbidden', () => {
    const [workout] = parseScenarios('{"prompt":"Zrób mi 6x400 m","expect":{"tool":["preview_workout","list_workouts"]},"forbid":["create_workout"]}');
    expect(judge(workout, { name: 'create_workout', input: {} })).toEqual({ pass: false, reason: 'forbidden create_workout' });
    expect(() => parseScenarios('{"prompt":"x","expect":{"tool":["preview_workout","create_workout"]},"forbid":["create_workout"]}')).toThrow(
      'line 1: create_workout is both expected and forbidden',
    );
  });

  it('takes the first tool_use of the first assistant message from claude -p stream-json', () => {
    expect(firstToolCall(fixture('stream-tool-use.jsonl'))).toEqual({
      call: { name: 'query_health', input: { metrics: ['sleep'], from: '2026-10-06', to: '2026-10-12' } },
    });
  });

  it('reports no call when the first assistant message has no tool_use, and an error without one', () => {
    expect(firstToolCall(fixture('stream-no-tool.jsonl'))).toEqual({ call: null });
    expect(firstToolCall('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Not logged in"]}\n')).toEqual({ call: null, error: 'Not logged in' });
  });

  it('ships at least 25 valid scenarios, Polish and English, with the delete case and every analytics tool', () => {
    const scenarios = parseScenarios(readFileSync(new URL('../docs/evals/tool-selection.jsonl', import.meta.url), 'utf8'));
    expect(scenarios.length).toBeGreaterThanOrEqual(25);
    expect(scenarios.some((s) => /[ąćęłńóśźż]/i.test(s.prompt))).toBe(true);
    expect(scenarios.some((s) => s.expect.tool === null)).toBe(true);
    const tools = new Set(scenarios.flatMap((s) => expectedTools(s)));
    for (const name of ['preview_workout', 'create_workout', 'schedule_workouts', 'get_load', 'get_readiness', 'get_thresholds', 'set_threshold']) {
      expect(tools).toContain(name);
    }
  });
});
