const { chromium } = await import(process.env.HR_QA_PLAYWRIGHT || 'playwright');
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const results = []; const external = []; const errors = [];
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith('http://127.0.0.1:5174/')) return route.continue();
  external.push(url); return route.abort();
});
const page = await context.newPage(); page.setDefaultTimeout(6000);
page.on('pageerror', error => errors.push(error.message));
async function step(name, run) {
  try { const evidence = await run(); results.push({ name, status: 'pass', evidence }); }
  catch (error) { results.push({ name, status: 'blocked-or-failed', error: error.message });
    await writeFile(new URL(`browser-step-${results.length}.txt`, import.meta.url), await page.locator('body').innerText()); }
}
try {
  await page.goto('http://127.0.0.1:5174/?qa-chat=1&qa-role=employee#/messages');
  await page.getByRole('button', { name: /Asha Nair/ }).first().click();
  await step('Send synthetic direct message', async () => {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('QA bounded message 2026-09-16');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('region', { name: 'Message history' }).getByText('QA bounded message 2026-09-16', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '');
    return 'Message appears in history and composer clears.';
  });
  await step('Reply to synthetic message', async () => {
    const options = page.getByRole('button', { name: 'Message options', exact: true }).last();
    await options.click({ force: true });
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('QA bounded reply');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('region', { name: 'Message history' }).getByText('QA bounded reply', { exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Go to replied message' }).count());
    return 'Reply body and quote navigation appear.';
  });
  await step('Search conversation messages', async () => {
    await page.getByRole('button', { name: 'Search messages', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search this conversation' }).fill('QA bounded message');
    await page.getByRole('complementary', { name: 'Search in conversation' }).getByText('QA bounded message 2026-09-16', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close message search' }).click();
    return 'Search finds the newly sent synthetic message.';
  });
  await step('Unpin and repin chat preference', async () => {
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Unpin chat', exact: true }).click();
    await page.waitForFunction(async () => (await import('/qa/fixtures.js')).tables.chat_preferences.find(row => row.conversation_id === 'qa-chat-asha')?.is_pinned === false);
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pin chat', exact: true }).click();
    await page.waitForFunction(async () => (await import('/qa/fixtures.js')).tables.chat_preferences.find(row => row.conversation_id === 'qa-chat-asha')?.is_pinned === true);
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Unpin chat', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    return 'Menu action toggles Unpin → Pin → Unpin, showing saved fixture preference.';
  });
  await page.screenshot({ path: fileURLToPath(new URL('chat-local-browser.png', import.meta.url)), fullPage: true });
  await page.goto('http://127.0.0.1:5174/?qa-developer=1&qa-role=super_admin#/admin-developer');
  await step('Create unusable synthetic developer key with API disabled', async () => {
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    await page.getByRole('textbox', { name: 'Key name' }).fill('QA bounded test key');
    await page.getByRole('button', { name: 'Create API key', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your new API key' }).waitFor();
    assert.match(await page.getByRole('textbox', { name: 'Your new API key' }).inputValue(), /^qa_nonfunctional_/);
    await page.getByRole('button', { name: /Done, hide key/ }).click();
    return 'One-time fixture key has qa_nonfunctional_ prefix, then hides.';
  });
  await step('Revoke synthetic developer key', async () => {
    const row = page.locator('article').filter({ has: page.getByText('QA bounded test key', { exact: true }) });
    await row.getByRole('button', { name: 'Revoke key QA bounded test key', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await row.getByText('Revoked', { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: 'Revoke key QA bounded test key', exact: true }).count(), 0);
    return 'Key row becomes Revoked and its revoke action disappears.';
  });
  await page.screenshot({ path: fileURLToPath(new URL('developer-local-browser.png', import.meta.url)), fullPage: true });
} finally {
  await writeFile(new URL('local-chat-developer-results.json', import.meta.url), JSON.stringify({
    mode: 'Headless Chrome; fresh context; local QA memory fixtures only; external HTTP blocked',
    results, pageErrors: errors, blockedExternalRequests: external,
  }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2)); await browser.close();
}
