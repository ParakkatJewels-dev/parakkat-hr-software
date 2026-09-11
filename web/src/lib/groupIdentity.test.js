import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameGroup, setGroupPicture, GROUP_PICTURE_MAX_BYTES } from './groupIdentity.js';

const conversationId = '90000000-0000-0000-0000-000000000001';
const original = `${conversationId}/group-photo/original.png`;
const file = { name: '../../team photo.png', type: 'image/png', size: 1024 };
function clientFor({ kind = 'group', oldPath = original, readError = null, updateError = null, updated = true, uploadError = null, cleanupError = false } = {}) {
  const calls = [];
  return { calls,
    from(table) {
      const filters = [];
      let values;
      const query = {
        update(data) { values = data; calls.push(['update', table, data]); return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        select() {
          if (!values) return query;
          calls.push(['filters', filters]);
          return Promise.resolve({ data: updated ? [{ id: conversationId }] : [], error: updateError });
        },
        single() { return Promise.resolve({ data: { id: conversationId, kind, photo_path: oldPath }, error: readError }); },
      };
      return query;
    },
    storage: { from(bucket) { assert.equal(bucket, 'chat-media'); return {
      async upload(path, image, options) { calls.push(['upload', path, image, options]); return { error: uploadError }; },
      async remove(paths) { calls.push(['remove', paths]); if (cleanupError) throw new Error('Cleanup unavailable'); return { error: null }; },
    }; } },
  };
}

test('group rename trims its value and requires an affected group row', async () => {
  const client = clientFor();
  await renameGroup(client, { conversationId, title: '  Team updates  ' });
  assert.deepEqual(client.calls, [['update', 'conversations', { title: 'Team updates' }],
    ['filters', [['id', conversationId], ['kind', 'group']]]]);
  await assert.rejects(renameGroup(clientFor({ updated: false }), { conversationId, title: 'Team' }), /Only members/);
});
test('empty or oversized names never send an update', async () => {
  const client = clientFor();
  for (const title of ['', '  ', 'a'.repeat(121)]) await assert.rejects(renameGroup(client, { conversationId, title }), /1 and 120/);
  assert.deepEqual(client.calls, []);
});
test('invalid group images are rejected before reading or uploading', async () => {
  const client = clientFor();
  for (const invalid of [{ ...file, type: 'image/svg+xml' }, { ...file, size: 0 }, { ...file, size: GROUP_PICTURE_MAX_BYTES + 1 }]) {
    await assert.rejects(setGroupPicture(client, { conversationId, file: invalid }), /Choose/);
  }
  assert.deepEqual(client.calls, []);
});
test('a direct message cannot upload or change its picture', async () => {
  const client = clientFor({ kind: 'direct' });
  await assert.rejects(setGroupPicture(client, { conversationId, file }), /Only groups/);
  assert.deepEqual(client.calls, []);
});
test('successful group picture save uses a private unique group path and cleans up the previous picture', async () => {
  const client = clientFor();
  const path = await setGroupPicture(client, { conversationId, file });
  assert.match(path, new RegExp(`^${conversationId}/group-photo/[A-Za-z0-9_.-]+\\.png$`));
  assert.ok(!path.includes('..'));
  assert.deepEqual(client.calls[0], ['upload', path, file, { contentType: 'image/png', upsert: false }]);
  assert.deepEqual(client.calls[1], ['update', 'conversations', { photo_path: path }]);
  assert.deepEqual(client.calls[2], ['filters', [['id', conversationId], ['kind', 'group']]]);
  assert.deepEqual(client.calls[3], ['remove', [original]]);
});
test('exactly 5 MB is accepted and failed optional cleanup does not report the saved picture as failed', async () => {
  const path = await setGroupPicture(clientFor({ cleanupError: true }), { conversationId, file: { ...file, size: GROUP_PICTURE_MAX_BYTES } });
  assert.ok(path);
});
test('failed or unauthorized updates remove the new upload and preserve the old picture', async () => {
  for (const config of [{ updateError: new Error('Save unavailable') }, { updated: false }]) {
    const client = clientFor(config);
    await assert.rejects(setGroupPicture(client, { conversationId, file }), /Save unavailable|Only members/);
    const uploaded = client.calls[0][1];
    assert.deepEqual(client.calls.filter(([action]) => action === 'remove'), [['remove', [uploaded]]]);
  }
});
test('upload failure never updates the picture or removes the existing file', async () => {
  const client = clientFor({ uploadError: new Error('Upload unavailable') });
  await assert.rejects(setGroupPicture(client, { conversationId, file }), /Upload unavailable/);
  assert.equal(client.calls.length, 1);
});
test('removing a picture saves null before cleanup and never deletes ordinary attachments', async () => {
  const client = clientFor();
  assert.equal(await setGroupPicture(client, { conversationId }), null);
  assert.deepEqual(client.calls[0], ['update', 'conversations', { photo_path: null }]);
  assert.deepEqual(client.calls.at(-1), ['remove', [original]]);
  const attachment = clientFor({ oldPath: `${conversationId}/ordinary-attachment.png` });
  await setGroupPicture(attachment, { conversationId });
  assert.equal(attachment.calls.filter(([action]) => action === 'remove').length, 0);
});
test('a failed initial read never attempts a storage mutation', async () => {
  const client = clientFor({ readError: new Error('Read unavailable') });
  await assert.rejects(setGroupPicture(client, { conversationId, file }), /Read unavailable/);
  assert.deepEqual(client.calls, []);
});

function uncertainSave({ committed, confirmationFails = false }) {
  let savedPath = original;
  let reads = 0;
  const objects = new Set([original]);
  const removed = [];
  const client = {
    from() {
      let change;
      const query = {
        select() {
          if (!change) return query;
          if (committed) savedPath = change.photo_path;
          return Promise.resolve({ data: null, error: new Error('Save response lost') });
        },
        eq() { return query; },
        single() {
          reads++;
          return Promise.resolve(reads > 1 && confirmationFails
            ? { data: null, error: new Error('Confirmation unavailable') }
            : { data: { id: conversationId, kind: 'group', photo_path: savedPath }, error: null });
        },
        update(values) { change = values; return query; },
      };
      return query;
    },
    storage: { from() { return {
      async upload(path) { objects.add(path); return { error: null }; },
      async remove(paths) { for (const path of paths) { objects.delete(path); removed.push(path); } return { error: null }; },
    }; } },
  };
  return { client, objects, removed, current: () => savedPath };
}

test('a committed picture survives a lost update response and is reported saved after confirmation', async () => {
  const fixture = uncertainSave({ committed: true });
  const path = await setGroupPicture(fixture.client, { conversationId, file });
  assert.equal(fixture.current(), path);
  assert.ok(fixture.objects.has(path), 'the saved picture must still exist');
  assert.deepEqual(fixture.removed, [original]);
});

test('an uncertain save preserves the new upload when confirming the database is unavailable', async () => {
  for (const committed of [true, false]) {
    const fixture = uncertainSave({ committed, confirmationFails: true });
    await assert.rejects(setGroupPicture(fixture.client, { conversationId, file }), /Save response lost/);
    assert.equal(fixture.objects.size, 2, 'retain both images until the committed state is known');
    assert.deepEqual(fixture.removed, []);
  }
});

test('a confirmed rejected picture removes only the unattached upload and preserves the original', async () => {
  const fixture = uncertainSave({ committed: false });
  await assert.rejects(setGroupPicture(fixture.client, { conversationId, file }), /Save response lost/);
  assert.equal(fixture.current(), original);
  assert.deepEqual([...fixture.objects], [original]);
  assert.equal(fixture.removed.length, 1);
  assert.notEqual(fixture.removed[0], original);
});
