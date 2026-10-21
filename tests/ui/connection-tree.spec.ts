import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("<head>", '<head><meta http-equiv="Content-Security-Policy" content="style-src-attr \'none\'">') });
  });
  await page.addInitScript(() => {
    window.calls = [];
    window.__TAURI__ = { core: { invoke: async (cmd, args) => {
      window.calls.push({cmd, args});
      if (cmd === "load_settings") return JSON.parse(localStorage.getItem("tree-settings") || "null") || { version: 1, profiles: [
        {id:"a",name:"Alpha",host:"a.invalid",port:22,user:"alice",mode:"sftp",auth:"key",keyFile:"fixture.ppk",hostKey:"fixture-a"},
        {id:"b",name:"Beta",host:"b.invalid",port:22,user:"bob",mode:"sftp",auth:"key",keyFile:"fixture.ppk",hostKey:"fixture-b"}
      ], history: {'["a","/old"]':"C:\\old"}, theme:"light", localPaneRatio:.6 };
      if (cmd === "save_settings") {
        if (window.failSave) throw Error("fixture save denied");
        if (window.holdSave) await new Promise((resolve,reject) => {window.releaseSave = resolve;window.rejectSave = reject;});
        localStorage.setItem("tree-settings",JSON.stringify(args.data)); return;
      }
      if (cmd === "default_folder") return "C:\\fixture";
      if (cmd === "list_drives") return [{path:"C:\\",name:"C:"}];
      if (cmd === "connect_session") return {path:"/",entries:[]};
      if (cmd === "list_local" || cmd === "list_remote") return [];
    }}};
  });
  await page.goto("/");
  await expect(page.locator("#connection-tree")).toBeVisible();
});
const select = (page, id) => page.locator(`[data-connection-select="${id}"]`).click();
const data = page => page.evaluate(() => JSON.parse(localStorage.getItem("tree-settings")));
async function manage(page, action, id = undefined) {
  const row = id === null ? page.locator('#connection-tree') : id ? page.locator(`[data-connection-node="${id}"]`) : page.locator('[data-connection-node][aria-selected="true"]');
  // Real pointer actionability waits for the post-save row to settle; a direct
  // contextmenu dispatch can run before the deferred committed-tree render.
  if (id !== null && await row.count()) await row.first().click({button:'right',position:{x:20,y:12}});
  else await page.locator('#connection-tree').dispatchEvent('contextmenu',{clientX:100,clientY:150});
  await page.locator(`[data-menu-action="${action}"]`).click();
}
async function rowDrag(page, source, target, position, drop = true) {
  await Promise.all([source,target].map(id=>page.locator(`[data-connection-node="${id}"]`).waitFor({state:'visible'})));
  const {from,to}=await page.evaluate(({source,target})=>new Promise<{from:{x:number;y:number;width:number;height:number};to:{x:number;y:number;width:number;height:number}}>((resolve,reject)=>{
    const deadline=performance.now()+5000;
    let previous:{nodes:Element[];rects:DOMRect[]}|undefined, stable=0;
    const frame=()=>{
      const nodes=[source,target].map(id=>document.querySelector(`[data-connection-node="${CSS.escape(id)}"]`));
      if(nodes.every((node):node is Element=>!!node&&node.isConnected&&getComputedStyle(node).visibility!=='hidden')){
        const rects=nodes.map(node=>node.getBoundingClientRect());
        const visible=rects.every(rect=>rect.width>0&&rect.height>0);
        const unchanged=visible&&previous&&nodes.every((node,i)=>node===previous!.nodes[i]&&(['x','y','width','height'] as const).every(key=>rects[i][key]===previous!.rects[i][key]));
        stable=unchanged?stable+1:0;
        previous=visible?{nodes,rects}:undefined;
        if(stable>=2){
          const box=(r:DOMRect)=>({x:r.x,y:r.y,width:r.width,height:r.height});
          resolve({from:box(rects[0]),to:box(rects[1])});return;
        }
      }else{previous=undefined;stable=0;}
      if(performance.now()>=deadline){reject(Error(`Connection drag geometry did not stabilize: ${source} -> ${target}`));return;}
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }),{source,target});
  await page.mouse.move(from.x+from.width-8,from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(to.x+to.width/2,to.y+to.height*position,{steps:10});
  if(drop) await page.mouse.up();
}
async function group(page, name) {
  await manage(page,"add-group");
  await page.locator("#connection-node-name").fill(name);
  await page.locator("#connection-node-submit").click();
  await expect(page.locator("#connection-node-form")).toHaveCount(0);
  return (await data(page)).connectionTree.nodes.find(n => n.kind === "group" && n.name === name).id;
}
async function pressSettledChevron(page, id, key) {
  // Saving refreshes the old view, then schedules its committed replacement.
  // aria-expanded on the old view alone is not readiness for another keypress.
  // Wait for the same connected control across frames, as rowDrag does above.
  await page.evaluate(id => new Promise<void>((resolve,reject) => {
    const deadline=performance.now()+5000;
    let previous:Element|null=null,stable=0;
    const frame=()=>{
      const node=document.querySelector(`[data-connection-toggle="${CSS.escape(id)}"]`);
      const bounds=node?.getBoundingClientRect();
      if(node?.isConnected&&bounds&&bounds.width>0&&bounds.height>0){
        stable=node===previous?stable+1:0;previous=node;
        if(stable>=2){resolve();return;}
      }else{previous=null;stable=0;}
      if(performance.now()>=deadline){reject(Error('Committed chevron did not stabilize'));return;}
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }),id);
  const control=page.locator(`[data-connection-toggle="${id}"]`);
  await control.focus();
  await expect(control).toBeFocused();
  await control.press(key);
}
async function move(page, id, parent = "", before = "") {
  if (parent) await rowDrag(page,id,parent,.5);
  else if (before) await rowDrag(page,id,before,.1);
  else throw Error('A concrete drag destination is required');
  await expect.poll(async()=>(await data(page)).connectionTree.nodes.find(n=>n.id===id).parentId).toBe(parent||null);
}

test("flat profiles migrate into nested editable groups, duplicate with fresh IDs and connect only explicitly", async ({page}) => {
  await expect(page.locator("[data-connection-select]")).toHaveText(["◇Alpha","◇Beta"]);
  const outer = await group(page,"Production <A>");
  await expect(page.locator("#connect-form .primary")).toBeDisabled();
  const inner = await group(page,"Nested");
  await move(page,"a",inner);
  await select(page,outer);
  await manage(page,"rename",outer);
  await page.locator("#connection-node-name").fill("Production");
  await page.locator("#connection-node-submit").click();
  await expect(page.locator("#connection-node-form")).toHaveCount(0);
  await expect.poll(async () => (await data(page)).connectionTree.nodes.find(n=>n.id===outer).name).toBe("Production");
  await manage(page,"duplicate",outer);
  await expect.poll(async () => (await data(page)).profiles.length).toBe(3);
  const saved = await data(page);
  expect(saved.connectionTree.nodes).toHaveLength(7);
  expect(new Set(saved.connectionTree.nodes.map(n=>n.id)).size).toBe(7);
  expect(saved.profiles.find(p=>p.id==="a").name).toBe("Alpha");
  expect(saved.profiles.find(p=>!["a","b"].includes(p.id)).host).toBe("a.invalid");
  expect(saved.history).toEqual({'["a","/old"]':"C:\\old"});
  expect(saved.localPaneRatio).toBe(.6);
  expect(await page.evaluate(() => window.calls.filter(c => c.cmd === "connect_session").length)).toBe(0);
  await page.locator(`[data-connection-toggle="${outer}"]`).click();
  await expect(page.locator(`[data-connection-node="${outer}"]`)).toHaveAttribute("aria-expanded","false");
  await page.reload();
  await expect(page.locator(`[data-connection-node="${outer}"]`)).toHaveAttribute("aria-expanded","false");
  await page.locator(`[data-connection-toggle="${outer}"]`).click();
  await select(page,"a");
  await page.locator('#connect-form [name="passphrase"]').fill("ephemeral-fixture");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#prepare")).toBeVisible();
  const calls = await page.evaluate(() => window.calls.filter(c => c.cmd === "connect_session"));
  expect(calls).toHaveLength(1);
  expect(calls[0].args.profile.id).toBe("a");
  expect(JSON.stringify(await data(page))).not.toContain("ephemeral-fixture");
});

test("drag before inside after and direct pointer moves share validation without automatic connection", async ({page}) => {
  const g = await group(page,"Group");
  const child = await group(page,"Child");
  const drag=(source,target,position)=>rowDrag(page,source,target,position);
  await drag("a",g,.5);
  await expect.poll(async()=>(await data(page)).connectionTree.nodes.find(n=>n.id==="a").parentId).toBe(g);
  await drag("b",g,.1);
  await expect.poll(async()=>(await data(page)).connectionTree.nodes.filter(n=>n.parentId===null).map(n=>n.id)).toEqual(["b",g]);
  await drag("b",g,.9);
  await expect.poll(async()=>(await data(page)).connectionTree.nodes.filter(n=>n.parentId===null).map(n=>n.id)).toEqual([g,"b"]);
  const before=JSON.stringify((await data(page)).connectionTree);
  await drag(g,child,.5);
  await expect(page.locator(".connection-tree-error")).not.toBeEmpty();
  expect(JSON.stringify((await data(page)).connectionTree)).toBe(before);
  // A deliberate click on another row immediately after a rejected drop must
  // select that row, rather than editing the previous drag selection.
  await select(page,"a");
  await expect(page.locator('[data-connection-node="a"]')).toHaveAttribute("aria-selected","true");
  await move(page,"a","","b");
  expect((await data(page)).connectionTree.nodes.filter(n=>n.parentId===null).map(n=>n.id)).toEqual([g,"a","b"]);
  await page.locator('[data-connection-select="a"]').click({button:"right"});
  await page.locator('[data-menu-action="duplicate"]').click();
  await expect.poll(async()=>(await data(page)).profiles.length).toBe(3);
  expect(await page.evaluate(() => window.calls.filter(c=>c.cmd==="connect_session").length)).toBe(0);
});

test("failed and pending mutations preserve committed settings and cannot replace a newer tab form", async ({page}) => {
  await manage(page,"add-group");
  await page.locator("#connection-node-name").fill("Rejected");
  await page.evaluate(()=>window.failSave=true);
  await page.locator("#connection-node-submit").click();
  await expect(page.locator("#connection-tree-dialog .form-error")).toContainText("fixture save denied");
  await expect(page.locator("[data-connection-node]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.evaluate(()=>{window.failSave=false;window.holdSave=true;});
  await manage(page,"add-group");
  await page.locator("#connection-node-name").fill("Committed");
  await page.locator("#connection-node-submit").click();
  await expect.poll(()=>page.evaluate(()=>!!window.releaseSave)).toBe(true);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press("Escape");
  await expect(page.locator("#connection-tree-dialog")).toHaveCount(0);
  await page.locator("#add-tab").click();
  await page.locator('#connection-tree').dispatchEvent('contextmenu',{clientX:100,clientY:150});
  await expect(page.locator('#connection-context-menu')).toHaveCount(0);
  await expect(page.locator("#connection-node-form")).toHaveCount(0);
  await page.evaluate(()=>{window.holdSave=false;window.releaseSave();});
  await expect(page.locator("[data-connection-select]").filter({hasText:"Committed"})).toBeVisible();
  await expect(page.locator("#connect-form")).toBeVisible();
  expect((await data(page)).connectionTree.nodes.filter(n=>n.kind==="group").map(n=>n.name)).toEqual(["Committed"]);
  await group(page,"Second");
  expect((await data(page)).connectionTree.nodes.filter(n=>n.kind==="group")).toHaveLength(2);
});

test("profile edits remain transactional and never retarget a connected session", async ({page}) => {
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#prepare")).toBeVisible();
  const first=await page.locator("[data-tab]").getAttribute("data-tab");
  await page.locator("#add-tab").click();
  await select(page,"a");
  await page.locator("#edit-profile").click();
  await page.locator('#profile-form [name="name"]').fill("Renamed A");
  await page.locator('#profile-form [name="host"]').fill("edited.invalid");
  await page.evaluate(()=>window.failSave=true);
  await page.locator("#profile-form .primary").click();
  await expect(page.locator("#modal-root .form-error")).toContainText("fixture save denied");
  await expect(page.locator('#profile-form [name="name"]')).toBeEnabled();
  await page.evaluate(()=>window.failSave=false);
  await page.locator("#profile-form .primary").click();
  await expect(page.locator("#profile-form")).toHaveCount(0);
  await expect(page.locator(".connection-endpoint")).toContainText("edited.invalid");
  await page.locator(`[data-tab="${first}"]`).click();
  await expect(page.locator(`[data-tab="${first}"]`)).toHaveAttribute("title", /a\.invalid/);
  await expect(page.locator(`[data-tab="${first}"]`)).toContainText("Alpha");
  expect((await data(page)).history).toEqual({'["a","/old"]':"C:\\old"});
});

test("connection tree and editing surfaces fit both themes and narrow windows", async ({page}) => {
  const parent=await group(page,"本番環境 — Production");
  const child=await group(page,"Web サーバー");
  await move(page,"a",child);
  for (const theme of ["light","dark"]) {
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await page.locator("#settings-close").click();
    for (const width of [800,1180]) {
      await page.setViewportSize({width,height:650});
      await expect(page.locator("#connect-form .primary")).toBeInViewport({ratio:1});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`test-results/connection-tree-${theme}-${width}.png`});
    }
    await select(page,parent);
    await manage(page,"rename",parent);
    await page.setViewportSize({width:800,height:650});
    await expect(page.locator("#connection-node-submit")).toBeInViewport({ratio:1});
    await page.screenshot({path:`test-results/connection-tree-${theme}-rename.png`});
    await page.locator("#connection-node-cancel").click();
    await select(page,"a");
  }
});
test('same-tab keyboard selection and closing a background tab preserve the current group draft',async({page})=>{
  await manage(page,'add-group');
  await page.locator('#connection-node-name').fill('Keep single-tab draft');
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('#connection-node-name')).toHaveValue('Keep single-tab draft');
  await page.keyboard.press('Escape');
  const background=await page.locator('[data-tab][aria-selected=true]').getAttribute('data-tab');
  await page.locator('#add-tab').click();
  await manage(page,'add-group');
  await page.locator('#connection-node-name').fill('Keep active draft');
  await page.evaluate(id=>document.querySelector(`[data-close="${id}"]`).click(),background);
  await expect(page.locator('[data-tab]')).toHaveCount(1);
  await expect(page.locator('#connection-node-name')).toHaveValue('Keep active draft');
});

test('full row whitespace selects the connection',async({page})=>{
  await page.locator('[data-connection-node="b"]').dispatchEvent('click');
  await expect(page.locator('[data-connection-node="b"]')).toHaveAttribute('aria-selected','true');
});

test('adjacent after-drop is a durable no-op',async({page})=>{
  await rowDrag(page,'b','a',.9);
  await expect(page.locator('.connection-tree-error')).toBeEmpty();
  await expect.poll(async()=>(await data(page))?.connectionTree.nodes.filter(n=>n.parentId===null).map(n=>n.id)).toEqual(['a','b']);
  await page.reload();
  await expect(page.locator('[data-connection-select]')).toHaveText([/Alpha$/,/Beta$/]);
});

test('drag targets reject descendant cycles before accepting a drop and clear previous indicators',async({page})=>{
  const outer=await group(page,'Outer');
  const inner=await group(page,'Inner');
  await rowDrag(page,outer,'b',.1,false);
  await expect(page.locator('[data-connection-node="b"]')).toHaveAttribute('data-drop','before');
  const innerBounds=await page.locator(`[data-connection-node="${inner}"]`).boundingBox();
  expect(innerBounds).not.toBeNull();
  await page.mouse.move(innerBounds!.x+innerBounds!.width/2,innerBounds!.y+innerBounds!.height/2,{steps:8});
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  const before=JSON.stringify((await data(page)).connectionTree);
  await page.mouse.up();
  expect(JSON.stringify((await data(page)).connectionTree)).toBe(before);
});

test('full row context menu and failed drag save preserve durable order',async({page})=>{
  await page.locator('[data-connection-node="b"] .connection-node-row').dispatchEvent('contextmenu',{clientX:100,clientY:150});
  await expect(page.locator('[data-connection-node="b"]')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#connection-context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.failSave=true);
  await rowDrag(page,'b','a',.1);
  await expect(page.locator('.connection-tree-error')).toContainText('fixture save denied');
  await expect(page.locator('[data-connection-select]')).toHaveText([/Alpha$/,/Beta$/]);
  await page.reload();
  await expect(page.locator('[data-connection-select]')).toHaveText([/Alpha$/,/Beta$/]);
});

test('pointer drag reorders a connection from its blank row area and survives reload',async({page})=>{
  const source=page.locator('[data-connection-node="b"]');
  const bounds=await source.boundingBox();
  expect(bounds).not.toBeNull();
  await rowDrag(page,'b','a',.1);
  await expect.poll(async()=>(await data(page))?.connectionTree.nodes.filter(n=>n.parentId===null).map(n=>n.id)).toEqual(['b','a']);
  await page.reload();
  await expect(page.locator('[data-connection-select]')).toHaveText([/Beta$/,/Alpha$/]);
});

test('only the focused chevron expands groups and inside-drop retains collapsed state',async({page})=>{
  const id=await group(page,'Chevron only');
  const row=page.locator(`[data-connection-node="${id}"]`);
  const toggle=page.locator(`[data-connection-toggle="${id}"]`);
  await toggle.click();
  await expect(row).toHaveAttribute('aria-expanded','false');
  await page.locator(`[data-connection-select="${id}"]`).dblclick();
  await row.dispatchEvent('click');
  await page.locator(`[data-connection-select="${id}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await expect(row).toHaveAttribute('aria-expanded','false');
  await rowDrag(page,'a',id,.5);
  await expect.poll(async()=>(await data(page)).connectionTree.nodes.find(n=>n.id==='a').parentId).toBe(id);
  await expect(row).toHaveAttribute('aria-expanded','false');
  await pressSettledChevron(page,id,'Space');
  await expect(row).toHaveAttribute('aria-expanded','true');
  await expect.poll(async()=>(await data(page)).connectionTree.nodes.find(n=>n.id===id).expanded).toBe(true);
  await pressSettledChevron(page,id,'Enter');
  await expect(row).toHaveAttribute('aria-expanded','false');
  await page.reload();
  await expect(row).toHaveAttribute('aria-expanded','false');
});

test('dragging after the source itself never advertises a reorder target',async({page})=>{
  await rowDrag(page,'b','b',.9,false);
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-drop]')).toHaveCount(0);
});

test('connection management is context-only and an empty or selected background adds at root',async({page})=>{
  await expect(page.locator('#add-profile,#add-connection-group,#connection-actions,[data-connection-action]')).toHaveCount(0);
  await page.evaluate(()=>localStorage.setItem('tree-settings',JSON.stringify({version:1,profiles:[],history:{}})));
  await page.reload();
  await expect(page.locator('.connection-tree-empty')).toBeVisible();
  await page.locator('.connection-tree-empty').click({button:'right'});
  await expect(page.locator('#connection-context-menu [data-menu-action]')).toHaveCount(2);
  await page.locator('[data-menu-action="add-profile"]').click();
  await expect(page.locator('#profile-form')).toBeVisible();
  await page.keyboard.press('Escape');
  await manage(page,'add-group',null);
  await page.locator('#connection-node-name').fill('First root');
  await page.locator('#connection-node-submit').click();
  await expect(page.locator('#connection-node-form')).toHaveCount(0);
  const first=(await data(page)).connectionTree.nodes[0];
  expect(first.parentId).toBeNull();
  await expect(page.locator(`[data-connection-node="${first.id}"]`)).toHaveAttribute('aria-selected','true');
  await manage(page,'add-group',null);
  await page.locator('#connection-node-name').fill('Second root');
  await page.locator('#connection-node-submit').click();
  await expect(page.locator('#connection-node-form')).toHaveCount(0);
  expect((await data(page)).connectionTree.nodes.map(n=>n.parentId)).toEqual([null,null]);
  await expect(page.locator('#add-profile,#add-connection-group,#connection-actions,[data-connection-action]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='connect_session'||c.cmd==='start_sync').length)).toBe(0);
});
