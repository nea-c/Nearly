import { test, expect } from '@playwright/test';

async function fixture(page, empty = false, mode = 'light') {
  await page.addInitScript(({empty,mode}) => {
    const profiles = empty ? [] : [{id:'a',name:'Alpha',host:'fixture.invalid',port:22,user:'tester',mode:'sftp',auth:'key',keyFile:'generated',hostKey:'fixture-pin'}];
    const initial = {version:1,profiles,history:{},theme:mode,connectionTree:{version:1,nodes:empty?[]:[{id:'g',kind:'group',name:'Group',parentId:null,expanded:true},{id:'a',kind:'profile',profileId:'a',parentId:'g'}]}};
    window.rootFooterCalls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.rootFooterCalls.push({cmd,args});
      if(cmd==='load_settings') return JSON.parse(localStorage.getItem('root-footer-settings')||'null')||initial;
      if(cmd==='save_settings'){localStorage.setItem('root-footer-settings',JSON.stringify(args.data));return;}
      if(cmd==='default_folder') return 'C:\\';
    }}};
  },{empty,mode});
  await page.goto('/');
  await expect(page.locator('#connection-tree')).toBeVisible();
}
const saved = page => page.evaluate(()=>JSON.parse(localStorage.getItem('root-footer-settings')||'{}'));

for(const mode of ['light','dark']) test(`connection root footer and its reserved space are absent in ${mode}`,async({page})=>{
  await page.setViewportSize({width:800,height:650});
  await fixture(page,false,mode);
  await expect(page.locator('.connection-root-drop,[data-connection-drop-root]')).toHaveCount(0);
  const gap=await page.locator('.connection-library').evaluate(library=>library.getBoundingClientRect().bottom-library.querySelector('#connection-tree').getBoundingClientRect().bottom);
  expect(gap).toBeLessThanOrEqual(2);
  await page.locator('[data-connection-select=a]').click();
  await expect(page.locator('#edit-profile')).toBeVisible();
  await page.locator('#edit-profile').click();
  await expect(page.locator('#profile-form [name=name]')).toHaveValue('Alpha');
  await page.locator('#cancel').click();
  await expect(page.locator('#profile-form')).toHaveCount(0);
  await page.screenshot({path:`test-results/root-footer-${mode}-800.png`});
});

test('actual mouse moves a nested profile to blank tree root and persists without connecting',async({page})=>{
  await fixture(page);
  const row=page.locator('[data-connection-node=a]'), tree=page.locator('#connection-tree');
  const from=await row.boundingBox(), to=await tree.boundingBox();
  await page.mouse.move(from.x+from.width*.7,from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(from.x+from.width*.7+10,from.y+from.height/2,{steps:3});
  await page.mouse.move(to.x+to.width/2,to.y+to.height-18,{steps:16});
  await expect(tree).toHaveAttribute('data-drop','inside');
  await page.mouse.up();
  await expect.poll(async()=>(await saved(page)).connectionTree?.nodes.find(n=>n.id==='a').parentId).toBe(null);
  await page.reload();
  await expect(page.locator('[data-connection-node=a]')).toHaveAttribute('aria-level','1');
  expect(await page.evaluate(()=>window.rootFooterCalls.filter(c=>c.cmd==='connect_session').length)).toBe(0);
});

test('empty tree background context creates the first root group without a footer',async({page})=>{
  await fixture(page,true);
  const tree=page.locator('#connection-tree'), bounds=await tree.boundingBox();
  await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height-18,{button:'right'});
  await page.locator('[data-menu-action=add-group]').click();
  await page.locator('#connection-node-name').fill('First root group');
  await page.locator('#connection-node-submit').click();
  await expect(page.locator('#connection-node-form')).toHaveCount(0);
  const nodes=(await saved(page)).connectionTree.nodes;
  expect(nodes).toHaveLength(1);expect(nodes[0]).toMatchObject({kind:'group',name:'First root group',parentId:null});
  await expect(page.locator('.connection-root-drop,[data-connection-drop-root]')).toHaveCount(0);
});
