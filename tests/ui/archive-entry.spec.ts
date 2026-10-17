import { test, expect } from "@playwright/test";
async function setup(page, language = "en") {
  await page.addInitScript(
    ({ language }) => {
      window.calls = [];
      window.pendingPrepare = false;
      window.created = { local: [], remote: [] };
      const profile = {
        id: "create",
        name: "設定",
        host: "fixture.invalid",
        port: 22,
        user: "設定",
        auth: "key",
        mode: "sftp",
        hostKey: "pin",
      };
      const entries = [{name:"ARCHIVE.ZIP",dir:false,size:10},
        { name: "existing-folder", dir: true, size: 0 },
        { name: "keep.txt", dir: false, size: 4 },
      ];
      window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            window.calls.push({ cmd, args });
            if (cmd === "load_settings")
              return {
                version: 1,
                settingsRevision: 1,
                profiles: [profile],
                history: {},
                theme: "light",
                language,
              };
            if (cmd === "save_settings")
              return (args.data.settingsRevision || 1) + 1;
            if (cmd === "default_folder") return "C:\\fixture";
            if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
            if (cmd === "connect_session") return { path: "/", entries };
            if (cmd === "list_local" || cmd === "list_remote")
              return [
                ...entries,
                ...window.created[cmd === "list_local" ? "local" : "remote"],
              ];
            if (cmd === "prepare_file_operation") {
              if (window.pendingPrepare)
                await new Promise((r) => (window.releasePrepare = r));
              return;
            }
            if(cmd === "run_local_archive") { if(window.archiveError)throw window.archiveError;const r=args.request;window.created.local.push({name:r.destination.split(/[\\/]/).pop(),dir:r.action === "extract",size:10});return{finalPath:r.destination,action:r.action,entries:2,bytes:11}; }
          if (cmd === "run_file_operation") {
              const r = args.request;
              window.created[r.side].push({
                name: r.destination.split(/[\\/]/).pop(),
                dir: r.action === "mkdir",
                size: 0,
              });
              return { completed: 1, message: "created" };
            }
          },
        },
      };
    },
    { language },
  );
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-pane=local]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function create(page, side, action, name, row) {
  const list = page.locator(`[data-list=${side}]`);
  await (row ? list.locator(`[data-name="${row}"]`) : list).click({
    button: "right",
    position: row ? undefined : { x: 20, y: 150 },
  });
  if (await page.locator("html").getAttribute("lang") === "en") await expect(page.locator(".file-menu")).not.toContainText(/[\u3040-\u30ff\u3400-\u9fff]/);
  await page.locator(`[data-file-action=${action}]`).click();
  await page.locator("[name=create-name]").fill(name);
}
const operations = (page) =>
  page.evaluate(() =>
    window.calls
      .filter((c) => c.cmd === "run_file_operation")
      .map((c) => c.args.request),
  );
const archives=page=>page.evaluate(()=>window.calls.filter(c=>c.cmd==='run_local_archive').map(c=>c.args.request));
async function openArchive(page,side,name,action){await page.locator(`[data-list=${side}] [data-name="${name}"]`).click({button:'right'});await page.locator(`[data-file-action=${action}]`).click();if(await page.locator('html').getAttribute('lang')==='en')await expect(page.locator('.archive-dialog')).not.toContainText(/[\u3040-\u30ff\u3400-\u9fff]/);}
test('single local file compress uses sibling output and selects only confirmed final entry',async({page})=>{await setup(page);await openArchive(page,'local','keep.txt','compress');await expect(page.locator('[name=archive-name]')).toHaveValue('keep.txt.zip');await expect(page.locator('.archive-dialog .target code').last()).toHaveText('C:\\fixture');await page.locator('#archive-confirm').click();await expect(page.locator('.operation-results')).toContainText('ZIP operation completed.');expect((await archives(page))[0]).toMatchObject({action:'compress',side:'local',source:'C:\\fixture\\keep.txt',destination:'C:\\fixture\\keep.txt.zip'});await page.locator('#archive-cancel').click();await expect(page.locator('[data-list=local] [data-name="keep.txt.zip"]')).toHaveAttribute('aria-selected','true');});
test('extract only nondirectory ZIP local leaf; upper-case extension keeps opaque name',async({page})=>{await setup(page);await openArchive(page,'local','ARCHIVE.ZIP','extract');await expect(page.locator('[name=archive-name]')).toHaveValue('ARCHIVE');await page.locator('#archive-confirm').click();await expect(page.locator('.operation-results')).toContainText('ZIP operation completed.');expect((await archives(page))[0]).toMatchObject({action:'extract',destination:'C:\\fixture\\ARCHIVE'});await page.locator('#archive-cancel').click();await page.locator('[data-list=remote] [data-name="ARCHIVE.ZIP"]').click({button:'right'});await expect(page.locator('[data-file-action=compress]')).toHaveCount(0);await expect(page.locator('[data-file-action=extract]')).toHaveCount(0);await page.keyboard.press('Escape');await page.locator('[data-list=local] [data-name="existing-folder"]').click({button:'right'});await expect(page.locator('[data-file-action=extract]')).toHaveCount(0);});
test('retained stage error is plain opaque data, no retry or false selection',async({page})=>{await setup(page);await page.evaluate(()=>window.archiveError={code:'publish_refused',stagePath:'C:\\設定\\<stage>',committed:false});await openArchive(page,'local','keep.txt','compress');await page.locator('#archive-confirm').click();await expect(page.locator('.operation-results')).toContainText('C:\\設定\\<stage>');await expect(page.locator('.operation-results stage')).toHaveCount(0);expect(await archives(page)).toHaveLength(1);await expect(page.locator('#archive-confirm')).toBeDisabled();await page.locator('#archive-cancel').click();await expect(page.locator('[data-list=local] [data-name="keep.txt"]')).toHaveAttribute('aria-selected','true');});
test('ZIP naming validates suffix and IME Enter waits for committed text',async({page})=>{await setup(page,'ja');await openArchive(page,'local','keep.txt','compress');const field=page.locator('[name=archive-name]');await field.fill('no-suffix');await page.locator('#archive-confirm').click();expect(await archives(page)).toEqual([]);await expect(page.locator('.operation-results')).toContainText('.zip');await field.fill('設定.zip');await field.dispatchEvent('compositionstart');await field.press('Enter');expect(await archives(page)).toEqual([]);await field.dispatchEvent('compositionend');await field.press('Enter');await expect(page.locator('.operation-results')).toContainText('ZIP処理が完了しました。');expect((await archives(page))[0].destination).toBe('C:\\fixture\\設定.zip');});
