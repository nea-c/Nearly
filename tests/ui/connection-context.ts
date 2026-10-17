import type { Page } from '@playwright/test';

export async function editSelectedProfile(page: Page) {
  await page.locator('#edit-profile').click();
}
export async function addRootProfile(page: Page) {
  const tree = page.locator('#connection-tree'), box = await tree.boundingBox();
  await tree.click({ button: 'right', position: { x: 8, y: box!.height - 8 } });
  await page.locator('[data-menu-action=add-profile]').click();
}
