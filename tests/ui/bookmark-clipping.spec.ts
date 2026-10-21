import {test,expect,type Page} from '@playwright/test';

async function boot(page:Page,compact:boolean,count:number) {
  await page.addInitScript(({compact,count})=>{
    const profile={id:'clipping',name:'Layout fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const key=JSON.stringify([profile.id,profile.mode,profile.host,22,profile.user,profile.hostKey]);
    const names=['Agyp_日本語','A deliberately long bookmark label for ellipsis','Folder'];
    const settings={version:1,language:'en',compactExplorer:compact,profiles:[profile],history:{},
      localBookmarks:Array.from({length:count},(_,i)=>({id:'l'+i,name:names[i%3]+' '+i,path:'C:\\fixture'+i})),
      remoteBookmarks:Array.from({length:count},(_,i)=>({id:'r'+i,name:names[i%3]+' '+i,path:'/fixture'+i,connectionKey:key})),
      folderBookmarks:[{id:'pair',name:names[0],local:'C:\\pair',remote:'/pair',connectionKey:key}]};
    (window as any).__TAURI__={core:{invoke:async(cmd:string)=>{
      if(cmd==='load_settings')return settings;
      if(cmd==='default_folder')return 'C:\\';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return [];
    }}};
  },{compact,count});
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
}

for(const compact of [false,true])for(const width of [900,1280])test(`one bookmark fits without overflow ${compact?'compact':'normal'} ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:920});
  await boot(page,compact,1);
  const pairHeight=await page.locator('#paired-bookmarks .bookmark-items').evaluate(e=>e.getBoundingClientRect().height);
  for(const side of ['local','remote']) {
    const bar=page.locator(`#${side}-bookmarks`);
    await expect(bar.locator('[data-bookmark-overflow]')).toBeHidden();
    await expect(bar.locator('[data-side-open]')).toBeVisible();
    expect(await bar.locator('.bookmark-items').evaluate(e=>e.getBoundingClientRect().height)).toBe(pairHeight);
    const geometry=await bar.locator('[data-side-open]').evaluate(e=>{
      const label=e.querySelector('.bookmark-label')!,range=document.createRange();range.selectNodeContents(label);
      const text=range.getBoundingClientRect(),labelBox=label.getBoundingClientRect();
      return {textTop:text.top,textBottom:text.bottom,labelTop:labelBox.top,labelBottom:labelBox.bottom};
    });
    expect(geometry.textTop).toBeGreaterThanOrEqual(geometry.labelTop);
    expect(geometry.textBottom).toBeLessThanOrEqual(geometry.labelBottom);
    await bar.click({button:'right',position:{x:2,y:2}});
    await page.locator('[data-side-action=create]').click();
    await page.locator('#bookmark-folder-name').fill('Group 日本語');
    await page.locator('#bookmark-tree-form .primary').click();
    const folder=bar.locator('[data-bookmark-group]');
    await expect(folder).toBeVisible();
    const folderFits=await folder.evaluate(e=>{
      const strip=e.parentElement!.getBoundingClientRect(),button=e.getBoundingClientRect(),glyph=e.querySelector('.folder-glyph')!.getBoundingClientRect();
      return button.top>=strip.top&&button.bottom<=strip.bottom&&glyph.top>=strip.top&&glyph.bottom<=strip.bottom;
    });
    expect(folderFits).toBe(true);
  }
});

test('long labels retain ellipsis while overflow retains every original item across resize',async({page})=>{
  await page.setViewportSize({width:1280,height:920});
  await boot(page,false,12);
  for(const side of ['local','remote']) {
    const bar=page.locator(`#${side}-bookmarks`),prefix=side==='local'?'l':'r';
    const long=bar.locator(`[data-side-open=${prefix}1] .bookmark-label`);
    await expect(long).toBeVisible();
    expect(await long.evaluate(e=>getComputedStyle(e).textOverflow)).toBe('ellipsis');
    expect(await long.evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(true);
    const visible=await bar.locator('.bookmark-items > button:visible').count();
    await bar.locator('[data-bookmark-overflow]').click();
    const overflow=page.locator('.side-bookmark-menu [data-side-open]');
    await expect(overflow).toHaveCount(12-visible);
    expect(await page.locator(`[data-side-open^=${prefix}]`).count()).toBe(12);
    await page.keyboard.press('Escape');
    await expect(bar.locator('.bookmark-items > button')).toHaveCount(12);
  }
  await page.setViewportSize({width:900,height:920});
  for(const side of ['local','remote'])await expect(page.locator(`#${side}-bookmarks [data-bookmark-overflow]`)).toBeVisible();
  await page.setViewportSize({width:1600,height:920});
  for(const side of ['local','remote']) {
    const bounds=await page.locator(`#${side}-bookmarks`).evaluate(root=>{
      const strip=root.querySelector('.bookmark-items')!.getBoundingClientRect();
      return [...root.querySelectorAll<HTMLElement>('.bookmark-items > button:not([hidden])')].every(item=>item.getBoundingClientRect().right<=strip.right+0.5);
    });
    expect(bounds).toBe(true);
  }
});

for(const compact of [false,true])for(const width of [900,1280,1600])for(const zoom of [1,1.25,1.5]) {
  test(`side bookmark geometry ${compact?'compact':'normal'} ${width}px zoom ${zoom}`,async({page},testInfo)=>{
    await page.setViewportSize({width,height:920});
    await boot(page,compact,12);
    // CSS zoom exercises fractional layout; it is not native Windows DPI.
    await page.evaluate(z=>{document.body.style.zoom=String(z);},zoom);
    await expect.poll(()=>page.locator('#local-bookmarks [data-bookmark-overflow]').isVisible()).toBe(true);
    for(const side of ['local','remote']) {
      const metrics=await page.locator(`#${side}-bookmarks`).evaluate(root=>{
        const box=(e:Element)=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        const strip=root.querySelector('.bookmark-items')!,more=root.querySelector('[data-bookmark-overflow]')!;
        return {bar:box(root),strip:box(strip),more:box(more),items:[...strip.querySelectorAll<HTMLElement>('button:not([hidden])')].map(e=>({button:box(e),icon:box(e.querySelector('[data-bookmark-icon],.folder-glyph')!),label:box(e.querySelector('.bookmark-label')!)}))};
      });
      await testInfo.attach(side+'-geometry',{body:JSON.stringify(metrics,null,2),contentType:'application/json'});
      if(!compact&&width===1280&&zoom===1&&side==='local')await page.screenshot({path:testInfo.outputPath('bookmark-bars.png')});
      expect(metrics.items.length).toBeGreaterThan(0);
      for(const item of metrics.items) {
        expect(item.button.top,`${side} top edge`).toBeGreaterThanOrEqual(metrics.strip.top-0.05);
        expect(item.button.bottom,`${side} bottom edge`).toBeLessThanOrEqual(metrics.strip.bottom+0.05);
        expect(item.button.right,`${side} right edge`).toBeLessThanOrEqual(metrics.strip.right+0.5);
        for(const part of [item.icon,item.label]) {
          expect(part.top).toBeGreaterThanOrEqual(metrics.strip.top-0.05);
          expect(part.bottom).toBeLessThanOrEqual(metrics.strip.bottom+0.05);
        }
      }
      expect(metrics.more.left).toBeGreaterThanOrEqual(metrics.strip.right-0.5);
      expect(metrics.more.right).toBeLessThanOrEqual(metrics.bar.right+0.5);
    }
  });
}
