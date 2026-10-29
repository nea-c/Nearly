import {test, expect} from '@playwright/test';
import {setup, nativeDrop} from './transfer-v2-drop-fixture';

async function holdTransfers(page) {
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI__.core.invoke;
    w.sample = {phase:'connecting', unit:'bytes', done:0, total:null, entries:0, item:1, itemCount:2};
    w.progressCalls = [];
    w.__TAURI__.core.invoke = async (cmd:string, args:any) => {
      if (cmd === 'file_operation_progress') {w.progressCalls.push(args.id); return w.sample;}
      if (['run_upload','run_download','run_remote_drag'].includes(cmd)) {
        w.calls.push({cmd,args});
        return new Promise(resolve => {w.finishTransfer = resolve;});
      }
      return original(cmd,args);
    };
  });
}

async function sample(page, phase:string, done:number, total:number|null) {
  await page.evaluate(({phase,done,total}) => {
    Object.assign((window as any).sample, {phase,done,total});
  }, {phase,done,total});
}

test('native upload drop shows batch bytes and never completes before publication outcome', async ({page}) => {
  await setup(page); await holdTransfers(page);
  await nativeDrop(page, '[data-list=remote] [data-name=folder]', ['C:\\generated\\first.bin','C:\\generated\\second.bin']);
  await page.locator('#upload-confirm').click();
  const gauge = page.locator('.operation-feedback progress');
  await expect(gauge).toBeVisible(); await expect(gauge).not.toHaveAttribute('value');
  await sample(page,'scanning',0,null);
  await expect(page.locator('.operation-progress-label')).toContainText('Scanning');
  await sample(page,'uploading',32768,170000);
  await expect(gauge).toHaveAttribute('value','32768'); await expect(gauge).toHaveAttribute('max','170000');
  await sample(page,'uploading',100000,170000);
  await expect(gauge).toHaveAttribute('value','100000');
  await sample(page,'finalizing',170000,170000);
  await expect(gauge).not.toHaveAttribute('value');
  await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
  await page.evaluate(() => (window as any).finishTransfer({status:'partial',completed:1,bytes:100000,transferredBytes:170000,skipped:0,message:'Generated publication rejected'}));
  await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');
  await expect(page.locator('.operation-feedback')).toContainText('Generated publication rejected');
  await expect(gauge).not.toHaveAttribute('value');
  expect(await page.evaluate(() => {
    const w=window as any, id=w.calls.find((c:any)=>c.cmd==='run_upload').args.request.id;
    return w.progressCalls.length>0 && w.progressCalls.every((p:string)=>p===id);
  })).toBe(true);
});

test('local pane upload pointer drop tracks its transfer through acknowledged success', async ({page}) => {
  await setup(page); await holdTransfers(page);
  const source=(await page.locator('[data-list=local] [data-name="one.txt"]').boundingBox())!;
  const target=(await page.locator('[data-list=remote] [data-name=folder]').boundingBox())!;
  await page.mouse.move(source.x+30,source.y+source.height/2); await page.mouse.down();
  await page.mouse.move(target.x+30,target.y+target.height/2,{steps:12}); await page.mouse.up();
  await page.locator('#upload-confirm').click();
  await sample(page,'uploading',32768,100000);
  const gauge=page.locator('.operation-feedback progress');
  await expect(gauge).toHaveAttribute('value','32768');
  await sample(page,'uploading',100000,100000);
  await expect(gauge).not.toHaveAttribute('value');
  await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
  await page.evaluate(() => (window as any).finishTransfer({status:'completed',completed:1,bytes:100000,transferredBytes:100000,skipped:0,message:'Generated acknowledged copy'}));
  await expect(gauge).toHaveAttribute('value','1');
  await expect(page.locator('.operation-progress-label')).toHaveText('Completed');
});

test('internal remote-to-local download replaces drag notice with aggregate download gauge', async ({page}) => {
  await setup(page); await holdTransfers(page);
  const source=(await page.locator('[data-list=remote] [data-name="one.txt"]').boundingBox())!;
  const target=(await page.locator('[data-list=local] [data-name=folder]').boundingBox())!;
  await page.mouse.move(source.x+30,source.y+source.height/2); await page.mouse.down();
  await page.mouse.move(target.x+30,target.y+target.height/2,{steps:12}); await page.mouse.up();
  await expect.poll(()=>page.evaluate(() => typeof (window as any).finishTransfer)).toBe('function');
  await page.evaluate(box => (window as any).finishTransfer({status:'cancelled',completed:0,bytes:0,message:'Internal destination',internalPosition:{x:(box.x+30)*devicePixelRatio,y:(box.y+box.height/2)*devicePixelRatio}}),target);
  await page.locator('#download-confirm').click();
  await sample(page,'downloading',65536,170000);
  const gauge=page.locator('.operation-feedback progress');
  await expect(gauge).toHaveAttribute('value','65536');
  await expect(page.locator('.operation-progress-label')).toContainText('Downloading');
  await expect(gauge).toHaveAttribute('max','170000');
  await page.locator('#upload-cancel').click();
  await expect.poll(()=>page.evaluate(() => (window as any).calls.some((c:any)=>c.cmd==='cancel_file_operation'))).toBe(true);
  await page.evaluate(() => (window as any).finishTransfer({status:'cancelled',completed:0,bytes:0,transferredBytes:65536,skipped:0,message:'Generated partial download cancelled'}));
  await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');
  await expect(gauge).not.toHaveAttribute('value');
});

test('Explorer download keeps final stream delivery indeterminate until Windows confirms copy', async ({page}) => {
  await setup(page); await holdTransfers(page);
  const source=(await page.locator('[data-list=remote] [data-name="one.txt"]').boundingBox())!, viewport=page.viewportSize()!;
  await page.mouse.move(source.x+30,source.y+source.height/2); await page.mouse.down();
  await page.mouse.move(viewport.width+20,source.y+source.height/2,{steps:12}); await page.mouse.up();
  await sample(page,'waiting',0,170000);
  const gauge=page.locator('.operation-feedback progress');
  await expect(gauge).toBeVisible(); await expect(gauge).not.toHaveAttribute('value');
  await sample(page,'downloading',32768,170000);
  await expect(gauge).toHaveAttribute('value','32768');
  await sample(page,'finalizing',170000,170000);
  await expect(gauge).not.toHaveAttribute('value');
  await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
  await page.evaluate(() => (window as any).finishTransfer({status:'completed',completed:2,bytes:170000,transferredBytes:170004,skipped:0,message:'Windows copy acknowledged'}));
  await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','true');
  await expect(page.locator('.operation-progress-label')).toHaveText('Completed');
});
