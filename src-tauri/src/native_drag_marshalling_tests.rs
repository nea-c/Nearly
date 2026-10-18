//! Real out-of-process COM transport, without desktop input or a remote server.
use super::*;
use std::{
    fs,
    io::Write,
    process::{Child, Command, Stdio},
    sync::atomic::AtomicUsize,
};
use windows::{
    core::Interface,
    Win32::System::{
        Com::{Marshal::*, StructuredStorage::*, *},
        DataExchange::RegisterClipboardFormatW,
    },
    Win32::UI::Shell::*,
};

#[derive(Default)]
struct Bytes {
    reads: AtomicUsize,
    finished: AtomicBool,
}
impl Reader for Bytes {
    fn read_at(
        &self,
        _: usize,
        _: &mut Option<Vec<u8>>,
        offset: u64,
        length: u32,
    ) -> Result<Vec<u8>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let data = b"abcdef";
        Ok(
            data[(offset as usize).min(6)..offset.saturating_add(length as u64).min(6) as usize]
                .to_vec(),
        )
    }
    fn close(&self, _: Vec<u8>) {}
    fn finish(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }
    fn active(&self) -> bool {
        !self.finished.load(Ordering::SeqCst)
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn out_of_process_async_reads_and_end_operation_are_dispatched() {
    unsafe { OleInitialize(None).unwrap() };
    let _apartment = Apartment;
    let root = std::env::temp_dir().join(format!(
        "nearly-com-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let reader = Arc::new(Bytes::default());
    let files = VirtualFiles::new(
        vec![VirtualEntry {
            relative: "one.txt".into(),
            directory: false,
            size: 6,
            modified: Some(1),
        }],
        reader.clone(),
        stop.clone(),
    )
    .unwrap();
    let object = files.object().unwrap();
    unsafe {
        object
            .cast::<IDataObjectAsyncCapability>()
            .unwrap()
            .StartOperation(None::<&IBindCtx>)
            .unwrap();
    }
    let packet = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true).unwrap() };
    unsafe {
        CoMarshalInterface(
            &packet,
            &IDataObject::IID,
            &object,
            MSHCTX_LOCAL.0 as u32,
            None,
            MSHLFLAGS_TABLESTRONG.0 as u32,
        )
        .unwrap();
    }
    let mut stat = STATSTG::default();
    unsafe {
        packet.Stat(&mut stat, STATFLAG_NONAME).unwrap();
        packet.Seek(0, STREAM_SEEK_SET, None).unwrap();
    }
    assert!(stat.cbSize < 65536);
    let mut bytes = vec![0u8; stat.cbSize as usize];
    let mut read = 0;
    unsafe {
        packet
            .Read(
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                Some(&mut read),
            )
            .ok()
            .unwrap();
    }
    assert_eq!(read as usize, bytes.len());
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("object.bin"))
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    let stdout = fs::File::create(root.join("consumer.log")).unwrap();
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "native_download_drag::marshalling_tests::out_of_process_consumer",
                "--nocapture",
            ])
            .env("NEARLY_COM_FIXTURE", &root)
            .stdout(stdout.try_clone().unwrap())
            .stderr(stdout)
            .stdin(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now();
    let expired = wait_for_extraction(
        &files,
        &stop,
        || false,
        || deadline.elapsed() > Duration::from_secs(8),
    );
    let proof = fs::read(root.join("received.bin")).ok();
    let child_deadline = Instant::now();
    let child_status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break Some(status);
        }
        if child_deadline.elapsed() > Duration::from_secs(1) {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Drop only our child before assertion; failed proxies must never linger.
    drop(child);
    let log = fs::read_to_string(root.join("consumer.log")).unwrap_or_default();
    unsafe {
        packet.Seek(0, STREAM_SEEK_SET, None).unwrap();
        let _ = CoReleaseMarshalData(&packet);
    }
    assert!(
        !expired,
        "Out-of-process GetData/Read/EndOperation stalled: {log}"
    );
    assert_eq!(proof.as_deref(), Some(b"abcdef".as_slice()), "{log}");
    assert!(
        child_status.is_some_and(|status| status.success()),
        "Consumer did not exit successfully: {log}"
    );
    assert!(files.ended.load(Ordering::SeqCst));
    assert_eq!(files.end_result.load(Ordering::SeqCst), S_OK.0);
    assert!(reader.finished.load(Ordering::SeqCst));
    assert_eq!(reader.reads.load(Ordering::SeqCst), 1);
    assert!(!stop.load(Ordering::SeqCst));
}

#[test]
fn extraction_wait_dispatches_own_sta_window_messages_and_still_expires() {
    use windows::{
        core::{w, PCWSTR},
        Win32::{System::LibraryLoader::GetModuleHandleW, UI::WindowsAndMessaging::*},
    };
    unsafe extern "system" fn callback(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_APP + 42 {
            unsafe { &*(lparam.0 as *const AtomicBool) }.store(false, Ordering::SeqCst);
            return LRESULT(0);
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
    unsafe { OleInitialize(None).unwrap() };
    let _apartment = Apartment;
    let instance = HINSTANCE(unsafe { GetModuleHandleW(None).unwrap() }.0);
    let name: Vec<u16> = format!("Nearly-Pump-Test-{}", std::process::id())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let class = WNDCLASSW {
        lpfnWndProc: Some(callback),
        hInstance: instance,
        lpszClassName: PCWSTR(name.as_ptr()),
        ..Default::default()
    };
    assert_ne!(unsafe { RegisterClassW(&class) }, 0);
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(name.as_ptr()),
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )
        .unwrap()
    };
    let stop = Arc::new(AtomicBool::new(false));
    let files = VirtualFiles::new(
        vec![VirtualEntry {
            relative: "one.txt".into(),
            directory: false,
            size: 6,
            modified: None,
        }],
        Arc::new(Bytes::default()),
        stop.clone(),
    )
    .unwrap();
    files.in_operation.store(true, Ordering::SeqCst);
    let address = (&files.in_operation as *const AtomicBool) as usize;
    let raw = hwnd.0 as usize;
    let sender = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(40));
        unsafe {
            PostMessageW(
                Some(HWND(raw as *mut _)),
                WM_APP + 42,
                WPARAM(0),
                LPARAM(address as isize),
            )
            .unwrap()
        };
    });
    let start = Instant::now();
    let expired = wait_for_extraction(
        &files,
        &stop,
        || false,
        || start.elapsed() > Duration::from_millis(500),
    );
    sender.join().unwrap();
    unsafe {
        DestroyWindow(hwnd).unwrap();
        UnregisterClassW(PCWSTR(name.as_ptr()), Some(instance)).unwrap();
    }
    assert!(
        !expired,
        "STA messages must be serviced while asynchronous extraction is pending"
    );
    assert!(!stop.load(Ordering::SeqCst));
    files.in_operation.store(true, Ordering::SeqCst);
    let start = Instant::now();
    assert!(wait_for_extraction(
        &files,
        &stop,
        || false,
        || start.elapsed() > Duration::from_millis(30)
    ));
    assert!(stop.load(Ordering::SeqCst));
}

#[test]
#[ignore = "Invoked only by the generated out-of-process COM transport test"]
fn out_of_process_consumer() {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap() };
    let _apartment = Apartment;
    let root = std::path::PathBuf::from(
        std::env::var_os("NEARLY_COM_FIXTURE").expect("Generated COM fixture required"),
    );
    let bytes = fs::read(root.join("object.bin")).unwrap();
    assert!(bytes.len() < 65536);
    let packet = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true).unwrap() };
    let mut written = 0;
    unsafe {
        packet
            .Write(
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                Some(&mut written),
            )
            .ok()
            .unwrap();
        packet.Seek(0, STREAM_SEEK_SET, None).unwrap();
    }
    assert_eq!(written as usize, bytes.len());
    let object: IDataObject = unsafe { CoUnmarshalInterface(&packet).unwrap() };
    std::thread::sleep(Duration::from_millis(50));
    let format = FORMATETC {
        cfFormat: unsafe { RegisterClipboardFormatW(CFSTR_FILECONTENTS) } as u16,
        dwAspect: DVASPECT_CONTENT.0,
        lindex: 0,
        tymed: TYMED_ISTREAM.0 as u32,
        ..Default::default()
    };
    let mut medium = unsafe { object.GetData(&format).unwrap() };
    let stream = unsafe { (&*medium.u.pstm).as_ref().unwrap().clone() };
    unsafe { ReleaseStgMedium(&mut medium) };
    let mut data = [0u8; 6];
    let mut read = 0;
    unsafe {
        stream
            .Read(data.as_mut_ptr().cast(), 6, Some(&mut read))
            .ok()
            .unwrap();
    }
    assert_eq!(read, 6);
    assert_eq!(&data, b"abcdef");
    fs::write(root.join("received.bin"), data).unwrap();
    unsafe {
        object
            .cast::<IDataObjectAsyncCapability>()
            .unwrap()
            .EndOperation(S_OK, None::<&IBindCtx>, DROPEFFECT_COPY.0)
            .unwrap();
    }
}
