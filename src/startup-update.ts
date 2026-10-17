import { getLanguage } from './i18n.js';
import './startup-update.css';

export interface StartupUpdateReport {
  state: string;
  latestVersion?: string | null;
  canInstall?: boolean;
  downloadedBytes?: number;
  totalBytes?: number | null;
  errorCode?: string | null;
}
type Command = 'check_startup_update' | 'startup_update_status' | 'prepare_startup_update' | 'cancel_startup_update' | 'dismiss_startup_update' | 'install_startup_update';
const words = (ja: string, en: string) => getLanguage() === 'ja' ? ja : en;
let started = false;
let disposed = false;
let dialog: HTMLDialogElement | undefined;
let timer: number | undefined;
let operation = 0;
let pending = false;
let autoInstallIntent = false;
let report: StartupUpdateReport = { state: 'unavailable' };
let previousFocus: HTMLElement | null = null;
const states = new Set(['checking', 'current', 'upToDate', 'noStableRelease', 'unavailable', 'invalidMetadata', 'alreadyChecked', 'notOwner', 'available', 'signingNotConfigured', 'downloading', 'settling', 'ready', 'installing', 'cancelled', 'error', 'busy']);
function safeReport(value: unknown): StartupUpdateReport {
  if (!value || typeof value !== 'object') return { state: 'unavailable' };
  const item = value as StartupUpdateReport;
  if (!states.has(item.state) || (item.latestVersion != null && typeof item.latestVersion !== 'string') || (item.canInstall !== undefined && typeof item.canInstall !== 'boolean')) return { state: 'unavailable' };
  return item;
}
const call = (command: Command): Promise<unknown> => window.__TAURI__!.core.invoke<unknown>(command);
const active = () => ['downloading', 'settling', 'installing'].includes(report.state);
const silent = (state: string) => ['checking', 'current', 'upToDate', 'noStableRelease', 'unavailable', 'invalidMetadata', 'alreadyChecked', 'notOwner'].includes(state);
function clearPoll() { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; }
function removeDialog() {
  clearPoll();
  dialog?.close(); dialog?.remove(); dialog = undefined;
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}
/** Unload cleanup does not cancel an operation owned by the native process. */
export function disposeStartupUpdate(): void {
  disposed = true; autoInstallIntent = false; operation++; removeDialog();
  window.removeEventListener('pagehide', disposeStartupUpdate);
  localeObserver?.disconnect();
}
let localeObserver: MutationObserver | undefined;
function failureText(): string {
  switch (report.errorCode) {
    case 'invalidSignature': case 'signedVersionMismatch': case 'invalidMetadata':
      return words('更新の検証に失敗しました。インストールは開始されていません。信頼できる配布元に確認してください。', 'Update verification failed. Installation has not started. Check with your trusted distribution source.');
    case 'noCompatibleAsset': case 'incompatibleArchitecture': case 'unsupportedPlatform':
      return words('この環境に対応する更新パッケージがありません。信頼できる配布元を確認してください。', 'No compatible update package is available for this system. Check your trusted distribution source.');
    case 'settingsNotSettled':
      return words('ウィンドウの設定保存が完了しなかったため、更新を停止しました。作業を保存して再試行してください。', 'The update stopped because window settings could not be saved. Save your work and retry.');
    case 'installationNotValidated':
      return words('このビルドでは更新インストールの実機検証が完了していないため、実行できません。', 'Update installation is unavailable until this build completes isolated Windows validation.');
    case 'workInProgress':
      return words('同期、接続、ファイル操作が完了してから更新を再試行してください。', 'Wait for sync, connection, and file operations to finish, then retry the update.');
    case 'installerLaunchFailed':
      return words('インストーラーを起動できませんでした。Nearly は開いたままです。作業を保存してから再試行してください。', 'The installer could not be started. Nearly remains open. Save your work before retrying.');
    case 'settingsRollbackFailed':
      return words('更新を停止しましたが、元の作業状態を復元できませんでした。Nearly を終了せず、作業と設定を確認して保存してください。', 'The update stopped, but the previous workspace state could not be restored. Keep Nearly open, review your work and settings, and save them.');
    case 'updateBusy':
      return words('別の更新処理が実行中です。しばらくしてから再試行してください。', 'Another update operation is running. Wait a moment and retry.');
    case 'stagingFailed': case 'packageTooLarge':
      return words('更新ファイルを準備できませんでした。空き容量とアクセス権を確認して再試行してください。', 'The update files could not be prepared. Check free space and permissions, then retry.');
    default:
      return words('更新を完了できませんでした。接続を確認して再試行してください。', 'The update could not be completed. Check your connection and try again.');
  }
}
function statusText(): string {
  switch (report.state) {
    case 'available': return words('新しい安定版をダウンロードして検証します。インストールが許可されている場合、Nearly を終了して更新します。先に作業を保存してください。', 'Download and verify the new stable release. If installation is permitted, Nearly will close to install it. Save your work before updating.');
    case 'signingNotConfigured': return words('このビルドには更新の署名検証キーが設定されていないため、アプリ内で更新できません。信頼できる配布元から署名済みのインストーラーを入手してください。', 'This build has no trusted update signing key, so in-app updates are unavailable. Obtain a signed installer from your trusted distribution source.');
    case 'downloading': return words('更新をダウンロードして検証しています…', 'Downloading and verifying the update…');
    case 'settling': return words('更新処理の完了を待っています…', 'Waiting for the update operation to finish…');
    case 'ready': return words('更新を検証しました。インストールするとアプリが終了します。作業を保存してから続行してください。', 'The update has been verified. Installing will close the app. Save your work before continuing.');
    case 'installing': return words('インストーラーを起動しています…', 'Starting the installer…');
    case 'busy': return words('別の更新処理が実行中です。しばらくお待ちください。', 'Another update operation is running. Please wait.');
    case 'cancelled': return words('更新をキャンセルしました。再試行するか、後で更新できます。', 'The update was cancelled. You can retry or update later.');
    default: return failureText();
  }
}
function schedulePoll() {
  clearPoll();
  if (!active() || disposed) return;
  timer = window.setTimeout(() => { timer = undefined; void run('startup_update_status'); }, 500);
}
function render() {
  if (disposed) return;
  if (silent(report.state)) { removeDialog(); return; }
  if (!dialog) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog = document.createElement('dialog');
    dialog.id = 'startup-update-dialog'; dialog.className = 'startup-update-dialog';
    dialog.setAttribute('aria-labelledby', 'startup-update-title');
    const title = document.createElement('h2'); title.id = 'startup-update-title';
    const version = document.createElement('p'); version.dataset.updateVersion = '';
    const status = document.createElement('p'); status.dataset.updateStatus = ''; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const progress = document.createElement('progress'); progress.dataset.updateProgress = '';
    const actions = document.createElement('div'); actions.className = 'startup-update-actions';
    const later = document.createElement('button'); later.type = 'button'; later.dataset.updateLater = '';
    const update = document.createElement('button'); update.type = 'button'; update.dataset.updateAction = ''; update.className = 'primary';
    later.onclick = () => { if (pending || report.state === 'installing') return; void run(active() ? 'cancel_startup_update' : 'dismiss_startup_update', !active()); };
    update.onclick = () => {
      if (pending || update.disabled) return;
      autoInstallIntent = report.state !== 'ready';
      void run(report.state === 'ready' ? 'install_startup_update' : 'prepare_startup_update');
    };
    actions.append(later, update); dialog.append(title, version, status, progress, actions); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); later.click(); });
    dialog.showModal(); later.focus();
  }
  dialog.querySelector('h2')!.textContent = words('Nearly の更新', 'Nearly update');
  const version = dialog.querySelector<HTMLElement>('[data-update-version]')!;
  version.textContent = report.latestVersion ? words('新しいバージョン: ', 'New version: ') + report.latestVersion : '';
  version.hidden = !report.latestVersion;
  dialog.querySelector<HTMLElement>('[data-update-status]')!.textContent = statusText();
  const progress = dialog.querySelector<HTMLProgressElement>('progress')!;
  progress.hidden = report.state !== 'downloading'; progress.setAttribute('aria-label', words('ダウンロードの進行状況', 'Download progress'));
  const downloaded = report.downloadedBytes, total = report.totalBytes;
  if (typeof downloaded === 'number' && Number.isFinite(downloaded) && downloaded >= 0 && typeof total === 'number' && Number.isFinite(total) && total > 0) { progress.max = total; progress.value = Math.min(downloaded, total); }
  else progress.removeAttribute('value');
  const later = dialog.querySelector<HTMLButtonElement>('[data-update-later]')!;
  later.textContent = active() ? words('キャンセル', 'Cancel') : words('後で', 'Later');
  later.disabled = (pending && !active()) || report.state === 'installing';
  const update = dialog.querySelector<HTMLButtonElement>('[data-update-action]')!;
  update.textContent = report.state === 'ready' ? words('インストールして終了', 'Install and close') : ['error', 'cancelled', 'busy'].includes(report.state) ? words('再試行', 'Retry') : words('今すぐ更新', 'Update now');
  update.disabled = pending || !['available', 'ready', 'error', 'cancelled', 'busy'].includes(report.state) || (report.state === 'ready' && report.canInstall !== true);
}
async function run(command: Command, dismiss = false) {
  if (disposed || (pending && command !== 'cancel_startup_update')) return;
  if (command === 'cancel_startup_update' || command === 'dismiss_startup_update') autoInstallIntent = false;
  clearPoll(); const ticket = ++operation; pending = true; render();
  try {
    const next = await call(command);
    if (disposed || ticket !== operation) return;
    if (dismiss) { disposeStartupUpdate(); return; }
    report = safeReport(next);
    if (['error', 'busy', 'cancelled', 'signingNotConfigured'].includes(report.state) || silent(report.state)) autoInstallIntent = false;
  } catch (error) {
    if (disposed || ticket !== operation) return;
    autoInstallIntent = false;
    report = command === 'check_startup_update' ? { state: 'unavailable' } : { ...report, state: 'error', canInstall: false, errorCode: typeof error === 'string' ? error : undefined };
  } finally {
    if (!disposed && ticket === operation) {
      pending = false; render();
      if (autoInstallIntent && report.state === 'ready' && report.canInstall === true) {
        autoInstallIntent = false; void run('install_startup_update');
      } else schedulePoll();
    }
  }
}
/** The native startup command elects one window per process; no renderer snooze is persisted. */
export async function initializeStartupUpdate(): Promise<void> {
  if (started || !window.__TAURI__) return;
  started = true; disposed = false;
  window.addEventListener('pagehide', disposeStartupUpdate);
  localeObserver = new MutationObserver(() => { if (dialog) render(); });
  localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  await run('check_startup_update');
}

