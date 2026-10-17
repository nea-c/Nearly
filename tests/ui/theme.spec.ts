import { test, expect } from "@playwright/test";

// IPC fixtures keep these appearance checks valid against a production bundle,
// whose optional development-only mock connection mode is deliberately disabled.
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{
    const profile={id:'theme-fixture',name:'Theme fixture',host:'fixture.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',keyFile:'C:\\fixture.ppk',hostKey:'SHA256:fixture'};
    const entries=[{name:'alpha',dir:true,size:0,modified:0},{name:'beta.txt',dir:false,size:128,modified:0},{name:'gamma.txt',dir:false,size:256,modified:0}];
    window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(cmd,args={})=>{
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('syncfiles-v1')||JSON.stringify({version:1,settingsRevision:0,profiles:[profile]}));
      if(cmd==='save_settings'){const revision=args.data.settingsRevision+1;localStorage.setItem('syncfiles-v1',JSON.stringify({...args.data,settingsRevision:revision}));return revision;}
      if(cmd==='default_folder')return 'C:\\fixture';
      if(cmd==='list_drives')return[{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return{path:'/',entries};
      if(cmd==='list_local'||cmd==='list_remote')return entries;
      if(cmd==='watch_local_directory'||cmd==='local_watch_status')return {token:args.token,revision:0};
      if(cmd==='run_file_operation'||cmd==='start_sync')throw Error('Mutations forbidden in theme fixture');
      return undefined;
    }}};
  });
});

test("first OS choice persists explicitly and all five manual themes ignore later OS changes", async ({page}) => {
  await page.emulateMedia({colorScheme:"dark"});
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await page.locator("#settings-toggle").click();
  const selector=page.locator("#theme-select"),root=page.locator("html");
  await expect(selector).toHaveValue("dark");
  await expect(selector.locator("option")).toHaveText(["ライト","ダーク","ミッドナイト","ジェイド","ミント"]);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("syncfiles-v1")).theme)).toBe("dark");
  await page.emulateMedia({colorScheme:"light"});
  await expect(root).toHaveAttribute("data-theme","dark");
  for (const theme of ["light","dark","midnight","forest","mint"]) {
    await selector.selectOption(theme);
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("syncfiles-v1")).theme)).toBe(theme);
    await page.emulateMedia({colorScheme:["light","mint"].includes(theme)?"dark":"light"});
    await expect(root).toHaveAttribute("data-theme",theme);
  }
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await page.locator("#settings-toggle").click();
  await expect(selector).toHaveValue("mint");
  await expect(root).toHaveAttribute("data-theme","mint");
});

for (const theme of ["light", "dark", "midnight", "forest", "mint"])
  test(`${theme} covers trees, selection, menus and dialogs without horizontal overflow`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#connect-form .primary").click();
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const size of [
      { width: 800, height: 650 },
      { width: 1180, height: 850 },
    ]) {
      await page.setViewportSize(size);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const control = await page.locator("#theme-select").boundingBox();
      expect(control.x + control.width).toBeLessThanOrEqual(size.width);
      await expect(page.locator("#prepare")).toBeVisible();
    }
    await page.locator("#settings-close").click();
    const row = page.locator("[data-list=local] [data-entry]").nth(2);
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    await row.click({ button: "right" });
    await expect(page.locator(".file-menu")).toBeVisible();
    await page.screenshot({ path: `test-results/theme-${theme}-menu.png` });
    const samples = await page.evaluate(() => {
      const rgb = (value) => (value.match(/[\d.]+/g) || []).map(Number);
      const luminance = (value) => {
        const c = rgb(value)
          .slice(0, 3)
          .map((v) => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
      };
      return [
        "body",
        ".pane > header h2",
        ".tree-caption",
        "th",
        ".file-menu button:not(:disabled)",
        ".menu-context",
        "#settings-toggle",
      ].map((selector) => {
        const el = document.querySelector(selector);
        const style = getComputedStyle(el);
        let parent = el,
          background;
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if (rgb(color)[3] !== 0) {
            background = color;
            break;
          }
          parent = parent.parentElement;
        }
        const a = luminance(style.color),
          b = luminance(background || "rgb(255,255,255)");
        return {
          selector,
          color: style.color,
          background,
          contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
    });
    for (const sample of samples)
      expect(sample.contrast, JSON.stringify(sample)).toBeGreaterThanOrEqual(
        4.5,
      );
    await page.keyboard.press("Escape");
    await page.locator("#prepare").click();
    await expect(page.locator("#start-form")).toBeVisible();
    await page.locator('#exclusion-details summary').click();
    await page.locator('#delete-removed').check();
    // Exercise the shared legacy hint selector as well as currently visible
    // target/summary elements: light-only specificity must not leak to midnight.
    await page.evaluate(()=>{
      const hint=document.createElement('p');hint.className='hint';hint.id='theme-hint-probe';
      const strong=document.createElement('strong');strong.textContent='Theme contrast sample';hint.append(strong);
      document.querySelector('#start-form').append(hint);
    });
    const accents=await page.evaluate(()=>['.target small','#exclusion-details summary','#theme-hint-probe strong'].map(selector=>getComputedStyle(document.querySelector(selector)).color));
    expect(accents).toEqual(Array(3).fill(({light:'rgb(82, 101, 125)',dark:'rgb(216, 216, 216)',midnight:'rgb(157, 199, 255)',forest:'rgb(145, 201, 178)',mint:'rgb(40, 93, 62)'})[theme]));
    if(theme==='midnight') {
      const placeholders=await page.evaluate(()=>['#preset-name','#exclusion-rules'].map(selector=>getComputedStyle(document.querySelector(selector),'::placeholder').color));
      expect(placeholders).toEqual(['rgb(137, 151, 170)','rgb(137, 151, 170)']);
      expect(await page.locator('#delete-warning').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(167, 183, 202)');
    }
    await page.locator('#theme-hint-probe').evaluate(el=>el.remove());
    await page.screenshot({ path: `test-results/theme-${theme}-dialog.png` });
  });

for (const theme of ['forest','mint']) for (const language of ['ja','en'])
test(`${theme} ${language} covers notices, error, disabled and keyboard focus in both densities`,async({page})=>{
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await page.locator('#settings-toggle').click();
  await page.locator('#theme-select').selectOption(theme);
  await page.locator('#language-select').selectOption(language);
  await expect(page.locator('#language-select option')).toHaveText(['English','日本語']);
  await expect(page.locator('#theme-select option')).toHaveText(language==='en'
    ?['Light','Dark','Midnight','Jade','Mint']:['ライト','ダーク','ミッドナイト','ジェイド','ミント']);
  for(const compact of [false,true]) {
    await page.locator('#compact-explorer').setChecked(compact);
    await page.locator('#settings-close').click();
    await page.setViewportSize({width:800,height:850});
    await page.locator('#prepare').click();
    await expect(page.locator('#start-form')).toBeVisible();
    // Render each shared state class in the real dialog. This verifies computed
    // cascade/ancestors, supplementing token checks without simulating a failure.
    await page.locator('#start-form').evaluate(form=>{
      const probe=document.createElement('div');probe.id='green-state-probe';
      probe.innerHTML='<div class="notice">Notice <button type="button">Dismiss</button></div><p class="form-error">Error</p><button type="button" disabled>Disabled</button><button type="button" id="green-focus-probe">Focus</button>';
      form.append(probe);
    });
    await page.locator('#green-focus-probe').focus();
    await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    const samples=await page.evaluate(()=>{
      function rgb(value:string){return (value.match(/[\d.]+/g)||[]).map(Number);}
      function lum(value:string){const a=rgb(value).slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return a[0]*.2126+a[1]*.7152+a[2]*.0722;}
      function ratio(a:string,b:string){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
      const all=['#green-state-probe .notice','#green-state-probe .notice button','#green-state-probe .form-error','#green-state-probe button:disabled','#green-focus-probe','.dialog'];
      return all.map(selector=>{
        const el=document.querySelector(selector)!,style=getComputedStyle(el);let parent:Element|null=el,background='';
        while(parent){const color=getComputedStyle(parent).backgroundColor;if(rgb(color)[3]!==0){background=color;break;}parent=parent.parentElement;}
        return {selector,color:style.color,background,contrast:ratio(style.color,background),focusContrast:ratio(style.outlineColor,background),focusVisible:el.matches(':focus-visible'),outlineWidth:style.outlineWidth};
      });
    });
    for(const sample of samples) expect(sample.contrast,JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
    const focus=samples.find(s=>s.selector==='#green-focus-probe')!;
    expect(focus.focusVisible).toBe(true);expect(parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);expect(focus.focusContrast).toBeGreaterThanOrEqual(3);
    const box=await page.locator('.dialog').boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(800);
    await page.screenshot({path:`test-results/green-themes/${theme}-${language}-${compact?'compact':'regular'}-states.png`});
    await page.locator('#green-state-probe').evaluate(el=>el.remove());
    await page.locator('#cancel').click();
    await page.locator('#settings-toggle').click();
  }
  await page.reload();await page.locator('#settings-toggle').click();
  await expect(page.locator('#theme-select')).toHaveValue(theme);await expect(page.locator('#language-select')).toHaveValue(language);
  expect(await page.locator('html').evaluate(el=>el.style.colorScheme)).toBe(theme==='mint'?'light':'dark');
});


