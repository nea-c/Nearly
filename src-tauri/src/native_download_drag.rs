//! Metadata and streams use a worker connection; the interactive OLE loop runs on Tauri's UI STA.
use crate::{
    sftp::Connection,
    transfer_io::RemoteEntry,
    upload::{UploadOutcome, UploadStatus},
    virtual_files::{DeferredFiles, Reader, VirtualEntry, VirtualFiles},
};
use std::{
    collections::HashMap,
    net::ToSocketAddrs,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{implement, BOOL, HRESULT},
    Win32::{
        Foundation::*,
        System::{Ole::*, SystemServices::MODIFIERKEYS_FLAGS},
        UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
    },
};
struct Runtime {
    connection: Connection,
    _lease: Option<crate::sessions::Lease>,
}
pub(crate) struct RemoteReader {
    runtime: Mutex<Option<Runtime>>,
    entries: Vec<RemoteEntry>,
    stop: Arc<AtomicBool>,
    pub bytes: AtomicU64,
    coverage: Mutex<HashMap<usize, Vec<(u64, u64)>>>,
    last_activity: Mutex<Instant>,
    error: Mutex<Option<String>>,
}
impl RemoteReader {
    pub fn new(
        connection: Connection,
        entries: Vec<RemoteEntry>,
        stop: Arc<AtomicBool>,
        lease: Option<crate::sessions::Lease>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime: Mutex::new(Some(Runtime {
                connection,
                _lease: lease,
            })),
            entries,
            stop,
            bytes: AtomicU64::new(0),
            coverage: Mutex::new(HashMap::new()),
            last_activity: Mutex::new(Instant::now()),
            error: Mutex::new(None),
        })
    }
    fn record(&self, index: usize, start: u64, end: u64) -> Result<(), String> {
        let mut all = self
            .coverage
            .lock()
            .map_err(|_| "Stream accounting unavailable")?;
        let ranges = all.entry(index).or_default();
        ranges.push((start, end));
        ranges.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for &(a, b) in ranges.iter() {
            if let Some(last) = merged.last_mut() {
                if a <= last.1 {
                    last.1 = last.1.max(b);
                    continue;
                }
            }
            merged.push((a, b));
        }
        if merged.len() > 64 {
            return Err("Too many disjoint stream reads".into());
        }
        *ranges = merged;
        Ok(())
    }
    fn completed(&self) -> usize {
        self.coverage
            .lock()
            .map(|all| {
                all.iter()
                    .filter(|(index, ranges)| {
                        ranges.len() == 1
                            && ranges[0] == (0, self.entries[**index].attrs.size.unwrap_or(0))
                    })
                    .count()
            })
            .unwrap_or(0)
    }
    fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }
    fn completed_bytes(&self) -> u64 {
        self.coverage.lock().map(|all| all.iter().filter_map(|(index, ranges)| {
            let size = self.entries[*index].attrs.size.unwrap_or(0);
            (ranges.len() == 1 && ranges[0] == (0, size)).then_some(size)
        }).sum()).unwrap_or(0)
    }
    fn idle(&self) -> bool {
        self.last_activity
            .lock()
            .map(|last| last.elapsed() > Duration::from_secs(120))
            .unwrap_or(true)
    }
}
impl Reader for RemoteReader {
    fn read_at(
        &self,
        index: usize,
        handle: &mut Option<Vec<u8>>,
        offset: u64,
        length: u32,
    ) -> Result<Vec<u8>, String> {
        crate::file_ops::check(&self.stop)?;
        let entry = self.entries.get(index).ok_or("Invalid virtual source")?;
        if entry.attrs.is_dir() {
            return Err("Directory has no file contents stream".into());
        }
        let size = entry.attrs.size.ok_or("Remote size unavailable")?;
        if let Ok(mut last) = self.last_activity.lock() {
            *last = Instant::now();
        }
        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| "Virtual source unavailable")?;
        let runtime = guard
            .as_ref()
            .ok_or("Virtual source expired or cancelled")?;
        let s = &runtime.connection;
        let result = s.run(&self.stop, async {
            if handle.is_none() {
                let parent = entry.path.rsplit_once('/').unwrap().0;
                crate::sftp::checked_directory(
                    &s.raw,
                    if parent.is_empty() { "/" } else { parent },
                    false,
                )
                .await?;
                crate::transfer_io::unchanged(s, &entry.path, Some(&entry.attrs)).await?;
                let opened = s
                    .raw
                    .open(
                        entry.path.clone(),
                        russh_sftp::protocol::OpenFlags::READ,
                        russh_sftp::protocol::FileAttributes::empty(),
                    )
                    .await
                    .map_err(|_| "Remote stream open failed")?
                    .handle;
                let attrs = s
                    .raw
                    .fstat(opened.clone())
                    .await
                    .map_err(|_| "Remote stream metadata unavailable")?
                    .attrs;
                if !crate::transfer_io::attributes_match(&attrs, &entry.attrs) {
                    let _ = s.raw.close(opened).await;
                    return Err("Remote source changed".into());
                }
                *handle = Some(opened);
            }
            let wanted = (length as u64).min(size.saturating_sub(offset)).min(65536) as u32;
            let data = if wanted == 0 {
                Vec::new()
            } else {
                s.raw
                    .read(handle.as_ref().unwrap().clone(), offset, wanted)
                    .await
                    .map_err(|_| "Remote stream read failed")?
                    .data
            };
            if data.len() > wanted as usize || wanted > 0 && data.is_empty() {
                return Err("Remote source size changed".into());
            }
            self.bytes.fetch_add(data.len() as u64, Ordering::SeqCst);
            self.record(index, offset, offset + data.len() as u64)?;
            if offset + data.len() as u64 >= size {
                crate::transfer_io::unchanged(s, &entry.path, Some(&entry.attrs)).await?;
                let opened = handle.take().unwrap();
                s.raw
                    .close(opened)
                    .await
                    .map_err(|_| "Remote stream close failed")?;
            }
            Ok(data)
        });
        if result.is_err() {
            if let Ok(mut error) = self.error.lock() {
                *error = Some("Remote read failed or source changed. Sources retained.".into());
            }
            guard.take();
        }
        result
    }
    fn close(&self, handle: Vec<u8>) {
        if let Ok(guard) = self.runtime.lock() {
            if let Some(runtime) = guard.as_ref() {
                let _ = runtime.connection.run(&self.stop, async {
                    runtime
                        .connection
                        .raw
                        .close(handle)
                        .await
                        .map(|_| ())
                        .map_err(|_| "Remote stream close failed".into())
                });
            }
        }
    }
    fn finish(&self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.take();
        }
    }
    fn active(&self) -> bool {
        self.runtime.lock().map(|v| v.is_some()).unwrap_or(false)
    }
}
impl Drop for RemoteReader {
    fn drop(&mut self) {
        if let Ok(runtime) = self.runtime.get_mut() {
            runtime.take();
        }
    }
}
fn continue_drag(escape: bool, left_down: bool, cancelled: bool) -> HRESULT {
    if escape || cancelled {
        DRAGDROP_S_CANCEL
    } else if !left_down {
        DRAGDROP_S_DROP
    } else {
        S_OK
    }
}
fn end_status(cancelled: bool, expired: bool, source_error: bool, result: i32) -> UploadStatus {
    if expired {
        UploadStatus::Partial
    } else if cancelled || result == E_ABORT.0 || result == HRESULT_FROM_WIN32_ERROR_CANCELLED {
        UploadStatus::Cancelled
    } else if source_error || result < 0 {
        UploadStatus::Partial
    } else {
        UploadStatus::Completed
    }
}
const HRESULT_FROM_WIN32_ERROR_CANCELLED: i32 = 0x800704c7u32 as i32;
struct MetadataError { message: String, cancelled: bool }
impl MetadataError {
    fn worker(message: String, stopped: bool) -> Self {
        // Errors are currently strings across the SFTP boundary. Only known
        // cancellation diagnostics establish that cleanup caused this failure;
        // a simultaneous real inventory/auth error must remain visible.
        let cancelled = stopped && matches!(message.as_str(),
            "Operation stopped; an already issued final rename may have completed. Restart to reconcile." |
            "Operation stopped; staging may remain and an issued final rename may have completed. Restart to reconcile." |
            "Operation cancelled. A previously issued rename/recycle/delete may have completed; partial copies or deletions may remain. Refresh before retrying.");
        Self { message, cancelled }
    }
}
fn unaccepted_drag_outcome(status: HRESULT, cancelled: bool, metadata: Result<(usize, u64), MetadataError>) -> UploadOutcome {
    let metadata_error = metadata.as_ref().err().filter(|error| !error.cancelled);
    let failed = !cancelled && (status.is_err() || metadata_error.is_some());
    let message = if failed {
        let detail = metadata_error.map(|error| error.message.clone()).unwrap_or_else(|| format!("Windows drag failed (HRESULT 0x{:08X})", status.0 as u32));
        format!("{detail}; remote sources retained. Check Explorer for partial output.")
    } else { "Windows copy cancelled; remote sources retained. Explorer owns any partial output.".into() };
    let (completed, transferred_bytes) = metadata.unwrap_or((0, 0));
    UploadOutcome { status: if failed { UploadStatus::Partial } else { UploadStatus::Cancelled },
        completed, bytes: 0, skipped: 0, transferred_bytes,
        message }
}
struct GestureWatch {
    active: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl GestureWatch {
    fn new(stop: Arc<AtomicBool>, left_down: impl Fn() -> bool + Send + 'static) -> Self {
        let active = Arc::new(AtomicBool::new(true));
        let watching = active.clone();
        let worker = std::thread::spawn(move || {
            while watching.load(Ordering::SeqCst) {
                if !left_down() {
                    stop.store(true, Ordering::SeqCst);
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        Self {
            active,
            worker: Some(worker),
        }
    }
}
impl Drop for GestureWatch {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
#[implement(IDropSource)]
struct CopySource {
    stop: Arc<AtomicBool>,
    authoritative_cancel: Arc<AtomicBool>,
    app: tauri::AppHandle,
    source_label: String,
    internal: Arc<Mutex<Option<DropPosition>>>,
}
impl IDropSource_Impl for CopySource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() { self.authoritative_cancel.store(true, Ordering::SeqCst); }
        if !escape.as_bool() && !self.stop.load(Ordering::SeqCst) && keys.0 & 1 == 0 {
            use tauri::Manager;
            use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetCursorPos, WindowFromPoint, GA_ROOT};
            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) }.is_err() { return DRAGDROP_S_CANCEL; }
            let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
            for (label, window) in self.app.webview_windows() {
                if window.hwnd().ok().map(|h| h.0) != Some(root.0) { continue; }
                // The real physical topmost HWND must match; hidden/occluded app
                // geometry cannot become an internal destination.
                self.authoritative_cancel.store(true, Ordering::SeqCst);
                if label == self.source_label {
                    if let Ok(origin) = window.inner_position() {
                        if let Ok(mut internal) = self.internal.lock() {
                            *internal = Some(DropPosition { x: point.x - origin.x, y: point.y - origin.y });
                        }
                    }
                }
                return DRAGDROP_S_CANCEL;
            }
        }
        continue_drag(
            escape.as_bool(),
            keys.0 & 1 != 0,
            self.stop.load(Ordering::SeqCst),
        )
    }
    fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub session_id: String,
    pub sources: Vec<String>,
}
#[derive(Clone, serde::Serialize)]
pub struct DropPosition { pub x: i32, pub y: i32 }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutcome {
    #[serde(flatten)] pub outcome: UploadOutcome,
    pub internal_position: Option<DropPosition>,
}
static OUTBOUND_ACTIVE: AtomicBool = AtomicBool::new(false);
pub fn outbound_active() -> bool { OUTBOUND_ACTIVE.load(Ordering::SeqCst) }
pub fn tagged_drop(event: &tauri::DragDropEvent) -> Option<serde_json::Value> {
    let own = outbound_active();
    Some(match event {
        tauri::DragDropEvent::Enter { paths, position } => serde_json::json!({"type":"enter","paths":paths,"position":position,"ownOutbound":own}),
        tauri::DragDropEvent::Over { position } => serde_json::json!({"type":"over","position":position,"ownOutbound":own}),
        tauri::DragDropEvent::Drop { paths, position } => serde_json::json!({"type":"drop","paths":paths,"position":position,"ownOutbound":own}),
        tauri::DragDropEvent::Leave => serde_json::json!({"type":"leave","ownOutbound":own}),
        _ => return None,
    })
}
struct OutboundGuard;
impl OutboundGuard {
    fn claim() -> Result<Self, String> {
        OUTBOUND_ACTIVE.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "A native file drag is already active")?;
        Ok(Self)
    }
}
impl Drop for OutboundGuard { fn drop(&mut self) { OUTBOUND_ACTIVE.store(false, Ordering::SeqCst); } }
pub fn run(
    app: tauri::AppHandle,
    source_label: String,
    engine: Arc<crate::engine::Engine>,
    request: Request,
    lease: crate::sessions::Lease,
    stop: Arc<AtomicBool>,
) -> Result<DragOutcome, String> {
    let result = std::thread::Builder::new()
        .name("nearly-download-ole".into())
        .spawn(move || run_sta(app, source_label, engine, request, lease, stop))
        .map_err(|_| "Unable to start Windows drag thread")?
        .join()
        .map_err(|_| "Windows drag worker failed")?;
    result
}
fn run_sta(
    app: tauri::AppHandle,
    source_label: String,
    engine: Arc<crate::engine::Engine>,
    request: Request,
    lease: crate::sessions::Lease,
    stop: Arc<AtomicBool>,
) -> Result<DragOutcome, String> {
    unsafe {
        OleInitialize(None).map_err(|_| "Unable to initialize Windows OLE drag")?;
    }
    struct Ole;
    impl Drop for Ole {
        fn drop(&mut self) {
            unsafe { OleUninitialize() }
        }
    }
    let _ole = Ole;
    if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } >= 0 {
        return Ok(DragOutcome { internal_position: None, outcome: unaccepted_drag_outcome(DRAGDROP_S_CANCEL, true, Ok((0, 0))) });
    }
    let deferred = DeferredFiles::new(stop.clone());
    let metadata = deferred.clone();
    let metadata_stop = stop.clone();
    let metadata_worker = std::thread::Builder::new().name("nearly-drag-metadata".into()).spawn(move || {
        let result = (|| -> Result<Arc<RemoteReader>, String> {
            let profile = lease.profile();
            let endpoints = (profile.host.as_str(), profile.port).to_socket_addrs()
                .map_err(|_| "Cannot resolve drag endpoint")?.collect();
            let (connection, identity) = crate::sftp::connect(profile, lease.secret(), &metadata_stop)?;
            engine.reserve_upload_operation(&request.id, vec![], request.sources.clone(), identity, endpoints)?;
            let entries = connection.run(&metadata_stop,
                crate::transfer_io::remote_inventory(&connection, &request.sources, &metadata_stop))?;
            let descriptors = entries.iter().map(|entry| VirtualEntry {
                relative: entry.relative.clone(), directory: entry.attrs.is_dir(),
                size: if entry.attrs.is_dir() { 0 } else { entry.attrs.size.unwrap_or(0) },
                modified: entry.attrs.mtime,
            }).collect();
            let reader = RemoteReader::new(connection, entries, metadata_stop.clone(), Some(lease));
            let files = VirtualFiles::new(descriptors, reader.clone(), metadata_stop.clone())?;
            metadata.publish(Ok(files));
            Ok(reader)
        })();
        result.map_err(|error| {
            let failure = MetadataError::worker(error.clone(), metadata_stop.load(Ordering::SeqCst));
            metadata.publish(Err(error.clone()));
            failure
        })
    }).map_err(|_| "Unable to start drag metadata worker")?;
    let internal = Arc::new(Mutex::new(None));
    // Interactive capture belongs to the window's UI input queue. A detached
    // STA may enter DoDragDrop without ever receiving its continuation events.
    // Only this modal loop runs on UI; inventory and asynchronous bytes remain
    // off UI, and Tauri resumes its regular pump immediately after the drop.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let ui_files = deferred.clone();
    let ui_internal = internal.clone();
    let ui_app = app.clone();
    let ui_stop = stop.clone();
    let authoritative_cancel = Arc::new(AtomicBool::new(false));
    let ui_cancel = authoritative_cancel.clone();
    let scheduled = app.run_on_main_thread(move || {
        let result = (|| -> Result<(HRESULT, DROPEFFECT), String> {
            unsafe {
                OleInitialize(None).map_err(|_| "Unable to initialize UI OLE drag")?;
            }
            let _ui_ole = Ole;
            if ui_stop.load(Ordering::SeqCst)
                || unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } >= 0
            {
                return Ok((DRAGDROP_S_CANCEL, DROPEFFECT_NONE));
            }
            let _outbound = OutboundGuard::claim()?;
            let object = ui_files
                .object()
                .map_err(|_| "Unable to create Windows virtual file source")?;
            let source: IDropSource = CopySource { stop: ui_stop, authoritative_cancel: ui_cancel, app: ui_app, source_label, internal: ui_internal }.into();
            let mut effect = DROPEFFECT_NONE;
            let status = unsafe { DoDragDrop(&object, &source, DROPEFFECT_COPY, &mut effect) };
            Ok((status, effect))
        })();
        let _ = sender.send(result);
    });
    let result = scheduled.map_err(|_| "Unable to schedule Windows drag on its UI thread".to_owned())
        .and_then(|_| receiver.recv().map_err(|_| "Windows UI drag did not return".to_owned()))
        .and_then(|result| result);
    let (status, effect) = match result {
        Ok(result) => result,
        Err(error) => {
            stop.store(true, Ordering::SeqCst);
            let _ = metadata_worker.join();
            if let Some(files) = deferred.peek() { files.finish(); }
            return Err(error);
        }
    };
    if status.is_err() || status == DRAGDROP_S_CANCEL || effect != DROPEFFECT_COPY {
        // Snapshot cancellation before cleanup. A provider deadline is a failure,
        // and cleanup can make an otherwise healthy pending worker report cancel.
        let cancelled = authoritative_cancel.load(Ordering::SeqCst)
            || (stop.load(Ordering::SeqCst) && !deferred.timed_out());
        stop.store(true, Ordering::SeqCst);
        let metadata = metadata_worker.join().unwrap_or_else(|_| Err(MetadataError { message: "Drag metadata worker failed".into(), cancelled: false }));
        if let Some(files) = deferred.peek() { files.finish(); }
        let internal_position = internal.lock().ok().and_then(|p| p.clone());
        let metadata = if deferred.timed_out() {
            Err(MetadataError { message: "Drag metadata timed out".into(), cancelled: false })
        } else { metadata.map(|reader| (reader.completed(), reader.bytes.load(Ordering::SeqCst))) };
        return Ok(DragOutcome { internal_position, outcome: unaccepted_drag_outcome(status, cancelled, metadata) });
    }
    let reader = match metadata_worker.join().map_err(|_| "Drag metadata worker failed")? {
        Ok(reader) => reader,
        Err(error) => return Ok(DragOutcome { internal_position: None, outcome: unaccepted_drag_outcome(status,
            authoritative_cancel.load(Ordering::SeqCst) || (stop.load(Ordering::SeqCst) && !deferred.timed_out()), Err(error)) }),
    };
    let files = deferred.get().map_err(|_| "Drag metadata unavailable")?;
    let expired = wait_for_extraction(&files, &stop, || reader.error().is_some(), || reader.idle());
    let mut final_status = end_status(stop.load(Ordering::SeqCst), expired,
        reader.error().is_some(), files.end_result.load(Ordering::SeqCst));
    if final_status == UploadStatus::Completed && reader.completed() != files.entries.iter().filter(|entry| !entry.directory).count() {
        final_status = UploadStatus::Partial;
    }
    files.finish();
    let message = match final_status {
        UploadStatus::Completed => "Windows reports the copy finished; remote sources retained. Explorer manages destination conflicts and partial output.",
        UploadStatus::Cancelled => "Windows copy cancelled; remote sources retained. Explorer owns any partial output.",
        UploadStatus::Partial => "Windows did not complete the copy or timed out; remote sources retained. Check Explorer.",
    };
    Ok(DragOutcome { internal_position: None, outcome: UploadOutcome {
        status: final_status, completed: reader.completed(), bytes: reader.completed_bytes(),
        skipped: 0, transferred_bytes: reader.bytes.load(Ordering::SeqCst), message: message.into(),
    }})
}

fn wait_for_extraction(
    files: &VirtualFiles,
    stop: &AtomicBool,
    mut failed: impl FnMut() -> bool,
    mut idle: impl FnMut() -> bool,
) -> bool {
    let started = Instant::now();
    while files.in_operation.load(Ordering::SeqCst) && !failed() && !stop.load(Ordering::SeqCst) {
        if idle() || started.elapsed() > Duration::from_secs(24 * 60 * 60) {
            stop.store(true, Ordering::SeqCst);
            return true;
        }
        // DoDragDrop's modal loop has returned. Keep this private OLE STA
        // dispatching through asynchronous extraction and cancellation.
        // A bounded batch prevents a busy queue from starving deadline checks.
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, WM_QUIT,
        };
        let mut message = MSG::default();
        for _ in 0..32 {
            if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                break;
            }
            if message.message == WM_QUIT {
                stop.store(true, Ordering::SeqCst);
                break;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}
#[cfg(test)]
#[path = "native_drag_marshalling_tests.rs"]
mod marshalling_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_failure_remains_visible_when_ole_cancels_without_copy() {
        for result in [DRAGDROP_S_CANCEL, S_OK] {
            let outcome = unaccepted_drag_outcome(result, false, Err(MetadataError::worker("Remote directory read failed".into(), true)));
            assert_eq!(outcome.status, UploadStatus::Partial);
            assert!(outcome.message.contains("Remote directory read failed"));
        }
    }
    #[test]
    fn metadata_failure_caused_by_authoritative_or_cleanup_cancellation_stays_cancelled() {
        for authoritative in [false, true] {
            let outcome = unaccepted_drag_outcome(DRAGDROP_S_CANCEL, authoritative, Err(MetadataError::worker("Operation stopped; staging may remain and an issued final rename may have completed. Restart to reconcile.".into(), true)));
            assert_eq!(outcome.status, UploadStatus::Cancelled);
        }
        let own_return = unaccepted_drag_outcome(DRAGDROP_S_CANCEL, true, Err(MetadataError { message: "Remote directory read failed".into(), cancelled: false }));
        assert_eq!(own_return.status, UploadStatus::Cancelled);
    }
    #[test]
    fn active_state_snapshot_survives_renderer_delay_but_is_only_defense_in_depth() {
        let event = tauri::DragDropEvent::Drop { paths: vec![std::path::PathBuf::from("fixture.txt")], position: tauri::PhysicalPosition::new(1.0, 2.0) };
        let guard = OutboundGuard::claim().unwrap();
        let queued = tagged_drop(&event).unwrap();
        assert!(OutboundGuard::claim().is_err(), "only one outgoing OLE gesture can own input");
        drop(guard);
        assert_eq!(queued["ownOutbound"], true, "renderer delivery does not reclassify a captured active state");
        assert_eq!(tagged_drop(&event).unwrap()["ownOutbound"], false);
    }
    #[test]
    fn copy_drag_stops_on_escape_cancel_and_button_release() {
        assert_eq!(
            continue_drag(false, true, false),
            windows::Win32::Foundation::S_OK
        );
        assert_eq!(
            continue_drag(false, false, false),
            windows::Win32::Foundation::DRAGDROP_S_DROP
        );
        assert_eq!(
            continue_drag(true, true, false),
            windows::Win32::Foundation::DRAGDROP_S_CANCEL
        );
        assert_eq!(
            continue_drag(false, true, true),
            windows::Win32::Foundation::DRAGDROP_S_CANCEL
        );
    }
    #[test]
    fn asynchronous_cancel_is_separate_from_failed_or_expired_copy() {
        use windows::Win32::Foundation::{E_ABORT, E_FAIL, S_OK};
        assert_eq!(
            end_status(false, false, false, S_OK.0),
            UploadStatus::Completed
        );
        assert_eq!(
            end_status(false, false, false, E_ABORT.0),
            UploadStatus::Cancelled
        );
        assert_eq!(
            end_status(false, false, false, E_FAIL.0),
            UploadStatus::Partial
        );
        assert_eq!(
            end_status(true, false, false, S_OK.0),
            UploadStatus::Cancelled
        );
        assert_eq!(end_status(true, true, false, S_OK.0), UploadStatus::Partial);
    }
    #[test]
    fn releasing_button_during_metadata_cancels_but_handoff_disarms_watcher() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        use std::time::{Duration, Instant};
        let stop = Arc::new(AtomicBool::new(false));
        let down = Arc::new(AtomicBool::new(true));
        let state = down.clone();
        let watcher = GestureWatch::new(stop.clone(), move || state.load(Ordering::SeqCst));
        down.store(false, Ordering::SeqCst);
        let start = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            assert!(start.elapsed() < Duration::from_secs(1));
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(watcher);
        let stop = Arc::new(AtomicBool::new(false));
        let down = Arc::new(AtomicBool::new(true));
        let state = down.clone();
        let watcher = GestureWatch::new(stop.clone(), move || state.load(Ordering::SeqCst));
        drop(watcher);
        down.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(30));
        assert!(!stop.load(Ordering::SeqCst));
    }
    #[test]
    #[ignore = "generated localhost fixture runner only"]
    fn generated_transfer_virtual_remote_streams_and_explicit_release() {
        use crate::virtual_files::{Reader, VirtualEntry, VirtualFiles};
        use std::{
            fs,
            path::PathBuf,
            sync::{
                atomic::{AtomicBool, Ordering},
                Arc,
            },
        };
        use windows::{
            core::Interface,
            Win32::{
                System::{
                    Com::*,
                    DataExchange::RegisterClipboardFormatW,
                    Ole::{OleInitialize, OleUninitialize, ReleaseStgMedium},
                },
                UI::Shell::*,
            },
        };
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe { OleUninitialize() }
            }
        }
        unsafe { OleInitialize(None).unwrap() };
        let _com = Com;
        let v: serde_json::Value = serde_json::from_slice(
            &fs::read(std::env::var("NEARLY_TRANSFER_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(v["generatedOnly"], true);
        let root = PathBuf::from(v["root"].as_str().unwrap());
        assert!(root.starts_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("test-results")
        ));
        let remote = root.join("remote");
        let bytes = b"virtual actual remote bytes";
        fs::create_dir_all(remote.join("virtual-source/empty")).unwrap();
        fs::write(remote.join("virtual-source/one.txt"), bytes).unwrap();
        let profile = crate::sftp::Profile {
            id: "virtual-fixture".into(),
            name: "Generated localhost".into(),
            host: "127.0.0.1".into(),
            port: v["port"].as_u64().unwrap() as u16,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: v["key"].as_str().unwrap().into(),
            host_key: v["fingerprint"].as_str().unwrap().into(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let (connection, _) =
            crate::sftp::connect(&profile, v["passphrase"].as_str().unwrap(), &stop).unwrap();
        let entries = connection
            .run(
                &stop,
                crate::transfer_io::remote_inventory(
                    &connection,
                    &["/virtual-source".into()],
                    &stop,
                ),
            )
            .unwrap();
        let index = entries
            .iter()
            .position(|e| e.relative.ends_with("/one.txt"))
            .unwrap();
        let metadata = entries
            .iter()
            .map(|e| VirtualEntry {
                relative: e.relative.clone(),
                directory: e.attrs.is_dir(),
                size: if e.attrs.is_dir() {
                    0
                } else {
                    e.attrs.size.unwrap()
                },
                modified: e.attrs.mtime,
            })
            .collect();
        let reader = RemoteReader::new(connection, entries, stop.clone(), None);
        let files = VirtualFiles::new(metadata, reader.clone(), stop.clone()).unwrap();
        let object = files.object().unwrap();
        let format = FORMATETC {
            cfFormat: unsafe { RegisterClipboardFormatW(CFSTR_FILECONTENTS) } as u16,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index as i32,
            tymed: TYMED_ISTREAM.0 as u32,
            ..Default::default()
        };
        let mut medium = unsafe { object.GetData(&format).unwrap() };
        let stream = unsafe { (&*medium.u.pstm).as_ref().unwrap().clone() };
        unsafe { ReleaseStgMedium(&mut medium) };
        assert_eq!(reader.bytes.load(Ordering::SeqCst), 0);
        let mut data = vec![0u8; 1024];
        let mut n = 0;
        unsafe {
            stream
                .Read(data.as_mut_ptr().cast(), 1024, Some(&mut n))
                .ok()
                .unwrap()
        };
        assert_eq!(&data[..n as usize], bytes);
        assert_eq!(reader.bytes.load(Ordering::SeqCst), bytes.len() as u64);
        assert!(reader.active());
        let asynchronous = object.cast::<IDataObjectAsyncCapability>().unwrap();
        unsafe {
            asynchronous.StartOperation(None::<&IBindCtx>).unwrap();
            asynchronous
                .EndOperation(windows::Win32::Foundation::S_OK, None::<&IBindCtx>, 1)
                .unwrap()
        };
        assert!(!reader.active());
        unsafe { stream.Seek(0, STREAM_SEEK_SET, None).unwrap() };
        assert!(unsafe { stream.Read(data.as_mut_ptr().cast(), 1, Some(&mut n)) }.is_err());
        assert_eq!(
            fs::read(remote.join("virtual-source/one.txt")).unwrap(),
            bytes
        );
    }
}
