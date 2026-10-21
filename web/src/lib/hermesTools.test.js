import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AGENT_AREAS, HERMES_TOOLS, LEDGER_INTERNAL_TOOLS, checkArguments, toolsForAreas } from './hermesTools.js';

const migration = await readFile(new URL('../../backend/supabase/migrations/0168_hermes_agent_api.sql', import.meta.url), 'utf8');
// 0176 is the latest definition of the area map and the Work Ledger dispatcher (on task records).
const ledgerMigration = await readFile(new URL('../../backend/supabase/migrations/0176_work_assistant.sql', import.meta.url), 'utf8');

test('the catalogue and the database dispatchers name exactly the same tools', () => {
  const core = [...migration.matchAll(/when '([a-z_]+)' then _result :=/g)].map((match) => match[1]);
  const dispatcher = ledgerMigration.slice(ledgerMigration.indexOf('function hr_agent.ledger_dispatch'));
  const ledger = [...dispatcher.matchAll(/when '(ledger_[a-z_]+)' then/g)].map((match) => match[1]).filter((name) => !LEDGER_INTERNAL_TOOLS.includes(name));
  const dispatched = [...core, ...ledger].sort();
  assert.deepEqual(HERMES_TOOLS.map((tool) => tool.name).sort(), dispatched);
  assert.equal(new Set(dispatched).size, dispatched.length);
  for (const name of LEDGER_INTERNAL_TOOLS) assert.ok(dispatcher.includes(`when '${name}' then`), `${name} handled internally`);
});

test('each tool belongs to the same area in the catalogue and in the database', () => {
  const scope = ledgerMigration.slice(ledgerMigration.indexOf('function app.agent_tool_scope'), ledgerMigration.indexOf('revoke all on function app.agent_tool_scope'));
  const areas = new Map();
  for (const [, names, area] of scope.matchAll(/when _tool in \(([^)]*)\) then '([a-z:]+)'/g)) {
    for (const [, name] of names.matchAll(/'([a-z_]+)'/g)) areas.set(name, area);
  }
  for (const tool of HERMES_TOOLS) assert.equal(areas.get(tool.name), tool.area, tool.name);
  assert.equal(areas.size, HERMES_TOOLS.length + LEDGER_INTERNAL_TOOLS.length);
});

test('nothing in the catalogue deletes, removes or trashes', () => {
  for (const tool of HERMES_TOOLS) {
    assert.doesNotMatch(tool.name, /delete|remove|trash|untick|purge/);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i, 'the migration never deletes rows');
  assert.doesNotMatch(ledgerMigration, /\bdelete\s+from\b|ledger_delete_/i, 'the ledger tools never delete');
  assert.doesNotMatch(migration, /soft_delete_task|set_routine_job_tick/, 'trash and untick RPCs are not reachable');
});

test('areas filter tools; the basics are always present', () => {
  assert.deepEqual(toolsForAreas([]).map((tool) => tool.name), ['whoami', 'find_employees', 'list_departments']);
  const leave = toolsForAreas(['leave:manage']).map((tool) => tool.name);
  assert.ok(leave.includes('decide_leave') && !leave.includes('create_task'));
  assert.equal(toolsForAreas(AGENT_AREAS).length, HERMES_TOOLS.length);
});

test('argument shape check: required, unknown, types, sizes and nested routine jobs', () => {
  const tool = (name) => HERMES_TOOLS.find((candidate) => candidate.name === name).inputSchema;
  assert.equal(checkArguments(tool('whoami'), {}), null);
  assert.match(checkArguments(tool('get_task'), {}), /task_id is required/);
  assert.equal(checkArguments(tool('update_task'), { task_id: 't', status: 'done', description: null }), null, 'values are left to the database');
  assert.match(checkArguments(tool('update_routine'), { routine_id: 'r', title: 't', schedule: { frequency: 'daily', start_date: '2026-11-01' },
    jobs: [{ id: 'j', title: 'a', colour: 'red' }] }), /jobs\[0\]\.colour is not a known field/);
  assert.match(checkArguments(tool('create_routine'), { employee_ids: ['e'], title: 't', jobs: [{ title: 'a' }], schedule: { start_date: '2026-11-01' } }),
    /schedule\.frequency is required/);
  assert.match(checkArguments(tool('update_goal'), { goal_id: 'g', progress: 10.5 }), /whole number/);
  assert.match(checkArguments(tool('create_task'), []), /must be an object/);
});
