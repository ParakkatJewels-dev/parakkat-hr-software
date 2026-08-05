import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isIosDevice, installOffer, installPromptHidden, hideInstallPrompt, INSTALL_SNOOZE_DAYS,
} from './pwa.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_OS13 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'; // iPadOS lies
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120';

test('an iPhone is iOS', () => {
  assert.equal(isIosDevice(IPHONE, 5), true);
});

test('an iPad on iPadOS 13+ claims to be a Mac and is caught by the touchscreen', () => {
  assert.equal(isIosDevice(IPAD_OS13, 5), true);
});

test('a real Mac is not iOS, however similar the user agent looks', () => {
  assert.equal(isIosDevice(MAC, 0), false);
});

test('Android is not iOS', () => {
  assert.equal(isIosDevice(ANDROID, 5), false);
});

test('an installed app is never asked to install again', () => {
  assert.equal(installOffer({ standalone: true, deferredPrompt: {}, ios: true }), 'none');
  assert.equal(installOffer({ standalone: true, deferredPrompt: null, ios: false }), 'none');
});

test('a held prompt wins — it is the only path that opens a real install dialog', () => {
  assert.equal(installOffer({ standalone: false, deferredPrompt: {}, ios: false }), 'prompt');
  assert.equal(installOffer({ standalone: false, deferredPrompt: {}, ios: true }), 'prompt');
});

test('iOS with no prompt falls back to instructions, because it has no install API', () => {
  assert.equal(installOffer({ standalone: false, deferredPrompt: null, ios: true }), 'ios-manual');
});

test('a desktop browser with no prompt is offered nothing rather than an empty banner', () => {
  assert.equal(installOffer({ standalone: false, deferredPrompt: null, ios: false }), 'none');
});

function fakeStore() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

test('dismissing hides it for the snooze window, then it returns', () => {
  const store = fakeStore();
  const now = 1_000_000;
  assert.equal(installPromptHidden(store, now), false);
  hideInstallPrompt(store, now);
  assert.equal(installPromptHidden(store, now + 1000), true);
  assert.equal(installPromptHidden(store, now + INSTALL_SNOOZE_DAYS * 86400000 - 1), true);
  assert.equal(installPromptHidden(store, now + INSTALL_SNOOZE_DAYS * 86400000 + 1), false);
});

test('a storage that throws does not take the app with it', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(installPromptHidden(broken, 1), false);
  assert.doesNotThrow(() => hideInstallPrompt(broken, 1));
});
