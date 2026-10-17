import { test, expect, type Page } from '@playwright/test';

type Report = { state: string; latestVersion?: string; canInstall?: boolean; downloadedBytes?: number; totalBytes?: number };
async function fixture(page: Page, initial: Report, language = 'en', responses: Record<string, Report[]> = {}) {
  await page.route('**/startup-update-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="font:13px/1.5 Segoe UI,sans-serif"><button id="prior">Previous focus</button></body></html>' }));
  await page.goto('/startup-update-fixture');
  await page.evaluate(async ({ initial, language, responses }) => {
    const fixture = { calls: [] as { command: string; args: unknown }[], statuses: responses, initial };
    (window as any).updateFixture = fixture;
    (window as any).__TAURI__ = { core: { invoke: async (command: string, args: unknown) => {
      fixture.calls.push({ command, args });
      if (command === 'check_startup_update' && (fixture.initial as any)?.reject) throw Error('fixture startup unavailable');
      const queue = fixture.statuses[command];
      if (queue?.length) return queue.length > 1 ? queue.shift() : queue[0];
      return command === 'check_startup_update' ? fixture.initial : { state: 'cancelled', canInstall: false };
    } } };
    const i18n = await import('/src/i18n.ts'); i18n.setLanguage(language); document.documentElement.lang = language;
    document.querySelector<HTMLButtonElement>('#prior')!.focus();
    const update = await import('/src/startup-update.ts');
    (window as any).updateModule = update;
    await update.initializeStartupUpdate();
  }, { initial, language, responses });
}
const dialog = (page: Page) => page.locator('#startup-update-dialog');

test('no key is localized, visibly disabled, and never prepares an update', async ({ page }) => {
  await fixture(page, { state: 'signingNotConfigured', latestVersion: '1.2.3', canInstall: false }, 'ja');
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '今すぐ更新' })).toBeDisabled();
  await expect(dialog(page)).toContainText('署名検証キー');
  await page.evaluate(async () => { const i18n = await import('/src/i18n.ts'); i18n.setLanguage('en'); document.documentElement.lang = 'en'; });
  await expect(dialog(page)).toContainText('trusted update signing key');
  await page.screenshot({ path: 'test-results/startup-update/signing-not-configured.png' });
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.map((c: any) => c.command))).toEqual(['check_startup_update', 'dismiss_startup_update']);
});

test('trusted fixture downloads, polls progress, verifies, then installs once with no parameters', async ({ page }) => {
  await fixture(page, { state: 'available', latestVersion: '<img src=x onerror=alert(1)>日本語', canInstall: false }, 'en', {
    prepare_startup_update: [{ state: 'downloading', downloadedBytes: 2, totalBytes: 10 }],
    startup_update_status: [{ state: 'downloading', downloadedBytes: 7, totalBytes: 10 }, { state: 'ready', canInstall: true }],
    install_startup_update: [{ state: 'installing' }],
  });
  await expect(dialog(page)).toContainText('<img src=x onerror=alert(1)>日本語');
  await expect(dialog(page).locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(dialog(page).locator('progress')).toHaveAttribute('value', '2');
  await expect(dialog(page).locator('progress')).toHaveAttribute('value', '7');
  await expect(dialog(page)).toContainText('Starting the installer');
  await page.screenshot({ path: 'test-results/startup-update/verified-installing.png' });
  expect(await page.evaluate(() => (window as any).updateFixture.calls.filter((c: any) => c.command === 'install_startup_update').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.every((c: any) => c.args === undefined))).toBe(true);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.filter((c: any) => c.command === 'install_startup_update').length)).toBe(1);
});

test('cancel, retry, and failure show owned text; disposal stops polling', async ({ page }) => {
  await fixture(page, { state: 'available', latestVersion: '1.2.3' }, 'en', {
    prepare_startup_update: [{ state: 'downloading' }, { state: 'error', error: '<script>native detail</script>' } as Report],
    startup_update_status: [{ state: 'downloading' }],
  });
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(dialog(page).locator('progress')).not.toHaveAttribute('value');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toContainText('cancelled');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog(page)).toContainText('could not be completed');
  await expect(dialog(page)).not.toContainText('native detail');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.evaluate(() => (window as any).updateModule.disposeStartupUpdate());
  const before = await page.evaluate(() => (window as any).updateFixture.calls.length);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.length)).toBe(before);
  await expect(dialog(page)).toHaveCount(0);
});

test('Later is session-only and repeated initialization does not check again', async ({ page }) => {
  await fixture(page, { state: 'available', latestVersion: '1.2.3' });
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#prior')).toBeFocused();
  await page.evaluate(() => (window as any).updateModule.initializeStartupUpdate());
  expect(await page.evaluate(() => (window as any).updateFixture.calls.map((c: any) => c.command))).toEqual(['check_startup_update', 'dismiss_startup_update']);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(storage);
});

test('native election suppresses other windows and silent startup outcomes', async ({ page }) => {
  await fixture(page, { state: 'notOwner' });
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.length)).toBe(1);
});

test('ready without native permission cannot install', async ({ page }) => {
  await fixture(page, { state: 'ready', canInstall: false });
  await page.screenshot({ path: 'test-results/startup-update/verified-ready.png' });
  await expect(page.getByRole('button', { name: 'Install and close', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).updateFixture.calls.length)).toBe(1);
});


test('settling keeps polling; busy waits for an explicit retry', async ({ page }) => {
  await fixture(page, { state: 'settling' }, 'en', { startup_update_status: [{ state: 'busy' }], prepare_startup_update: [{ state: 'downloading' }] });
  await expect(dialog(page)).toContainText('finish');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  const before = await page.evaluate(() => (window as any).updateFixture.calls.length);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.length)).toBe(before);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog(page)).toContainText('Downloading');
});

test('known native verification errors explain failure without exposing arbitrary details', async ({ page }) => {
  await fixture(page, { state: 'error', errorCode: 'invalidSignature', error: '<b>untrusted</b>' } as Report, 'ja');
  await expect(dialog(page)).toContainText('検証に失敗');
  await expect(dialog(page)).not.toContainText('untrusted');
  await expect(page.getByRole('button', { name: '再試行', exact: true })).toBeEnabled();
});

test('missing or malformed startup responses fail closed without an unhandled page error', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  for (const response of [undefined, null, {}, { state: 7 }, { state: 'unexpected' }, { state: 'available', latestVersion: {} }, { state: 'ready', canInstall: 'true' }]) {
    await fixture(page, response as unknown as Report);
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).updateFixture.calls.length)).toBe(1);
  }
  expect(errors).toEqual([]);
});



test('rejected startup checks remain silent and do not block the app', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  await fixture(page, { reject: true } as unknown as Report);
  await expect(dialog(page)).toHaveCount(0);
  await page.locator('#prior').click();
  expect(errors).toEqual([]);
});

test('download consent does not install when native readiness is disabled', async ({ page }) => {
  await fixture(page, { state: 'available' }, 'en', { prepare_startup_update: [{ state: 'downloading' }], startup_update_status: [{ state: 'ready', canInstall: false }] });
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install and close', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).updateFixture.calls.filter((c: any) => c.command === 'install_startup_update').length)).toBe(0);
});

test('release gate and recovery failures have localized owned guidance', async ({ page }) => {
  for (const [errorCode, expected] of [['installationNotValidated', '実機検証'], ['workInProgress', 'ファイル操作'], ['installerLaunchFailed', '開いたまま'], ['settingsRollbackFailed', '復元できません']]) {
    await fixture(page, { state: 'error', errorCode } as Report, 'ja');
    await expect(dialog(page)).toContainText(expected);
  }
});

