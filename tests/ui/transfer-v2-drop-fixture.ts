import { test, expect } from "@playwright/test";
test.use({ deviceScaleFactor: 2 });
export async function setup(page, mode = "sftp", connect = true, language = "en") {
  await page.addInitScript(
    ({ mode, language }) => {
      window.calls = [];
      window.holdPrepare = false;
      window.holdRun = false;
      const entries = [
        { name: "folder", dir: true, size: 0 },
        { name: "one.txt", dir: false, size: 1 },
        { name: "two.txt", dir: false, size: 2 },
      ];
      const profile = {
        id: "a",
        name: "Fixture",
        host: "fixture.invalid",
        port: 22,
        user: "test",
        mode,
        auth: "key",
        hostKey: "pin",
      };
      window.__TAURI__ = {
        event: { listen: async (name, fn) => { if(name === 'native-file-drop') window.nativeDrop = fn; return () => {}; } },
        webview: {
          getCurrentWebview: () => ({
            onDragDropEvent: async (fn) => {
              window.nativeDrop = fn;
              return () => {};
            },
          }),
        },
        core: {
          invoke: async (cmd, args) => {
            window.calls.push({ cmd, args });
            if (cmd === "load_settings")
              return {
                version: 1,
                language,
                profiles: [profile],
                history: {},
              };
            if (cmd === "save_settings") return 2;
            if (cmd === "default_folder") return "C:\\fixture";
            if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
            if (cmd === "connect_session") return { path: "/", entries };
            if (
              cmd === "list_remote" &&
              window.recreated &&
              args.path === "/folder/nested"
            )
              return [{ name: "fresh.txt", dir: false, size: 1 }];
            if (cmd === "list_local" || cmd === "list_remote") return entries;
            if (cmd === "prepare_file_operation" && window.holdPrepare)
              await new Promise((r) => (window.releasePrepare = r));
            if (cmd === "run_upload") {
              if (window.simulateRecreate) window.recreated = true;
              if (window.holdRun)
                await new Promise((r) => (window.releaseRun = r));
              return {
                status: window.uploadStatus || "completed",
                completed: 1,
                bytes: 1,
                message: window.uploadMessage || "done",
              };
            }
          },
        },
      };
    },
    { mode, language },
  );
  await page.goto("/");
  if (!connect) return;
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
export async function nativeDrop(
  page,
  selector = "[data-list=remote] [data-name=folder]",
  paths = ["C:\\external.txt"],
) {
  const box = await page.locator(selector).first().boundingBox();
  await page.evaluate(
    ({ box, paths }) =>
      window.nativeDrop({
        payload: {
          type: "drop", ownOutbound: false,
          paths,
          position: {
            x: (box.x + 10) * devicePixelRatio,
            y: (box.y + box.height / 2) * devicePixelRatio,
          },
        },
      }),
    { box, paths },
  );
}