import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_IDENTITIES, PRODUCT_NAME } from './appName.js';
import { watchPwaIdentity } from './pwaIdentity.js';

class FakeWindow extends EventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    super.addEventListener(type, listener);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    super.removeEventListener(type, listener);
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakeDocument(onManifestHref = () => {}) {
  const children = [];
  return {
    title: PRODUCT_NAME,
    head: { appendChild(node) { children.push(node); return node; } },
    createElement(tagName) {
      const attributes = new Map();
      return {
        tagName,
        setAttribute(name, value) {
          attributes.set(name, value);
          if (tagName === 'link' && name === 'href') onManifestHref(value);
        },
        getAttribute(name) { return attributes.get(name) ?? null; },
        remove() {
          const index = children.indexOf(this);
          if (index !== -1) children.splice(index, 1);
        },
      };
    },
    querySelector(selector) {
      const [, tagName, attribute, value] = selector.match(/^(\w+)\[(\w+)="([^"]+)"\]$/);
      return children.find(node => node.tagName === tagName && node.getAttribute(attribute) === value) ?? null;
    },
    children,
  };
}

function addElement(document, tag, attributes) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  document.head.appendChild(element);
  return element;
}

function assertIdentity(document, identity) {
  assert.equal(document.querySelector('link[rel="manifest"]')?.getAttribute('href'), identity.manifestHref);
  assert.equal(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'), identity.name);
  assert.equal(document.querySelector('meta[name="application-name"]')?.getAttribute('content'), identity.name);
  assert.equal(document.title, identity.name);
}

test('each role applies its manifest and names, reusing existing head elements', () => {
  for (const identity of Object.values(APP_IDENTITIES)) {
    const document = fakeDocument();
    const window = new FakeWindow();
    const manifest = addElement(document, 'link', { rel: 'manifest', href: APP_IDENTITIES.default.manifestHref });
    addElement(document, 'meta', { name: 'apple-mobile-web-app-title', content: PRODUCT_NAME });
    addElement(document, 'meta', { name: 'application-name', content: PRODUCT_NAME });
    const stop = watchPwaIdentity({ identity, document, window, onPrompt() {}, onInstalled() {} });
    assertIdentity(document, identity);
    assert.equal(document.querySelector('link[rel="manifest"]'), manifest);
    assert.equal(document.children.length, 3, 'Switching names must not duplicate manifest or metadata elements');
    stop();
  }
});

test('install listeners are active before the manifest href can produce an immediate prompt', () => {
  const window = new FakeWindow();
  const prompts = [];
  let fastPrompt;
  const document = fakeDocument(href => {
    assert.equal(href, APP_IDENTITIES.employee.manifestHref);
    assert.equal(window.listenerCount('beforeinstallprompt'), 1);
    assert.equal(window.listenerCount('appinstalled'), 1);
    assert.deepEqual(prompts, [null], 'A previous deferred prompt must be cleared before loading the manifest');
    fastPrompt = new Event('beforeinstallprompt', { cancelable: true });
    window.dispatchEvent(fastPrompt);
  });
  const stop = watchPwaIdentity({
    identity: APP_IDENTITIES.employee, document, window,
    onPrompt: prompt => prompts.push(prompt), onInstalled() {},
  });
  assert.deepEqual(prompts, [null, fastPrompt]);
  assert.equal(fastPrompt.defaultPrevented, true);
  assertIdentity(document, APP_IDENTITIES.employee);
  stop();
});

test('changing roles clears the old prompt and disconnects all old event listeners', () => {
  const document = fakeDocument();
  const window = new FakeWindow();
  const employeePrompts = [], adminPrompts = [];
  let employeeInstalls = 0, adminInstalls = 0;
  const stopEmployee = watchPwaIdentity({
    identity: APP_IDENTITIES.employee, document, window,
    onPrompt: prompt => employeePrompts.push(prompt), onInstalled: () => employeeInstalls++,
  });
  const employeePrompt = new Event('beforeinstallprompt', { cancelable: true });
  window.dispatchEvent(employeePrompt);
  stopEmployee();
  assert.deepEqual(employeePrompts, [null, employeePrompt, null]);
  assert.equal(window.listenerCount('beforeinstallprompt'), 0);
  assert.equal(window.listenerCount('appinstalled'), 0);

  const stopAdmin = watchPwaIdentity({
    identity: APP_IDENTITIES.admin, document, window,
    onPrompt: prompt => adminPrompts.push(prompt), onInstalled: () => adminInstalls++,
  });
  const adminPrompt = new Event('beforeinstallprompt', { cancelable: true });
  window.dispatchEvent(adminPrompt);
  assertIdentity(document, APP_IDENTITIES.admin);
  assert.deepEqual(adminPrompts, [null, adminPrompt]);
  assert.deepEqual(employeePrompts, [null, employeePrompt, null]);
  assert.equal(window.listenerCount('beforeinstallprompt'), 1);
  assert.equal(window.listenerCount('appinstalled'), 1);

  window.dispatchEvent(new Event('appinstalled'));
  assert.deepEqual(adminPrompts, [null, adminPrompt, null]);
  assert.equal(adminInstalls, 1);
  assert.equal(employeeInstalls, 0);
  stopAdmin();
});

test('logout removes install metadata for the account and ignores subsequent browser events', () => {
  const document = fakeDocument();
  const window = new FakeWindow();
  const prompts = [];
  let installs = 0;
  const stop = watchPwaIdentity({
    identity: APP_IDENTITIES.manager, document, window,
    onPrompt: prompt => prompts.push(prompt), onInstalled: () => installs++,
  });
  const prompt = new Event('beforeinstallprompt', { cancelable: true });
  window.dispatchEvent(prompt);
  stop();

  assert.equal(document.querySelector('link[rel="manifest"]'), null);
  assert.equal(document.querySelector('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), PRODUCT_NAME);
  assert.equal(document.querySelector('meta[name="application-name"]').getAttribute('content'), PRODUCT_NAME);
  assert.equal(document.title, PRODUCT_NAME);
  assert.deepEqual(prompts, [null, prompt, null]);
  const latePrompt = new Event('beforeinstallprompt', { cancelable: true });
  window.dispatchEvent(latePrompt);
  window.dispatchEvent(new Event('appinstalled'));
  assert.equal(latePrompt.defaultPrevented, false);
  assert.deepEqual(prompts, [null, prompt, null], 'Logged-out listeners must never repopulate a deferred prompt');
  assert.equal(installs, 0);
});
