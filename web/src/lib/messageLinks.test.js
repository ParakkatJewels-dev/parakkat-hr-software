import test from 'node:test';
import assert from 'node:assert/strict';
import { messageLinkParts } from './messageLinks.js';

test('plain task messages remain plain text', () => {
  assert.deepEqual(messageLinkParts('Please check the front desk'), [
    { type: 'text', text: 'Please check the front desk' },
  ]);
});

test('http, https and www addresses become links', () => {
  assert.deepEqual(messageLinkParts('See https://example.com/a and www.example.org'), [
    { type: 'text', text: 'See ' },
    { type: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
    { type: 'text', text: ' and ' },
    { type: 'link', text: 'www.example.org', href: 'https://www.example.org' },
  ]);
});

test('sentence punctuation stays outside the link', () => {
  assert.deepEqual(messageLinkParts('Open https://example.com/path, then reply.'), [
    { type: 'text', text: 'Open ' },
    { type: 'link', text: 'https://example.com/path', href: 'https://example.com/path' },
    { type: 'text', text: ', then reply.' },
  ]);
});

test('a balanced closing bracket may be part of the URL', () => {
  assert.deepEqual(messageLinkParts('Read https://example.com/a_(b).'), [
    { type: 'text', text: 'Read ' },
    { type: 'link', text: 'https://example.com/a_(b)', href: 'https://example.com/a_(b)' },
    { type: 'text', text: '.' },
  ]);
});

test('executable and non-web schemes never become links', () => {
  assert.deepEqual(messageLinkParts('javascript:alert(1) mailto:a@www.example.com'), [
    { type: 'text', text: 'javascript:alert(1) mailto:a@www.example.com' },
  ]);
});
