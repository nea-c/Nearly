import { expect, type Page } from '@playwright/test';

/** Explicit user expansion: production navigation never opens branches for tests. */
export async function expandTreePath(page: Page, side: string, path: string) {
  const paths = path === '@pc' ? ['@pc'] : side === 'local'
    ? ['@pc', ...path.replaceAll('/', '\\').split('\\').filter(Boolean).map((_, i, parts) => parts.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : ''))]
    : ['/', ...path.split('/').filter(Boolean).map((_, i, parts) => '/' + parts.slice(0, i + 1).join('/'))];
  for (const target of paths) {
    const toggle = page.locator(`[data-tree-toggle=${side}][data-tree-path=${JSON.stringify(target)}]`);
    await expect(toggle).toBeAttached();
    if (await toggle.locator('xpath=../..').getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(toggle.locator('xpath=../..')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeEnabled();
  }
}
