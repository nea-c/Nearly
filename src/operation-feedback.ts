import { t, getLanguage } from './i18n.js';
import { invoke, type OperationProgress } from './api.js';

/** Shared UI reservation: acquired synchronously before prepare, released after invalidation. */
const reservations = new Set<object>();
const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
const clearTimer = (card: HTMLElement) => { clearTimeout(timers.get(card)); timers.delete(card); };
let observing = false;
export function operationBusy() { return reservations.size > 0; }
export function reserveOperation() {
  if (operationBusy()) throw Error(t('処理中です。'));
  const token = {};
  reservations.add(token);
  window.dispatchEvent(new Event('operation-busy-changed'));
  let released = false;
  return () => {
    if (!released) {
      released = true;
      reservations.delete(token);
      window.dispatchEvent(new Event('operation-busy-changed'));
    }
  };
}

/** Body portal survives app renders. Successful/cancelled notices expire; errors remain. */
export function operationFeedback(
  title: string, results: HTMLElement, cancel: HTMLButtonElement,
  options: { action?: 'copy' | 'move' | 'delete' } = {},
) {
  const release = reserveOperation();
  const words = (ja: string, en: string) => getLanguage() === 'ja' ? ja : en;
  const root = document.getElementById('operation-feedback-root') ?? Object.assign(document.createElement('div'), { id: 'operation-feedback-root' });
  if (!root.isConnected) document.body.append(root);
  if (!observing) {
    observing = true;
    new MutationObserver(() => { for (const card of timers.keys()) if (!card.isConnected) clearTimer(card); })
      .observe(document.body, { childList: true, subtree: true });
  }
  for (const old of Array.from(root.querySelectorAll<HTMLElement>('[data-complete][data-success="true"]')).slice(0, -2)) {
    clearTimer(old); old.remove();
  }
  const card = document.createElement('section');
  card.className = 'operation-feedback'; card.setAttribute('role', 'status');
  const heading = document.createElement('strong'); heading.textContent = title;
  card.append(heading, results, cancel); root.append(card);
  const meter = document.createElement('div'); meter.className = 'operation-progress'; meter.hidden = true;
  const gauge = document.createElement('progress');
  const label = document.createElement('span'); label.className = 'operation-progress-label';
  const selectionLabel = document.createElement('span'); selectionLabel.className = 'operation-selection-label'; selectionLabel.hidden = true;
  meter.append(selectionLabel, gauge, label); heading.after(meter);
  let selection: { done: number; total: number } | undefined;
  let current: OperationProgress | undefined;
  let generation = 0, finished = false, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let activeId: string | undefined, inFlight = false, nextPollAt = 0;
  const selectionText = () => words('全' + selection!.total + '項目中' + selection!.done + '項目完了', selection!.done + ' of ' + selection!.total + ' items completed');
  const selectionGauge = () => options.action === 'delete' && !!selection;
  const renderSelection = () => {
    if (!selection) return;
    meter.hidden = false; selectionLabel.hidden = false;
    selectionLabel.textContent = words('全体: ', 'Overall: ') + selectionText();
    if (selectionGauge()) {
      gauge.max = selection.total;
      if (selection.done < selection.total) gauge.value = selection.done;
      else gauge.removeAttribute('value');
    }
  };
  const updateSelection = (done: number, total: number) => {
    if (finished || !Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(done) || done < 0 || done > total) return;
    if (selection && (selection.total !== total || done < selection.done)) return;
    selection = { done, total }; renderSelection();
    // Copy bytes and overall root counts have independent denominators.
    if (!current) { gauge.hidden = options.action === 'move'; label.textContent = words('準備中', 'Preparing'); }
  };
  const render = (sample: OperationProgress) => {
    if (sample.selectionTotal != null && sample.selectionCompleted != null) updateSelection(sample.selectionCompleted, sample.selectionTotal);
    current = sample; meter.hidden = false; gauge.hidden = options.action === 'move';
    const phase = ({
      uploading: words('アップロード中', 'Uploading'), downloading: words('ダウンロード中', 'Downloading'),
      waiting: words('確認待ち', 'Waiting for confirmation'), connecting: words('接続中', 'Connecting'),
      scanning: words('走査中', 'Scanning'), copying: words('コピー中', 'Copying'), moving: words('移動中', 'Moving'),
      deleting: words('削除中', 'Deleting'), finalizing: words('確定中', 'Finalizing'),
    } as Record<string, string>)[sample.phase] ?? words('準備中', 'Preparing');
    const safe = Number.isSafeInteger(sample.done) && sample.done >= 0 && sample.total !== null &&
      Number.isSafeInteger(sample.total) && sample.total >= sample.done;
    const byteProgress = sample.unit === 'bytes' && options.action !== 'move';
    const determinate = safe && sample.total! > 0 &&
      (['copying', 'deleting', 'uploading', 'downloading', 'finalizing'].includes(sample.phase));
    if (!selectionGauge()) {
      if (!gauge.hidden && determinate) { gauge.max = sample.total!; gauge.value = sample.done; }
      else gauge.removeAttribute('value');
    }
    gauge.setAttribute('aria-label', selectionGauge() ? words('全体の完了項目数', 'Overall completed items') :
      byteProgress ? (selection ? ((sample.groupCount ?? 1) > 1 ? words('現在グループの転送バイト数', 'Current group transferred bytes') : words('現在項目の転送バイト数', 'Current item transferred bytes')) : words('転送バイト数', 'Transferred bytes')) : words('処理件数', 'Processed entries'));
    const amount = safe && options.action !== 'move' ? sample.done.toLocaleString() + ' / ' + sample.total!.toLocaleString() +
      (byteProgress ? ' B' : ' ' + words('件', 'entries')) : '';
    // Same-side selections plan one root at a time. Upload/download plans remain aggregate.
    const scope = selection ? ((sample.groupCount ?? 1) > 1 ? words('現在グループ（' + sample.groupCount + '項目）: ', 'Current group (' + sample.groupCount + ' items): ') : words('現在項目: ', 'Current item: ')) :
      (sample.itemCount > 1 ? words('全体: ', 'Overall: ') : '');
    label.textContent = scope + phase + (amount ? ' · ' + amount : '');
  };
  const schedule = () => {
    if (finished || !activeId || inFlight || pollTimer !== undefined) return;
    pollTimer = setTimeout(() => { pollTimer = undefined; void poll(); }, Math.max(0, nextPollAt - performance.now()));
  };
  const poll = async () => {
    if (finished || !activeId || inFlight) return;
    const id = activeId, token = generation;
    inFlight = true; nextPollAt = performance.now() + 200;
    try {
      const snapshot = await invoke('file_operation_progress', { id });
      if (!finished && token === generation && snapshot) render(snapshot);
    } catch { /* worker may finish between ownership check and polling */ }
    finally { inFlight = false; schedule(); }
  };
  const track = (id: string, initialPhase: 'connecting' | 'scanning' = 'connecting') => {
    if (finished) return;
    activeId = id; ++generation;
    render({ phase: initialPhase, unit: 'bytes', done: 0, total: null, entries: 0, item: 1, itemCount: 1 });
    schedule();
  };
  cancel.disabled = false;
  const remove = () => { clearTimer(card); card.remove(); };
  return {
    track, selectionProgress: updateSelection,
    finish(success: boolean | 'cancelled' = false) {
      finished = true; ++generation; clearTimeout(pollTimer);
      if (selection) {
        if (success === true) selection.done = selection.total;
        renderSelection();
      }
      if (!meter.hidden) {
        // A full byte bar means transferred bytes, never a committed operation.
        // Only this authoritative result may display Completed.
        gauge.hidden = options.action === 'move' || (success !== true && !selectionGauge());
        if (success === true) {
          gauge.max = selectionGauge() ? selection!.total : 1; gauge.value = gauge.max;
          label.textContent = words('完了', 'Completed');
        } else {
          if (selectionGauge() && selection!.done < selection!.total) gauge.value = selection!.done;
          else { gauge.hidden = true; gauge.removeAttribute('value'); }
          label.textContent = words('未完了・結果を確認してください', 'Operation incomplete — inspect results');
        }
      }
      release(); clearTimer(card);
      card.dataset.complete = 'true'; card.dataset.success = String(success === true);
      card.dataset.dismissible = String(success === true || success === 'cancelled');
      cancel.disabled = false; cancel.textContent = t('閉じる'); cancel.dataset.feedbackClose = ''; cancel.onclick = remove;
      if (success === true || success === 'cancelled') timers.set(card, setTimeout(remove, 5000));
    },
    remove() { if (card.dataset.complete !== 'true') return; release(); remove(); },
  };
}
