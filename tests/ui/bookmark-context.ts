import type { Page } from '@playwright/test';
export async function bookmarkRootAction(page: Page, action: 'register' | 'create' | 'history') {
  await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});
  await page.locator(`#bookmark-tree-context [data-bookmark-action="${action}"]`).click();
}

export async function sideBookmarkAction(page: Page, side: 'local'|'remote', action: 'add'|'edit'|'delete', id?: string) {
  const bar=page.locator('[data-side-bookmarks='+side+']');
  if(id) await bar.locator('[data-side-open="'+id+'"]').click({button:'right'});
  else await bar.click({button:'right',position:{x:2,y:2}});
  await page.locator('#side-bookmark-context [data-side-action='+action+']').click();
}