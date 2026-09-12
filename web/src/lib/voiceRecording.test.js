import { test } from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createVoiceRecording } from './voiceRecording.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function microphone() {
  const tracks = [{ stops: 0, stop() { this.stops += 1; } }, { stops: 0, stop() { this.stops += 1; } }];
  return { tracks, getTracks: () => tracks };
}

function setup(options = {}) {
  const devices = [];
  const recordings = [];
  const changes = [];
  const errors = [];
  const files = [];
  let time = 0;
  class Recorder {
    static isTypeSupported(type) { return type === (options.supportedType ?? 'audio/webm;codecs=opus'); }
    constructor(stream, config) {
      if (options.constructorError) throw options.constructorError;
      this.stream = stream;
      this.mimeType = options.actualType ?? config?.mimeType ?? '';
      this.state = 'inactive';
      this.stops = 0;
      recordings.push(this);
    }
    start(timeslice) {
      if (options.startError) throw options.startError;
      this.timeslice = timeslice;
      this.state = 'recording';
    }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.stops += 1; this.state = 'inactive'; }
    data(text = 'audio', type = this.mimeType) { this.ondataavailable?.({ data: new Blob([text], { type }) }); }
    stopped() { this.state = 'inactive'; this.onstop?.(); }
    error(name = 'UnknownError') { this.onerror?.({ error: { name } }); }
  }
  const session = createVoiceRecording({
    onChange: state => changes.push(state),
    onError: message => errors.push(message),
    onReady: (file, duration, detail) => files.push({ file, duration, detail }),
    maxBytes: options.maxBytes,
  }, {
    mediaDevices: {
      getUserMedia(constraints) {
        assert.deepEqual(constraints, { audio: true });
        const request = deferred();
        devices.push(request);
        return request.promise;
      },
    },
    MediaRecorder: Recorder,
    File,
    Blob,
    now: () => time,
  });
  return { session, devices, recordings, changes, errors, files, at: value => { time = value; } };
}

async function start(harness, stream = microphone()) {
  const promise = harness.session.start();
  harness.devices.at(-1).resolve(stream);
  assert.equal(await promise, true);
  return stream;
}

test('requests permission directly, avoids duplicate prompts, and reports denied access', async () => {
  const h = setup();
  const first = h.session.start();
  assert.equal(h.session.status, 'requesting');
  assert.equal(await h.session.start(), false);
  assert.equal(h.devices.length, 1);
  h.devices[0].reject({ name: 'NotAllowedError' });
  assert.equal(await first, false);
  assert.deepEqual(h.changes, ['requesting', 'idle']);
  assert.deepEqual(h.errors, ['Microphone access was refused. Allow it in your browser settings to send a voice note.']);
  await start(h);
  assert.equal(h.session.status, 'recording', 'a denied request can be retried');
  h.session.dispose();
});

test('counts only active recording time and waits for final data before producing a file', async () => {
  const h = setup();
  const stream = await start(h);
  const recorder = h.recordings[0];
  assert.equal(h.session.stream, stream);
  assert.equal(recorder.timeslice, 1000);
  h.at(1200);
  recorder.data('first');
  assert.equal(h.session.pause(), true);
  h.at(6200);
  assert.equal(h.session.elapsedMs(), 1200);
  assert.equal(h.session.resume(), true);
  h.at(7000);
  assert.equal(h.session.elapsedMs(), 2000);
  assert.equal(h.session.finish(true), true);
  assert.equal(h.session.finish(false), false, 'a second click cannot change the first send choice');
  h.at(9000);
  assert.equal(h.session.status, 'stopping');
  assert.equal(h.session.elapsedMs(), 2000);
  assert.equal(h.files.length, 0);
  recorder.data('last');
  recorder.stopped();
  recorder.stopped();
  assert.equal(h.files.length, 1);
  assert.equal(await h.files[0].file.text(), 'firstlast');
  assert.equal(h.files[0].file.type, 'audio/webm;codecs=opus');
  assert.match(h.files[0].file.name, /\.webm$/);
  assert.equal(h.files[0].duration, 2000);
  assert.deepEqual(h.files[0].detail, { sendImmediately: true });
  assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(h.session.stream, null);
  assert.deepEqual(h.changes, ['requesting', 'recording', 'paused', 'recording', 'stopping', 'idle']);
});

test('publishes integer milliseconds for fractional browser timing in preview and direct send', async t => {
  for (const sendImmediately of [false, true]) {
    await t.test(sendImmediately ? 'direct send' : 'preview', async () => {
      const h = setup();
      await start(h);
      h.at(6191.5999999996275);
      assert.equal(h.session.elapsedMs(), 6191.5999999996275);
      assert.equal(h.session.finish(sendImmediately), true);
      h.recordings[0].data();
      h.recordings[0].stopped();
      assert.equal(h.files.length, 1);
      assert.equal(h.files[0].duration, 6192);
      assert.deepEqual(h.files[0].detail, { sendImmediately });
      assert.deepEqual(h.errors, []);
    });
  }
});

test('rounds the combined active duration once after fractional pause and resume segments', async () => {
  const h = setup();
  await start(h);
  h.at(1000.4);
  assert.equal(h.session.pause(), true);
  h.at(5000);
  assert.equal(h.session.elapsedMs(), 1000.4);
  assert.equal(h.session.resume(), true);
  h.at(6000.4);
  assert.equal(h.session.pause(), true);
  assert.ok(Math.abs(h.session.elapsedMs() - 2000.8) < 0.000001);
  h.at(9000);
  assert.equal(h.session.finish(), true);
  h.recordings[0].data();
  h.recordings[0].stopped();
  assert.equal(h.files[0].duration, 2001, 'rounding each active segment would incorrectly produce 2000 ms');
  assert.deepEqual(h.files[0].detail, { sendImmediately: false });
});

test('cancelling pending permission releases a late stream without disturbing a newer recording', async () => {
  const h = setup();
  const oldStart = h.session.start();
  h.session.cancel();
  const newStream = await start(h);
  const lateStream = microphone();
  h.devices[0].resolve(lateStream);
  assert.equal(await oldStart, false);
  assert.deepEqual(lateStream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(h.session.stream, newStream);
  assert.equal(h.session.status, 'recording');
  assert.equal(h.recordings.length, 1);
  assert.deepEqual(h.errors, []);
  h.session.dispose();
});

test('disposing while permission is pending suppresses every later callback', async () => {
  const h = setup();
  const pending = h.session.start();
  h.session.dispose();
  const lateStream = microphone();
  h.devices[0].resolve(lateStream);
  assert.equal(await pending, false);
  assert.deepEqual(h.changes, ['requesting']);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.files, []);
  assert.deepEqual(lateStream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(await h.session.start(), false);
});

test('cancelling during finalization never publishes queued audio', async () => {
  const h = setup();
  const stream = await start(h);
  const recorder = h.recordings[0];
  const queuedData = recorder.ondataavailable;
  const queuedStop = recorder.onstop;
  recorder.data();
  h.session.finish(true);
  h.session.cancel();
  queuedData({ data: new Blob(['late audio']) });
  queuedStop();
  assert.deepEqual(h.files, []);
  assert.equal(h.session.status, 'idle');
  assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
});

test('recorder construction and start failures both release all microphone tracks', async t => {
  for (const option of ['constructorError', 'startError']) {
    await t.test(option, async () => {
      const h = setup({ [option]: new Error('browser failure') });
      const stream = microphone();
      const pending = h.session.start();
      h.devices[0].resolve(stream);
      assert.equal(await pending, false);
      assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
      assert.equal(h.errors.length, 1);
      assert.equal(h.session.status, 'idle');
      assert.equal(h.session.stream, null);
    });
  }
});

test('recorder error racing with stop cannot create an attachment or duplicate an error', async () => {
  const h = setup();
  const stream = await start(h);
  const recorder = h.recordings[0];
  const queuedStop = recorder.onstop;
  recorder.data();
  recorder.error();
  queuedStop();
  recorder.error();
  assert.equal(h.errors.length, 1);
  assert.equal(h.files.length, 0);
  assert.equal(recorder.stops, 1);
  assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
});

test('oversized audio stops immediately, while empty recordings produce a retry message', async t => {
  await t.test('oversized', async () => {
    const h = setup({ maxBytes: 6 });
    const stream = await start(h);
    const recorder = h.recordings[0];
    recorder.data('1234');
    recorder.data('5678');
    recorder.stopped();
    assert.match(h.errors[0], /too large/);
    assert.equal(h.files.length, 0);
    assert.equal(h.session.status, 'idle');
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
  });
  await t.test('empty', async () => {
    const h = setup();
    const stream = await start(h);
    h.session.finish();
    h.recordings[0].data('');
    h.recordings[0].stopped();
    assert.match(h.errors[0], /No audio was recorded/);
    assert.equal(h.files.length, 0);
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
  });
});

test('MP4 and AAC recordings use matching file extensions', async t => {
  for (const [supportedType, extension] of [['audio/mp4', 'm4a'], ['audio/aac', 'aac']]) {
    await t.test(supportedType, async () => {
      const h = setup({ supportedType });
      await start(h);
      h.recordings[0].data();
      h.session.finish();
      h.recordings[0].stopped();
      assert.equal(h.files[0].file.type, supportedType);
      assert.ok(h.files[0].file.name.endsWith(`.${extension}`));
      assert.deepEqual(h.files[0].detail, { sendImmediately: false });
    });
  }
});

test('unexpected native stop creates a reviewable note instead of sending automatically', async () => {
  const h = setup();
  await start(h);
  h.at(400);
  h.recordings[0].data();
  h.recordings[0].stopped();
  assert.equal(h.files[0].duration, 400);
  assert.deepEqual(h.files[0].detail, { sendImmediately: false });
  assert.equal(h.session.status, 'idle');
});
