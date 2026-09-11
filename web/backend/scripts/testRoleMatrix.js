const { readdirSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function testRoleMatrix({ run, connection, directory }) {
  const database = 'hr_role_matrix_audit';
  const backend = join(__dirname, '..');
  const migrations = join(backend, 'supabase', 'migrations');
  const files = readdirSync(migrations).filter(file => file.endsWith('.sql')).sort();
  run('createdb', [...connection, database]);
  const bootstrap = join(directory, 'role-matrix-bootstrap.sql');
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  writeFileSync(bootstrap, [
    '\\set ON_ERROR_STOP on',
    `\\i ${quote(join(backend, 'tests', 'supabase_fixture.sql'))}`,
    ...files.flatMap(file => [
      ...(file.startsWith('0062_') ? [
        "-- 0062 expects the GN shift configured manually in the deployed baseline.",
        "insert into public.shifts(code,name,start_time,end_time) values ('GN','Synthetic configured baseline','09:00','17:30');",
      ] : []),
      `\\i ${quote(join(migrations, file))}`,
    ]),
  ].join('\n'));
  run('psql', [...connection, '-d', database, '-q', '-f', bootstrap]);
  run('psql', [...connection, '-d', database, '-q', '-f', join(backend, 'tests', 'standard_role_fixture.sql')]);
  const catalogue = JSON.parse(run('psql', [...connection, '-d', database, '-XAt', '-c', `
    select jsonb_agg(x order by x->>'key') from (
      select jsonb_build_object('key', r.key, 'rank', r.rank, 'name', r.name,
        'permissions', coalesce((select jsonb_agg(p.key order by p.key)
          from public.role_permissions rp join public.permissions p on p.id=rp.permission_id
          where rp.role_id=r.id), '[]'::jsonb)) x from public.roles r where r.is_system
    ) roles
  `]));
  const fixtureDirectory = join(backend, 'tests', 'fixtures');
  const actorSql = `
    create function audit_test.actor_access(_user uuid) returns jsonb language plpgsql as $$
    begin perform set_config('request.jwt.claim.sub', _user::text, true); return public.get_my_access(); end $$;
    select jsonb_build_object(
      'actors', (select jsonb_agg(jsonb_build_object('key',key,'userId',user_id,'employeeId',employee_id,
        'scopeType',scope_type,'scopeId',scope_id,'access',audit_test.actor_access(user_id)) order by ordinal) from audit_test.actors),
      'org', jsonb_build_object(
        'entities',(select jsonb_agg(to_jsonb(e) - 'created_at' order by id) from public.entities e where code like 'AUDIT-%'),
        'zones',(select jsonb_agg(to_jsonb(z) - 'created_at' order by id) from public.zones z where name like 'Audit %'),
        'branches',(select jsonb_agg(to_jsonb(b) - 'created_at' order by id) from public.branches b where code like 'AUDIT-%'),
        'departments',(select jsonb_agg(to_jsonb(d) - 'created_at' order by id) from public.departments d where name like 'Audit %'),
        'employees',(select jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'entity_id',entity_id,
          'zone_id',zone_id,'branch_id',branch_id,'department_id',department_id,'employee_code',employee_code,
          'full_name',full_name,'status',status) order by id) from public.employees where employee_code like 'TARGET-%' or employee_code like 'ACTOR-%')
      )
    );`;
  const actorFixture = JSON.parse(run('psql', [...connection, '-d', database, '-XqAt', '-c', actorSql]));
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(join(fixtureDirectory, 'standard-role-access.json'), JSON.stringify({
    source: 'Fresh isolated PostgreSQL replay of every application migration',
    migrations: files, roles: catalogue, ...actorFixture,
  }, null, 2) + '\n');
  writeFileSync(join(backend, '..', 'src', 'test', 'standardRolePermissions.json'), JSON.stringify(
    Object.fromEntries(catalogue.map(role => [role.key, { rank: role.rank, permissions: role.permissions }])), null, 2
  ) + '\n');
  console.log(`PASS: ${files.length} production migrations replayed in an isolated database; actual standard-role grants exported`);
  const output = run('psql', [...connection, '-d', database, '-q', '-f', join(backend, 'tests', 'standard_role_matrix.sql')]);
  console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
  const summary = JSON.parse(run('psql', [...connection, '-d', database, '-XqAt', '-c', `
    select jsonb_build_object('assertions',(select count(*) from audit_test.results),
      'groups',(select jsonb_object_agg(role_key,n) from (
        select split_part(label,'/',1) role_key,count(*) n from audit_test.results group by 1
      ) counts))
  `]));
  writeFileSync(join(fixtureDirectory, 'standard-role-results.json'), JSON.stringify({
    source: 'Actual PostgreSQL RLS and mutation results in an isolated cluster',
    migrationCount: files.length, ...summary,
  }, null, 2) + '\n');
};
