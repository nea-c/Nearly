import { invoke, type TextDocument } from "./api.js";
import { getLanguage, setLanguage, tError } from "./i18n.js";
import "./editor-window.css";
import {syntaxEditor} from './editor-syntax.js';
import {renderBreadcrumb} from './editor-breadcrumb.js';
const words = (ja: string, en: string) => (getLanguage() === "ja" ? ja : en);
type Tab = {
  document: TextDocument;
  panel: HTMLElement;
  item: HTMLElement;
  button: HTMLButtonElement;
  input: HTMLTextAreaElement;
  status: HTMLElement;
  busy: boolean;
  dirty: boolean;
  operation?: string;
  update: () => void;
  format: HTMLElement;
  cancel: HTMLButtonElement;
  save: () => Promise<void>;
  syntax: ReturnType<typeof syntaxEditor>;
};

export async function mountTextEditorWindow(root: HTMLElement) {
  const shell = document.createElement("section");
  shell.className = "editor-shell";
  const activePath = document.createElement("code");
  activePath.className = "editor-active-path text-editor-path";
  activePath.tabIndex = 0;
  activePath.hidden = true;
  const tabs = document.createElement("nav");
  tabs.className = "editor-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", words("ファイル", "Files"));
  const content = document.createElement("div");
  content.className = "editor-content";
  const globalStatus = document.createElement("p");
  globalStatus.className = "editor-global-status";
  globalStatus.setAttribute("role", "status");
  const footer = document.createElement("footer");
  footer.className = "editor-footer";
  const messages = document.createElement("div");
  messages.className = "editor-messages";
  const statusSlot = document.createElement("div");
  statusSlot.className = "editor-document-status";
  messages.append(globalStatus, statusSlot);
  const controls = document.createElement("div");
  controls.className = "editor-footer-controls";
  const cancelSlot = document.createElement("div");
  const formatSlot = document.createElement("div");
  formatSlot.className = "editor-format-slot";
  controls.append(cancelSlot, formatSlot);
  footer.append(messages, controls);
  shell.append(tabs, activePath, content, footer);
  root.append(shell);
  const documents = new Map<string, Tab>();
  const closedTokens = new Set<string>();
  let active: string | undefined;
  let closing = false;
  let confirming = false;
  let originRequest: string | undefined;
  let cancelConfirmation: (() => void) | undefined;
  const closingTabs = new Set<string>();
  let refreshTail = Promise.resolve();
  const activate = (token: string) => {
    if (confirming || !documents.has(token)) return;
    active = token;
    for (const [key, tab] of documents) {
      tab.panel.hidden = key !== token;
      tab.item.classList.toggle("active", key === token);
      tab.button.setAttribute("aria-selected", String(key === token));
      tab.button.tabIndex = key === token ? 0 : -1;
    }
    const tab = documents.get(token)!;
    activePath.hidden = false;
    renderBreadcrumb(activePath, tab.document.path, tab.document.side,
      tab.document.connectionLabel || words('ローカル', 'Local'), tab.button.title);
    statusSlot.replaceChildren(tab.status);
    formatSlot.replaceChildren(tab.format);
    cancelSlot.replaceChildren(tab.cancel);
    tab.syntax.activate();
    tab.input.focus();
  };
  const confirmDiscard = async (tab: Tab) => {
    const previousFocus = document.activeElement;
    confirming = true;
    for (const part of [activePath, tabs, content, footer]) part.inert = true;
    const prompt = document.createElement("div");
    prompt.className = "text-editor-discard";
    prompt.setAttribute("role", "alertdialog");
    prompt.setAttribute("aria-modal", "true");
    const message = document.createElement("p");
    message.textContent =
      words(
        "未保存の変更を破棄して閉じますか？",
        "Discard unsaved changes and close?",
      ) +
      " " +
      tab.document.path;
    const keep = document.createElement("button");
    keep.dataset.editorKeep = "";
    keep.textContent = words("編集を続ける", "Keep editing");
    const discard = document.createElement("button");
    discard.dataset.editorDiscard = "";
    discard.className = "danger";
    discard.textContent = words("破棄して閉じる", "Discard and close");
    prompt.append(message, keep, discard);
    shell.append(prompt);
    keep.focus();
    const result = await new Promise<boolean>((resolve) => {
      cancelConfirmation = () => resolve(false);
      keep.onclick = () => resolve(false);
      discard.onclick = () => resolve(true);
    });
    cancelConfirmation = undefined;
    prompt.remove();
    confirming = false;
    for (const part of [activePath, tabs, content, footer]) part.inert = false;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus();
    return result;
  };
  const closeTab = async (token: string, discardConfirmed = false) => {
    if (confirming || closingTabs.has(token)) return false;
    const tab = documents.get(token);
    if (!tab) return true;
    if (tab.busy) return false;
    closingTabs.add(token);
    try {
      if (tab.dirty && !discardConfirmed && !(await confirmDiscard(tab))) return false;
      try {
        await invoke("close_text_document", { token });
      } catch (e) {
        tab.status.textContent = tError(e);
        return false;
      }
      closedTokens.add(token);
      documents.delete(token);
      tab.syntax.dispose();
      tab.panel.remove();
      tab.item.remove();
      if (active === token) {
        active = undefined;
        const next = documents.keys().next().value;
        if (next) activate(next);
        else {
          activePath.hidden = true;
          activePath.textContent = "";
          activePath.title = "";
          statusSlot.replaceChildren();
          formatSlot.replaceChildren();
          cancelSlot.replaceChildren();
        }
      }
      return true;
    } finally {
      closingTabs.delete(token);
    }
  };
  const closeAll = async () => {
    if (closing || confirming) return;
    closing = true;
    try {
      if ([...documents.values()].some((t) => t.busy)) {
        globalStatus.dataset.reason = "busy";
        globalStatus.textContent = words(
          "処理が終わるか中止してから閉じてください",
          "Finish or cancel the active operation before closing",
        );
        return;
      }
      for (const token of [...documents.keys()])
        if (!(await closeTab(token))) return;
      await invoke("close_text_editor_window");
    } catch (e) {
      globalStatus.dataset.reason = "error";
      globalStatus.textContent = tError(e);
    } finally {
      closing = false;
    }
  };
  const closeOrigin = async (tokens: string[], valid: () => boolean) => {
    if (closing || confirming || tokens.some(token => closingTabs.has(token))) return false;
    const selected = active;
    const scoped = tokens.map(token => documents.get(token)).filter((tab): tab is Tab => !!tab);
    if (scoped.some(tab => tab.busy)) {
      globalStatus.dataset.reason = "busy";
      globalStatus.textContent = words("処理が終わるか中止してから接続を閉じてください", "Finish or cancel the active operation before closing the connection");
      return false;
    }
    closing = true;
    try {
      // Obtain every discard decision before removing any document. Keep editing
      // leaves all buffers and the previously selected tab intact.
      for (const tab of scoped) {
        if (tab.dirty && !(await confirmDiscard(tab))) return false;
      }
      if (!valid()) return false;
      for (const part of [activePath, tabs, content, footer]) part.inert = true;
      for (const token of tokens) if (!(await closeTab(token, true))) return false;
      return true;
    } finally {
      closing = false;
      for (const part of [activePath, tabs, content, footer]) part.inert = false;
      if (selected && documents.has(selected)) activate(selected);
    }
  };
  const add = (doc: TextDocument) => {
    if (closedTokens.has(doc.token) || documents.has(doc.token)) return;
    const name = doc.path.split(/[\\/]/).pop() ?? doc.path;
    const item = document.createElement("div");
    item.className = "editor-tab";
    const button = document.createElement("button");
    button.className = "editor-tab-label";
    button.setAttribute("role", "tab");
    button.id = "editor-tab-" + doc.token;
    button.setAttribute("aria-controls", "editor-panel-" + doc.token);
    button.title =
      (doc.connectionLabel ? doc.connectionLabel + " · " : "") + doc.path;
    const label = document.createElement("span");
    label.className = "editor-tab-name";
    label.textContent = name;
    const mark = document.createElement("span");
    mark.className = "editor-tab-dirty";
    mark.textContent = "●";
    mark.setAttribute("aria-hidden", "true");
    button.append(label);
    button.onclick = () => activate(doc.token);
    const cross = document.createElement("button");
    cross.className = "editor-tab-close";
    cross.dataset.editorTabClose = "";
    const crossGlyph = document.createElement('span');
    crossGlyph.className = 'editor-tab-cross';
    crossGlyph.textContent = '×';
    crossGlyph.setAttribute('aria-hidden', 'true');
    cross.append(mark, crossGlyph);
    cross.title = words("タブを閉じる", "Close tab");
    cross.setAttribute("aria-label", words("閉じる: ", "Close: ") + name);
    cross.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!closing) void closeTab(doc.token);
    };
    item.append(button, cross);
    tabs.append(item);
    const panel = document.createElement("section");
    panel.className = "text-editor";
    panel.setAttribute("role", "tabpanel");
    panel.hidden = true;
    const format = document.createElement("div");
    format.className = "text-editor-format";
    format.textContent = doc.encoding + " · " + doc.newline;
    const input = document.createElement("textarea");
    input.value = doc.text;
    input.spellcheck = false;
    input.wrap = "off";
    input.maxLength = 1048576;
    input.setAttribute("aria-label", words("ファイルの内容", "File content"));
    const status = document.createElement("p");
    status.className = "text-editor-status";
    status.setAttribute("role", "status");
    status.textContent =
      doc.readOnly ??
      words("明示的な保存で元のファイルを更新します", "Ctrl+S to save");
    const cancel = document.createElement("button");
    cancel.dataset.editorCancel = "";
    cancel.textContent = words("処理を中止", "Cancel operation");
    const syntax=syntaxEditor(input,doc.path,(language,plain)=>{
      format.textContent=doc.encoding+' · '+doc.newline+' · '+(plain?words('テキスト','Plain text'):language);
    });
    panel.append(syntax.root);
    content.append(panel);
    panel.id = "editor-panel-" + doc.token;
    panel.setAttribute("aria-labelledby", button.id);
    const tab: Tab = {
      document: doc,
      panel,
      item,
      button,
      input,
      status,
      format,
      cancel,
      syntax,
      save: async () => {},
      busy: false,
      dirty: false,
      update: () => {},
    };
    documents.set(doc.token, tab);
    tab.update = () => {
      if (
        globalStatus.dataset.reason === "busy" &&
        ![...documents.values()].some((t) => t.busy)
      ) {
        globalStatus.textContent = "";
        delete globalStatus.dataset.reason;
      }
      item.dataset.dirty = String(tab.dirty);
      cross.setAttribute('aria-label', words('閉じる: ', 'Close: ') + name + (tab.dirty ? words('（未保存）', ' (unsaved)') : ''));
      button.setAttribute(
        "aria-label",
        name + (tab.dirty ? words("（未保存）", " (unsaved)") : ""),
      );
      panel.dataset.dirty = String(tab.dirty);
      panel.dataset.busy = String(tab.busy);
      input.disabled = tab.busy;
      input.readOnly = !!doc.readOnly;
      cross.disabled = tab.busy;
      cancel.hidden = !tab.busy;
    };
    input.oninput = () => {
      tab.dirty = input.value !== doc.text;
      tab.update();
    };
    cancel.onclick = () => {
      if (tab.operation) {
        cancel.disabled = true;
        void invoke("cancel_file_operation", { id: tab.operation })
          .catch((e) => (status.textContent = tError(e)))
          .finally(() => (cancel.disabled = false));
      }
    };
    tab.save = async () => {
      if (closing || confirming || tab.busy || !tab.dirty || doc.readOnly)
        return;
      tab.busy = true;
      const id = crypto.randomUUID();
      tab.operation = id;
      tab.update();
      try {
        await invoke("prepare_file_operation", { id });
        const result = await invoke("save_text_document", {
          id,
          token: doc.token,
          text: input.value,
        });
        doc.text = result.text;
        input.value = result.text;
        syntax.refresh();
        tab.dirty = false;
        status.textContent = words("保存しました", "Saved");
      } catch (e) {
        status.textContent = tError(e);
        await invoke("cancel_file_operation", { id, abandon: true }).catch(
          () => {},
        );
      } finally {
        tab.busy = false;
        tab.operation = undefined;
        tab.update();
      }
    };
    tab.update();
  };
  const refresh = (focus?: string) => {
    refreshTail = refreshTail.then(async () => {
      try {
        const list = await invoke("list_text_documents");
        for (const doc of list) add(doc);
        if (focus && documents.has(focus)) activate(focus);
        else if (!active && documents.size)
          activate(documents.keys().next().value!);
      } catch (e) {
        globalStatus.textContent = tError(e);
      }
    });
    return refreshTail;
  };
  tabs.onkeydown = (e) => {
    if (
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) ||
      confirming
    )
      return;
    const keys = [...documents.keys()];
    if (!keys.length) return;
    const index = keys.indexOf(active ?? "");
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? keys.length - 1
          : (index + (e.key === "ArrowRight" ? 1 : -1) + keys.length) %
            keys.length;
    const token = keys[next];
    if (token) {
      e.preventDefault();
      activate(token);
      documents.get(token)?.button.focus();
    }
  };
  shell.onkeydown = (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void documents.get(active ?? "")?.save();
    }
  };
  window.addEventListener("beforeunload", (e) => {
    if ([...documents.values()].some((t) => t.dirty || t.busy)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  const events = window.__TAURI__?.event;
  if (events) {
    await events.listen<string>("text-editor-opened", (e) => {
      void refresh(e.payload);
    });
    await events.listen<{requestId:string;tokens:string[]}>("text-editor-origin-close", (e) => {
      void (async () => {
        let accepted = false;
        if (originRequest) { await invoke("resolve_text_editor_origin_close", {requestId:e.payload.requestId, accepted:false}); return; }
        originRequest = e.payload.requestId;
        try { await refresh(); accepted = await closeOrigin(e.payload.tokens, () => originRequest === e.payload.requestId); }
        catch (error) { globalStatus.textContent = tError(error); }
        finally { if (originRequest === e.payload.requestId) originRequest = undefined; await invoke("resolve_text_editor_origin_close", {requestId:e.payload.requestId, accepted}); }
      })();
    });
    await events.listen<string>("text-editor-origin-close-expired", (e) => {
      if (originRequest === e.payload) { originRequest = undefined; cancelConfirmation?.(); }
    });
    await events.listen("text-editor-close", () => {
      void closeAll();
    });
  }
  await refresh();
  return { refresh, closeAll };
}

if (document.body.classList.contains("editor-window")) {
  void (async () => {
    await invoke("register_window");
    const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
    let applying = Promise.resolve();
    const appearance = () => {
      applying = applying
        .then(async () => {
          const settings = await invoke("load_settings");
          setLanguage(settings.language ?? "ja");
          const theme =
            settings.theme === "system"
              ? systemDark
                ? "dark"
                : "light"
              : settings.theme;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme =
            theme === "light" || theme === "mint" ? "light" : "dark";
        })
        .catch((e) => {
          console.error("Editor appearance unavailable", tError(e));
        });
      return applying;
    };
    await window.__TAURI__?.event?.listen("settings-changed", () => {
      void appearance();
    });
    await appearance();
    await mountTextEditorWindow(document.getElementById("editor-root")!);
  })().catch((e) => {
    document.getElementById("editor-root")!.textContent = tError(e);
  });
}
