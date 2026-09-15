// A disposable-cluster contract test: sends and read receipts race on separate DB connections.
// The only input is the private UNIX socket created by testDatabase.js; no hosted URL is read.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires the disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({
    host: socket, user: 'audit_owner', database: 'hr_message_requests_audit',
  }));
  const [sender, reader, observer] = clients;
  try {
    await Promise.all(clients.map(async client => {
      await client.connect();
      await client.query("set statement_timeout = '5s'");
    }));
    await sender.query("set role authenticated; set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001'");
    await reader.query("set role authenticated; set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003'");
    const { rows: [ids] } = await observer.query("select audit_message.ref('group') room, audit_message.ref('group-followup') previous");
    const readerPid = (await reader.query('select pg_backend_pid() pid')).rows[0].pid;
    const senderPid = (await sender.query('select pg_backend_pid() pid')).rows[0].pid;
    const read = messageId => reader.query('select public.acknowledge_message_receipts($1,array[$2]::uuid[],true)', [ids.room, messageId]);
    const send = messageId => sender.query(
      "insert into public.messages(id,conversation_id,sender_id,body) values ($1,$2,audit_message.id(4,1),'Concurrent incoming activity')",
      [messageId, ids.room]);
    const waitForLock = async pid => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('the competing operation must wait on the conversation lock');
    };
    const assertUnread = async () => {
      const { rows: [row] } = await reader.query(
        "select (select unread_count from public.my_conversations where id=$1) unread, exists(select 1 from public.notifications where type='message' and ref_id=$1 and read_at is null) notified",
        [ids.room]);
      assert.equal(Number(row.unread), 1, 'the newly sent message remains unread');
      assert.equal(row.notified, true, 'the newly sent message retains its notification');
    };

    // A send has refreshed the bell but has not committed when the old read receipt arrives.
    await sender.query('begin');
    const first = '70000000-0000-0000-0000-000000000201';
    await send(first);
    const waitingRead = read(ids.previous);
    waitingRead.catch(() => {});
    await waitForLock(readerPid);
    await sender.query('commit');
    await waitingRead;
    await assertUnread();
    await read(first);

    // The read commits first; a send waiting behind it must create a fresh unread notification.
    await reader.query('begin');
    await read(first);
    const second = '70000000-0000-0000-0000-000000000202';
    const waitingSend = send(second);
    waitingSend.catch(() => {});
    await waitForLock(senderPid);
    await reader.query('commit');
    await waitingSend;
    await assertUnread();
    await read(second);
    console.log('PASS: concurrent sends and old read receipts preserve new unread messages and notifications in both lock orders');
  } finally {
    await Promise.all(clients.map(async client => {
      try { await client.query('rollback'); } catch { /* connection may not have completed */ }
      await client.end();
    }));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
