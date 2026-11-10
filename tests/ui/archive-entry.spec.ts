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
            if (cmd === "file_operation_progress") return window.archiveProgress;
            if (cmd === "prepare_file_operation") {
              if (window.pendingPrepare)
                await new Promise((r) => (window.releasePrepare = r));
              return;
            }
            if(cmd === "run_local_archive" || cmd === "run_remote_archive") { if(window.pendingArchive)await new Promise(r=>window.releaseArchive=r);if(window.archiveError)throw window.archiveError;const r=args.request;window.created[cmd === "run_local_archive" ? "local" : "remote"].push({name:r.destination.split(/[\\/]/).pop(),dir:r.action === "extract",size:10});return{finalPath:r.destination,action:r.action,entries:2,bytes:11}; }
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
test('extract only nondirectory ZIP local leaf; upper-case extension keeps opaque name',async({page})=>{await setup(page);await openArchive(page,'local','ARCHIVE.ZIP','extract');await expect(page.locator('[name=archive-name]')).toHaveValue('ARCHIVE');await page.locator('#archive-confirm').click();await expect(page.locator('.operation-results')).toContainText('ZIP operation completed.');expect((await archives(page))[0]).toMatchObject({action:'extract',destination:'C:\\fixture\\ARCHIVE'});await page.locator('#archive-cancel').click();await page.locator('[data-list=remote] [data-name="ARCHIVE.ZIP"]').click({button:'right'});await expect(page.locator('[data-file-action=compress]')).toHaveCount(1);await expect(page.locator('[data-file-action=extract]')).toHaveCount(1);await page.keyboard.press('Escape');await page.locator('[data-list=local] [data-name="existing-folder"]').click({button:'right'});await expect(page.locator('[data-file-action=extract]')).toHaveCount(0);});
test('retained stage error is plain opaque data, no retry or false selection',async({page})=>{await setup(page);await page.evaluate(()=>window.archiveError={code:'publish_refused',stagePath:'C:\\設定\\<stage>',committed:false});await openArchive(page,'local','keep.txt','compress');await page.locator('#archive-confirm').click();await expect(page.locator('.operation-results')).toContainText('C:\\設定\\<stage>');await expect(page.locator('.operation-results stage')).toHaveCount(0);expect(await archives(page)).toHaveLength(1);await expect(page.locator('#archive-confirm')).toHaveCount(0);await page.locator('#archive-cancel').click();await expect(page.locator('[data-list=local] [data-name="keep.txt"]')).toHaveAttribute('aria-selected','true');});
test('ZIP naming validates suffix and IME Enter waits for committed text',async({page})=>{await setup(page,'ja');await openArchive(page,'local','keep.txt','compress');const field=page.locator('[name=archive-name]');await field.fill('no-suffix');await page.locator('#archive-confirm').click();expect(await archives(page)).toEqual([]);await expect(page.locator('.operation-results')).toContainText('.zip');await field.fill('設定.zip');await field.dispatchEvent('compositionstart');await field.press('Enter');expect(await archives(page)).toEqual([]);await field.dispatchEvent('compositionend');await field.press('Enter');await expect(page.locator('.operation-results')).toContainText('ZIP処理が完了しました。');expect((await archives(page))[0].destination).toBe('C:\\fixture\\設定.zip');});

const remoteArchives = page => page.evaluate(() => window.calls.filter(c => c.cmd === 'run_remote_archive').map(c => c.args.request));
test('remote ZIP discloses execution and dispatches session-only POSIX paths, refreshing output', async ({page}) => {
  await setup(page);
  await openArchive(page, 'remote', 'ARCHIVE.ZIP', 'extract');
  await expect(page.locator('.archive-dialog')).toContainText('SSH commands');
  await expect(page.locator('.archive-dialog')).toContainText('Linux and Python 3');
  await expect(page.locator('.archive-dialog')).toContainText('Windows is currently unsupported');
  await expect(page.locator('.archive-dialog .target code').last()).toHaveText('/');
  expect(await remoteArchives(page)).toEqual([]);
  await page.locator('#archive-confirm').click();
  await expect(page.locator('.operation-results')).toContainText('ZIP operation completed.');
  const [request] = await remoteArchives(page);
  expect(request).toMatchObject({ action:'extract', sources:['/ARCHIVE.ZIP'], destination:'/ARCHIVE' });
  expect(request.sessionId).toEqual(expect.any(String));
  expect(Object.keys(request).sort()).toEqual(['action','destination','id','sessionId','sources']);
  await expect(page.locator('[data-list=remote] [data-name="ARCHIVE"]')).toHaveAttribute('aria-selected','true');
  expect(await archives(page)).toEqual([]);
});
test('remote refusal and uncertain output remain readable and never retry automatically', async ({page}) => {
  await setup(page);
  for (const [code, phrase] of [['remote_exec_unavailable','SSH command execution is unavailable'], ['remote_platform_unsupported','support Linux only'], ['remote_tool_unavailable','require Python 3'], ['remote_path_mismatch','paths do not match'], ['remote_outcome_unknown','Output may have been created']]) {
    await page.evaluate(code => window.archiveError = {code, committed:false, stagePath:'/srv/<stage>&"'}, code);
    await openArchive(page,'remote','keep.txt','compress');
    await page.locator('#archive-confirm').click();
    await expect(page.locator('.operation-results')).toContainText(phrase);
    await expect(page.locator('.operation-results')).toContainText('/srv/<stage>&"');
    await expect(page.locator('.operation-results stage')).toHaveCount(0);
    await expect(page.locator('#archive-confirm')).toHaveCount(0);
    await page.locator('#archive-cancel').click();
  }
  expect(await remoteArchives(page)).toHaveLength(5);
});
test('remote preparation cancellation prevents dispatch and duplicate Run', async ({page}) => {
  await setup(page);
  await page.evaluate(()=>window.pendingPrepare=true);
  await openArchive(page,'remote','keep.txt','compress');
  await page.locator('#archive-confirm').evaluate(button=>{button.click();button.click();});
  await page.locator('#archive-cancel').click();
  await page.evaluate(()=>window.releasePrepare());
  await expect(page.locator('.operation-results')).toContainText('cancel');
  expect(await remoteArchives(page)).toEqual([]);
  expect(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='prepare_file_operation'))).toHaveLength(1);
  await page.locator('#archive-cancel').click();
  await page.evaluate(()=>window.pendingPrepare=false);
  await openArchive(page,'remote','keep.txt','compress');
  await page.locator('#archive-confirm').click();
  await expect(page.locator('.operation-results')).toContainText('ZIP operation completed.');
  expect(await remoteArchives(page)).toHaveLength(1);
});
test('remote cancellation after dispatch preserves unknown outcome warning', async ({page}) => {
  await setup(page);
  await page.evaluate(()=>{window.pendingArchive=true;window.archiveError={code:'remote_outcome_unknown',committed:false};});
  await openArchive(page,'remote','keep.txt','compress');
  await page.locator('#archive-confirm').click();
  await expect.poll(()=>remoteArchives(page)).toHaveLength(1);
  await page.locator('#archive-cancel').evaluate(button=>{button.click();button.click();});
  expect(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='cancel_file_operation'))).toHaveLength(1);
  await page.evaluate(()=>window.releaseArchive());
  await expect(page.locator('.operation-results')).toContainText('Output may have been created');
  await expect(page.locator('.operation-results')).not.toContainText('was cancelled');
});

async function bindArchiveHost(page, options = {}) {
  await page.evaluate(async options => {
    const { bindFileActions } = await import('/src/file-actions.ts');
    const { FileSelection } = await import('/src/selection.ts');
    const selection = new FileSelection(); selection.context('archive-test', ['ARCHIVE.ZIP','keep.txt']);
    const pane = {path:'/',entries:[{name:'ARCHIVE.ZIP',dir:false,size:10},{name:'keep.txt',dir:false,size:4}],selection,loading:false};
    window.archiveHostValid = true;
    window.archiveChanges = [];
    const host = {
      workspaceId:'archive-test', sessionId:'archive-session',
      panes:{local:{...pane,path:'C:\\fixture'},remote:{...pane}},syncRoots:[],
      selected(){},valid:()=>window.archiveHostValid,operationValid:()=>window.archiveHostValid,
      async changed(side, passphrase, change){window.archiveChanges.push({side,passphrase,change});},
    };
    if (options.disconnected) host.sessionId = undefined;
    if (options.loading) host.panes.remote.loading = true;
    if (options.path) host.panes.remote.path = options.path;
    window.archiveHost = host;
    bindFileActions(host);
  }, options);
}
test('disconnected and loading remote panes cannot open archive actions', async ({page}) => {
  await setup(page);
  await bindArchiveHost(page,{disconnected:true});
  await page.locator('[data-list=remote] [data-name="ARCHIVE.ZIP"]').click({button:'right'});
  await expect(page.locator('[data-file-action=compress]')).toHaveCount(0);
  await expect(page.locator('[data-file-action=extract]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await bindArchiveHost(page,{loading:true});
  await page.locator('[data-list=remote] [data-name="ARCHIVE.ZIP"]').click({button:'right'});
  await expect(page.locator('.file-menu')).toHaveCount(0);
  expect(await remoteArchives(page)).toEqual([]);
});
test('remote stale navigation or session during prepare abandons without dispatch', async ({page}) => {
  await setup(page);
  for (const change of ['navigation','session']) {
    await bindArchiveHost(page);
    await page.evaluate(()=>window.pendingPrepare=true);
    await openArchive(page,'remote','keep.txt','compress');
    await page.locator('#archive-confirm').click();
    await page.evaluate(change=>{
      if(change==='navigation')window.archiveHostValid=false;
      else window.archiveHost.sessionId='replacement-session';
      window.releasePrepare();
    },change);
    await expect(page.locator('.operation-results')).toContainText('cancel');
    expect(await remoteArchives(page)).toEqual([]);
    await page.locator('#archive-cancel').click();
  }
  expect(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='cancel_file_operation'&&c.args.abandon))).toHaveLength(2);
});
test('remote archive progress is backend-reported and unknown result invalidates its POSIX parent', async ({page}) => {
  await setup(page);
  await bindArchiveHost(page,{path:'/srv/data'});
  await page.evaluate(()=>{
    window.pendingArchive=true;
    window.archiveProgress={phase:'scanning',unit:'bytes',done:0,total:null,entries:0,item:1,itemCount:1};
  });
  await openArchive(page,'remote','keep.txt','compress');
  await page.locator('[name=archive-name]').fill('name:with-colon.zip');
  await page.locator('#archive-confirm').click();
  await expect(page.locator('.operation-progress-label')).toContainText('Scanning');
  await expect(page.locator('.operation-progress progress')).not.toHaveAttribute('value');
  await page.evaluate(()=>window.archiveProgress={phase:'copying',unit:'bytes',done:3,total:11,entries:1,item:1,itemCount:1});
  await expect(page.locator('.operation-progress-label')).toContainText('3 / 11 B');
  await page.evaluate(()=>{window.archiveError={code:'remote_outcome_unknown',committed:false};window.releaseArchive();});
  await expect(page.locator('.operation-results')).toContainText('Refresh the listing');
  expect((await remoteArchives(page))[0]).toMatchObject({sessionId:'archive-session',sources:['/srv/data/keep.txt'],destination:'/srv/data/name:with-colon.zip'});
  expect(await page.evaluate(()=>window.archiveChanges)).toEqual([{side:'remote',passphrase:'',change:{action:'createfile',paths:['/srv/data/name:with-colon.zip'],parent:'/srv/data',affectedDirectories:['/srv/data'],uncertain:true,created:false}}]);
});

test('remote confirmed publication wins over a late cancellation request', async ({page}) => {
  await setup(page);
  await page.evaluate(()=>window.pendingArchive=true);
  await openArchive(page,'remote','keep.txt','compress');
  await page.locator('#archive-confirm').click();
  await expect.poll(()=>remoteArchives(page)).toHaveLength(1);
  await page.locator('#archive-cancel').click();
  await page.evaluate(()=>window.releaseArchive());
  const feedback=page.locator('.operation-feedback');
  await expect(feedback).toHaveAttribute('data-success','true');
  await expect(page.locator('.operation-progress-label')).toHaveText('Completed');
  await expect(page.locator('.operation-results')).toContainText('ZIP operation completed.');
  await expect(page.locator('.operation-results')).not.toContainText('may have');
  await expect(page.locator('[data-list=remote] [data-name="keep.txt.zip"]')).toHaveAttribute('aria-selected','true');
  expect(await remoteArchives(page)).toHaveLength(1);
});