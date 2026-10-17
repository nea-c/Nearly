import { test, expect } from "@playwright/test";

test.beforeEach(async ({page}) => {
  await page.addInitScript(() => {
    window.calls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.calls.push({cmd,args});
      if(cmd==="load_settings") {
        if(!localStorage.getItem("host-settings"))localStorage.setItem("host-settings",JSON.stringify({version:1,profiles:[{id:"new",name:"New server",host:"new.invalid",port:2222,user:"fixture",mode:"sftp",auth:"key",keyFile:"fixture.ppk",hostKey:""}],history:{},theme:"light"}));
        return JSON.parse(localStorage.getItem("host-settings"));
      }
      if(cmd==="save_settings"){localStorage.setItem("host-settings",JSON.stringify(args.data));return;}
      if(cmd==="default_folder")return "C:\\fixture";
      if(cmd==="list_drives")return [{name:"C:",path:"C:\\"}];
      if(cmd==="list_local"||cmd==="list_remote")return [];
      if(cmd==="probe_host_key") {
        const result={requestId:args.requestId,token:"one-use-token",host:args.profile.host,port:args.profile.port,algorithm:"ssh-ed25519",fingerprint:"SHA256:fixture-fingerprint",expiresInSeconds:window.shortExpiry?1:120};
        if(window.holdProbe)return await new Promise(resolve=>window.releaseProbe=()=>resolve(result));
        return result;
      }
      if(cmd==="approve_host_key") {
        if(window.holdApproval)await new Promise(resolve=>window.releaseApproval=resolve);
        if(window.failApproval&&!window.partialApproval)throw Error("approval persistence failed");
        const profile={...args.profile,hostKey:"SHA256:fixture-fingerprint"};
        const saved=JSON.parse(localStorage.getItem("host-settings"));saved.profiles=saved.profiles.map(p=>p.id===profile.id?profile:p);localStorage.setItem("host-settings",JSON.stringify(saved));
        if(window.partialApproval)throw Error("approval outcome needs reload");
        return Object.fromEntries(Object.entries(profile).reverse());
      }
      if(cmd==="connect_session") {
        if(window.mismatch)throw Error("host key mismatch");
        return {path:"/",entries:[]};
      }
    }}};
  });
  await page.goto("/");
  await expect(page.locator("#connect-form")).toBeVisible();
});
async function probe(page) {
  await page.locator('#connect-form [name="passphrase"]').fill("discard-before-probe");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#host-key-fingerprint")).toHaveText("SHA256:fixture-fingerprint");
}
const count=(page,cmd)=>page.evaluate(cmd=>window.calls.filter(c=>c.cmd===cmd).length,cmd);

test("first host approval authenticates only after pin save, secret re-entry and separate connect",async({page})=>{
  await probe(page);
  await expect(page.locator('#connect-form [name="passphrase"]')).toHaveValue("");
  await expect(page.locator("#host-key-host")).toHaveText("new.invalid");
  await expect(page.locator("#host-key-port")).toHaveText("2222");
  await expect(page.locator("#host-key-algorithm")).toHaveText("ssh-ed25519");
  expect(await count(page,"connect_session")).toBe(0);
  expect(await count(page,"list_remote")).toBe(0);
  const saves=await count(page,"save_settings");
  await page.locator("#host-key-approve").click();
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
  await expect(page.locator(".connection-info")).toContainText("ホスト鍵を保存");
  expect(await count(page,"save_settings")).toBe(saves);
  expect(await count(page,"connect_session")).toBe(0);
  await page.locator('#connect-form [name="passphrase"]').fill("new-ephemeral-secret");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#prepare")).toBeVisible();
  const call=await page.evaluate(()=>window.calls.find(c=>c.cmd==="connect_session"));
  expect(call.args.profile.hostKey).toBe("SHA256:fixture-fingerprint");
  expect(call.args.passphrase).toBe("new-ephemeral-secret");
  expect(await page.evaluate(()=>localStorage.getItem("host-settings"))).not.toContain("ephemeral");
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#prepare")).toBeVisible();
  expect(await count(page,"probe_host_key")).toBe(0);
});

test("cancel and tab changes discard late probe results without authentication",async({page})=>{
  await page.evaluate(()=>window.holdProbe=true);
  await page.locator("#connect-form .primary").click();
  await expect.poll(()=>page.evaluate(()=>!!window.releaseProbe)).toBe(true);
  await page.locator("#add-tab").click();
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
  await expect(page.locator("[data-tab]")).toHaveCount(2);
  await page.evaluate(()=>{window.holdProbe=false;window.releaseProbe();});
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
  await probe(page);
  await page.locator("#host-key-cancel").click();
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
  expect(await count(page,"approve_host_key")).toBe(0);
  expect(await count(page,"connect_session")).toBe(0);
  expect(await count(page,"cancel_host_key")).toBeGreaterThanOrEqual(2);
});

test("candidate expiration is dismissible and an explicit approval commit cannot be cancelled",async({page})=>{
  await page.evaluate(()=>window.shortExpiry=true);
  await probe(page);
  await expect(page.locator("#host-key-approve")).toBeDisabled({timeout:3000});
  await expect(page.locator("#host-key-cancel")).toBeEnabled();
  await page.locator("#host-key-cancel").click();
  await page.evaluate(()=>{window.shortExpiry=false;window.holdApproval=true;});
  await probe(page);
  await page.locator("#host-key-approve").click();
  await expect.poll(()=>page.evaluate(()=>!!window.releaseApproval)).toBe(true);
  await expect(page.locator("#host-key-cancel")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#host-key-overlay")).toBeVisible();
  await page.locator("#add-tab").click();
  await expect(page.locator("[data-tab]")).toHaveCount(1);
  await page.evaluate(()=>{window.holdApproval=false;window.releaseApproval();});
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
  expect(await count(page,"approve_host_key")).toBe(1);
  expect(await count(page,"connect_session")).toBe(0);
});

test("approval failure never retries a consumed token and explicit reload recovers a confirmed native pin",async({page})=>{
  await page.evaluate(()=>{window.unhandledApproval=[];window.addEventListener("unhandledrejection",event=>{window.unhandledApproval.push(String(event.reason));event.preventDefault();});});
  await page.evaluate(()=>{window.failApproval=true;window.partialApproval=true;});
  await probe(page);
  await page.locator("#host-key-approve").click();
  await expect(page.locator("#host-key-overlay .form-error")).toContainText("approval outcome");
  await page.waitForTimeout(100);
  expect(await page.evaluate(()=>window.unhandledApproval)).toEqual([]);
  await expect(page.locator("#host-key-approve")).toBeDisabled();
  await page.locator("#host-key-reload").click();
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
  await expect(page.locator(".connection-info")).toContainText("ホスト鍵を保存");
  expect(await count(page,"approve_host_key")).toBe(1);
  expect(await count(page,"connect_session")).toBe(0);
});

test("an existing mismatched pin does not expose first-use approval",async({page})=>{
  await page.evaluate(()=>{
    const saved=JSON.parse(localStorage.getItem("host-settings"));saved.profiles[0].hostKey="SHA256:previous-key";localStorage.setItem("host-settings",JSON.stringify(saved));
  });
  await page.reload();
  await page.evaluate(()=>window.mismatch=true);
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form .form-error")).toContainText("host key mismatch");
  expect(await count(page,"probe_host_key")).toBe(0);
  await expect(page.locator("#host-key-overlay")).toHaveCount(0);
});

test("host approval details remain readable in narrow light and dark windows",async({page})=>{
  await page.setViewportSize({width:800,height:650});
  for(const theme of ["light","dark"]) {
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await page.locator("#settings-close").click();
    await probe(page);
    await expect(page.locator("#host-key-approve")).toBeInViewport({ratio:1});
    await expect(page.locator("#host-key-fingerprint")).toBeInViewport({ratio:1});
    await page.screenshot({path:`test-results/host-key-${theme}-800.png`});
    await page.locator("#host-key-cancel").click();
  }
});
