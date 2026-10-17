import type { Page } from '@playwright/test';
export async function bookmarkRootAction(page: Page, action: 'register' | 'create' | 'history') {
  await page.locator('#bookmark-more').click();
  await page.locator(`#bookmark-tree-context [data-bookmark-action="${action}"]`).click();
}
