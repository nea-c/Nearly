//! Windows virtual-file COPY source. Metadata and stream creation perform no content reads.
use std::{
    ffi::c_void,
    mem::{offset_of, size_of, ManuallyDrop},
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
};
use windows::{
    core::{implement, Error, Ref, Result as WinResult, BOOL, HRESULT},
    Win32::{
        Foundation::*,
        System::{
            Com::*, DataExchange::RegisterClipboardFormatW, Memory::*, Ole::ReleaseStgMedium,
        },
        UI::Shell::*,
    },
};
pub struct VirtualEntry {
    pub relative: String,
    pub directory: bool,
    pub size: u64,
    pub modified: Option<u32>,
}
pub trait Reader: Send + Sync {
    fn read_at(
        &self,
        index: usize,
        handle: &mut Option<Vec<u8>>,
        offset: u64,
        length: u32,
    ) -> Result<Vec<u8>, String>;
    fn close(&self, handle: Vec<u8>);
    fn finish(&self);
    fn active(&self) -> bool;
}
fn failed(code: HRESULT) -> Error {
    Error::from_hresult(code)
}
pub fn descriptor_name(relative: &str) -> Result<String, String> {
    if relative.is_empty() || relative.starts_with('/') || relative.contains('\\') {
        return Err("Invalid virtual file relative path".into());
    }
    for name in relative.split('/') {
        crate::file_ops::validate_creation_name(name, crate::file_ops::Side::Local)?;
    }
    let name = relative.replace('/', "\\");
    if name.encode_utf16().count() >= 260 {
        return Err("Virtual file relative path exceeds Windows descriptor limit".into());
    }
    Ok(name)
}
#[derive(Clone, Copy)]
struct Formats {
    descriptors: u16,
    contents: u16,
    preferred: u16,
    performed: u16,
    pasted: u16,
}
impl Formats {
    fn new() -> WinResult<Self> {
        let reg = |name| {
            let value = unsafe { RegisterClipboardFormatW(name) };
            if value == 0 {
                Err(Error::from_win32())
            } else {
                Ok(value as u16)
            }
        };
        Ok(Self {
            descriptors: reg(CFSTR_FILEDESCRIPTORW)?,
            contents: reg(CFSTR_FILECONTENTS)?,
            preferred: reg(CFSTR_PREFERREDDROPEFFECT)?,
            performed: reg(CFSTR_PERFORMEDDROPEFFECT)?,
            pasted: reg(CFSTR_PASTESUCCEEDED)?,
        })
    }
    fn format(id: u16, index: i32, medium: TYMED) -> FORMATETC {
        FORMATETC {
            cfFormat: id,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: medium.0 as u32,
            ..Default::default()
        }
    }
}
pub struct VirtualFiles {
    pub entries: Vec<VirtualEntry>,
    reader: Arc<dyn Reader>,
    pub stop: Arc<AtomicBool>,
    streams: AtomicUsize,
    asynchronous: AtomicBool,
    pub in_operation: AtomicBool,
    pub ended: AtomicBool,
    pub end_result: AtomicI32,
}
impl Drop for VirtualFiles {
    fn drop(&mut self) {
        self.reader.finish();
    }
}
impl VirtualFiles {
    pub fn new(
        entries: Vec<VirtualEntry>,
        reader: Arc<dyn Reader>,
        stop: Arc<AtomicBool>,
    ) -> Result<Arc<Self>, String> {
        if entries.is_empty() || entries.len() > 10000 {
            return Err("Virtual drag needs 1 to 10,000 descriptors".into());
        }
        let mut names = std::collections::HashSet::new();
        for entry in &entries {
            let name = descriptor_name(&entry.relative)?;
            if !names.insert(name.to_uppercase()) {
                return Err("Case-ambiguous virtual names".into());
            }
        }
        Ok(Arc::new(Self {
            entries,
            reader,
            stop,
            streams: AtomicUsize::new(0),
            asynchronous: AtomicBool::new(true),
            in_operation: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            end_result: AtomicI32::new(S_OK.0),
        }))
    }
    pub fn object(self: &Arc<Self>) -> WinResult<IDataObject> {
        let source = DeferredFiles::new(self.stop.clone());
        source.publish(Ok(self.clone()));
        source.object()
    }
    pub fn finish(&self) {
        self.reader.finish();
    }
    pub fn active(&self) -> bool {
        self.reader.active() && !self.stop.load(Ordering::SeqCst)
    }
    fn stream(self: &Arc<Self>, index: usize, position: u64) -> WinResult<IStream> {
        if !self.active() || self.entries.get(index).is_none_or(|e| e.directory) {
            return Err(failed(STG_E_REVERTED));
        }
        self.streams
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < 16).then_some(n + 1)
            })
            .map_err(|_| failed(STG_E_INSUFFICIENTMEMORY))?;
        Ok(VirtualStream {
            files: self.clone(),
            index,
            cursor: Mutex::new(Cursor {
                position,
                handle: None,
                empty_checked: false,
            }),
        }
        .into())
    }
}
/// The OLE source exists before network metadata. Format negotiation never waits.
/// Rendering waits only when a target actually requests descriptors or contents.
pub struct DeferredFiles {
    value: Mutex<Option<Result<Arc<VirtualFiles>, String>>>,
    ready: Condvar,
    stop: Arc<AtomicBool>,
    asynchronous: AtomicBool,
    timed_out: AtomicBool,
}
impl DeferredFiles {
    pub fn new(stop: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self { value: Mutex::new(None), ready: Condvar::new(), stop, asynchronous: AtomicBool::new(true), timed_out: AtomicBool::new(false) })
    }
    pub fn publish(&self, result: Result<Arc<VirtualFiles>, String>) {
        if let Ok(mut value) = self.value.lock() {
            if self.stop.load(Ordering::SeqCst) {
                if let Ok(files) = &result { files.finish(); }
            }
            *value = Some(result);
            self.ready.notify_all();
        }
    }
    pub fn peek(&self) -> Option<Arc<VirtualFiles>> {
        self.value.lock().ok()?.as_ref()?.as_ref().ok().cloned()
    }
    pub fn timed_out(&self) -> bool { self.timed_out.load(Ordering::SeqCst) }
    pub fn get(&self) -> WinResult<Arc<VirtualFiles>> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let mut value = self.value.lock().map_err(|_| failed(E_FAIL))?;
        loop {
            if self.stop.load(Ordering::SeqCst) { return Err(failed(STG_E_REVERTED)); }
            if let Some(result) = value.as_ref() { return result.clone().map_err(|_| failed(STG_E_READFAULT)); }
            if std::time::Instant::now() >= deadline {
                self.timed_out.store(true, Ordering::SeqCst);
                self.stop.store(true, Ordering::SeqCst);
                return Err(failed(STG_E_READFAULT));
            }
            value = self.ready.wait_timeout(value, std::time::Duration::from_millis(25)).map_err(|_| failed(E_FAIL))?.0;
        }
    }
    pub fn object(self: &Arc<Self>) -> WinResult<IDataObject> {
        Ok(VirtualData { source: self.clone(), formats: Formats::new()? }.into())
    }
}
pub fn data_object(
    entries: Vec<VirtualEntry>,
    reader: Arc<dyn Reader>,
    stop: Arc<AtomicBool>,
) -> WinResult<IDataObject> {
    VirtualFiles::new(entries, reader, stop)
        .map_err(|_| failed(E_INVALIDARG))?
        .object()
}
fn global_medium(bytes: &[u8]) -> WinResult<STGMEDIUM> {
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())?;
        let target = GlobalLock(handle);
        if target.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err(Error::from_win32());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
}
fn descriptor_bytes(entries: &[VirtualEntry]) -> WinResult<Vec<u8>> {
    let width = size_of::<FILEDESCRIPTORW>();
    let mut bytes = vec![0u8; 4 + entries.len() * width];
    bytes[..4].copy_from_slice(&(entries.len() as u32).to_le_bytes());
    for (index, entry) in entries.iter().enumerate() {
        let base = 4 + index * width;
        let mut put = |offset: usize, value: u32| {
            bytes[base + offset..base + offset + 4].copy_from_slice(&value.to_le_bytes())
        };
        let mut flags = FD_ATTRIBUTES.0 as u32 | FD_FILESIZE.0 as u32 | FD_PROGRESSUI.0 as u32;
        put(
            offset_of!(FILEDESCRIPTORW, dwFileAttributes),
            if entry.directory { 0x10 } else { 0x80 },
        );
        put(
            offset_of!(FILEDESCRIPTORW, nFileSizeHigh),
            (entry.size >> 32) as u32,
        );
        put(offset_of!(FILEDESCRIPTORW, nFileSizeLow), entry.size as u32);
        if let Some(mtime) = entry.modified {
            flags |= FD_WRITESTIME.0 as u32;
            let ticks = (mtime as u64 + 11644473600) * 10_000_000;
            let offset = offset_of!(FILEDESCRIPTORW, ftLastWriteTime);
            put(offset, ticks as u32);
            put(offset + 4, (ticks >> 32) as u32);
        }
        put(offset_of!(FILEDESCRIPTORW, dwFlags), flags);
        let name = descriptor_name(&entry.relative).map_err(|_| failed(E_INVALIDARG))?;
        let offset = base + offset_of!(FILEDESCRIPTORW, cFileName);
        for (i, ch) in name.encode_utf16().enumerate() {
            bytes[offset + i * 2..offset + i * 2 + 2].copy_from_slice(&ch.to_le_bytes());
        }
    }
    Ok(bytes)
}
#[implement(IDataObject, IDataObjectAsyncCapability)]
struct VirtualData {
    source: Arc<DeferredFiles>,
    formats: Formats,
}
impl VirtualData_Impl {
    fn validate(&self, format: *const FORMATETC) -> WinResult<FORMATETC> {
        if format.is_null() {
            return Err(failed(E_POINTER));
        }
        let f = unsafe { format.read() };
        if !f.ptd.is_null() || f.dwAspect != DVASPECT_CONTENT.0 {
            return Err(failed(DV_E_FORMATETC));
        }
        if f.cfFormat == self.formats.contents {
            if f.lindex < 0
                || self.source.peek().is_some_and(|files| files.entries.get(f.lindex as usize).is_none_or(|e| e.directory))
                || f.tymed & TYMED_ISTREAM.0 as u32 == 0
            {
                return Err(failed(DV_E_FORMATETC));
            }
        } else if ![self.formats.descriptors, self.formats.preferred].contains(&f.cfFormat)
            || f.lindex != -1
            || f.tymed & TYMED_HGLOBAL.0 as u32 == 0
        {
            return Err(failed(DV_E_FORMATETC));
        }
        Ok(f)
    }
}
impl IDataObject_Impl for VirtualData_Impl {
    fn GetData(&self, format: *const FORMATETC) -> WinResult<STGMEDIUM> {
        let f = self.validate(format)?;
        if f.cfFormat == self.formats.descriptors {
            return global_medium(&descriptor_bytes(&self.source.get()?.entries)?);
        }
        if f.cfFormat == self.formats.preferred {
            return global_medium(&1u32.to_le_bytes());
        }
        let stream = self.source.get()?.stream(f.lindex as usize, 0)?;
        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> WinResult<()> {
        Err(failed(E_NOTIMPL))
    }
    fn QueryGetData(&self, f: *const FORMATETC) -> HRESULT {
        self.validate(f).map(|_| S_OK).unwrap_or_else(|e| e.code())
    }
    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, out: *mut FORMATETC) -> HRESULT {
        if !out.is_null() {
            unsafe { (*out).ptd = std::ptr::null_mut() };
        }
        DATA_S_SAMEFORMATETC
    }
    fn SetData(
        &self,
        format: *const FORMATETC,
        medium: *const STGMEDIUM,
        release: BOOL,
    ) -> WinResult<()> {
        if format.is_null() || medium.is_null() {
            return Err(failed(E_POINTER));
        }
        let format = unsafe { &*format };
        let medium_ref = unsafe { &*medium };
        if ![self.formats.performed, self.formats.pasted].contains(&format.cfFormat)
            || format.dwAspect != DVASPECT_CONTENT.0
            || medium_ref.tymed != TYMED_HGLOBAL.0 as u32
        {
            return Err(failed(E_NOTIMPL));
        }
        // Effect notifications never authorize source mutations. The only offered effect is COPY.
        if release.as_bool() {
            unsafe { ReleaseStgMedium(medium.cast_mut()) }
        }
        Ok(())
    }
    fn EnumFormatEtc(&self, direction: u32) -> WinResult<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(failed(E_NOTIMPL));
        }
        unsafe {
            SHCreateStdEnumFmtEtc(&[
                Formats::format(self.formats.descriptors, -1, TYMED_HGLOBAL),
                Formats::format(self.formats.contents, -1, TYMED_ISTREAM),
                Formats::format(self.formats.preferred, -1, TYMED_HGLOBAL),
            ])
        }
    }
    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<'_, IAdviseSink>) -> WinResult<u32> {
        Err(failed(OLE_E_ADVISENOTSUPPORTED))
    }
    fn DUnadvise(&self, _: u32) -> WinResult<()> {
        Err(failed(OLE_E_ADVISENOTSUPPORTED))
    }
    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(failed(OLE_E_ADVISENOTSUPPORTED))
    }
}
impl IDataObjectAsyncCapability_Impl for VirtualData_Impl {
    fn SetAsyncMode(&self, value: BOOL) -> WinResult<()> {
        self.source
            .asynchronous
            .store(value.as_bool(), Ordering::SeqCst);
        Ok(())
    }
    fn GetAsyncMode(&self) -> WinResult<BOOL> {
        Ok(self.source.asynchronous.load(Ordering::SeqCst).into())
    }
    fn StartOperation(&self, _: Ref<'_, IBindCtx>) -> WinResult<()> {
        let files = self.source.get()?;
        if !files.active() {
            return Err(failed(STG_E_REVERTED));
        }
        files.in_operation.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn InOperation(&self) -> WinResult<BOOL> {
        Ok(self.source.peek().is_some_and(|files| files.in_operation.load(Ordering::SeqCst)).into())
    }
    fn EndOperation(&self, result: HRESULT, _: Ref<'_, IBindCtx>, _: u32) -> WinResult<()> {
        let files = self.source.get()?;
        files.end_result.store(result.0, Ordering::SeqCst);
        files.ended.store(true, Ordering::SeqCst);
        files.in_operation.store(false, Ordering::SeqCst);
        files.finish();
        Ok(())
    }
}
struct Cursor {
    position: u64,
    handle: Option<Vec<u8>>,
    empty_checked: bool,
}
#[implement(IStream)]
struct VirtualStream {
    files: Arc<VirtualFiles>,
    index: usize,
    cursor: Mutex<Cursor>,
}
impl Drop for VirtualStream {
    fn drop(&mut self) {
        if let Ok(cursor) = self.cursor.get_mut() {
            if let Some(handle) = cursor.handle.take() {
                self.files.reader.close(handle);
            }
        }
        self.files.streams.fetch_sub(1, Ordering::SeqCst);
    }
}
impl ISequentialStream_Impl for VirtualStream_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, count: *mut u32) -> HRESULT {
        if !count.is_null() {
            unsafe { *count = 0 }
        }
        if pv.is_null() && cb > 0 {
            return E_POINTER;
        }
        if !self.files.active() {
            return STG_E_REVERTED;
        }
        let Ok(mut cursor) = self.cursor.lock() else {
            return E_FAIL;
        };
        let size = self.files.entries[self.index].size;
        let desired = (cb as u64).min(size.saturating_sub(cursor.position));
        let mut read = 0u32;
        if cb > 0 && size == 0 && !cursor.empty_checked {
            if self
                .files
                .reader
                .read_at(self.index, &mut cursor.handle, 0, 0)
                .is_err()
            {
                return STG_E_READFAULT;
            }
            cursor.empty_checked = true;
        }
        while (read as u64) < desired {
            if !self.files.active() {
                return STG_E_REVERTED;
            }
            let position = cursor.position;
            let length = (desired - read as u64).min(65536) as u32;
            let data =
                match self
                    .files
                    .reader
                    .read_at(self.index, &mut cursor.handle, position, length)
                {
                    Ok(data) if !data.is_empty() && data.len() <= length as usize => data,
                    _ => return STG_E_READFAULT,
                };
            unsafe {
                std::ptr::copy_nonoverlapping(
                    data.as_ptr(),
                    pv.cast::<u8>().add(read as usize),
                    data.len(),
                )
            };
            read += data.len() as u32;
            cursor.position += data.len() as u64;
            if !count.is_null() {
                unsafe { *count = read }
            }
        }
        if read == cb {
            S_OK
        } else {
            S_FALSE
        }
    }
    fn Write(&self, _: *const c_void, _: u32, count: *mut u32) -> HRESULT {
        if !count.is_null() {
            unsafe { *count = 0 }
        }
        STG_E_ACCESSDENIED
    }
}
impl IStream_Impl for VirtualStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, new: *mut u64) -> WinResult<()> {
        let mut cursor = self.cursor.lock().map_err(|_| failed(E_FAIL))?;
        let base = match origin {
            STREAM_SEEK_SET => 0,
            STREAM_SEEK_CUR => cursor.position,
            STREAM_SEEK_END => self.files.entries[self.index].size,
            _ => return Err(failed(STG_E_INVALIDFUNCTION)),
        };
        let pos = if offset < 0 {
            base.checked_sub(offset.unsigned_abs())
        } else {
            base.checked_add(offset as u64)
        }
        .ok_or_else(|| failed(STG_E_INVALIDFUNCTION))?;
        cursor.position = pos;
        if !new.is_null() {
            unsafe { *new = pos }
        }
        Ok(())
    }
    fn SetSize(&self, _: u64) -> WinResult<()> {
        Err(failed(STG_E_ACCESSDENIED))
    }
    fn CopyTo(
        &self,
        target: Ref<'_, IStream>,
        size: u64,
        read: *mut u64,
        written: *mut u64,
    ) -> WinResult<()> {
        if !read.is_null() {
            unsafe { *read = 0 }
        }
        if !written.is_null() {
            unsafe { *written = 0 }
        }
        let target = target.as_ref().ok_or_else(|| failed(E_POINTER))?;
        let mut copied = 0;
        let mut buffer = vec![0u8; 65536];
        while copied < size {
            let mut n = 0;
            let status = ISequentialStream_Impl::Read(
                self,
                buffer.as_mut_ptr().cast(),
                (size - copied).min(buffer.len() as u64) as u32,
                &mut n,
            );
            status.ok()?;
            if n == 0 {
                break;
            }
            let mut out = 0;
            unsafe {
                target
                    .Write(buffer.as_ptr().cast(), n, Some(&mut out))
                    .ok()?;
            }
            if out != n {
                return Err(failed(STG_E_WRITEFAULT));
            }
            copied += n as u64;
            if !read.is_null() {
                unsafe { *read = copied }
            }
            if !written.is_null() {
                unsafe { *written = copied }
            }
            if status == S_FALSE {
                break;
            }
        }
        Ok(())
    }
    fn Commit(&self, _: &STGC) -> WinResult<()> {
        Ok(())
    }
    fn Revert(&self) -> WinResult<()> {
        Err(failed(STG_E_ACCESSDENIED))
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> WinResult<()> {
        Err(failed(STG_E_INVALIDFUNCTION))
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> WinResult<()> {
        Err(failed(STG_E_INVALIDFUNCTION))
    }
    fn Stat(&self, out: *mut STATSTG, _: &STATFLAG) -> WinResult<()> {
        if out.is_null() {
            return Err(failed(E_POINTER));
        }
        unsafe {
            out.write(STATSTG {
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.files.entries[self.index].size,
                grfMode: STGM_READ,
                ..Default::default()
            })
        };
        Ok(())
    }
    fn Clone(&self) -> WinResult<IStream> {
        let position = self.cursor.lock().map_err(|_| failed(E_FAIL))?.position;
        self.files.stream(self.index, position)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
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
    #[test]
    fn deferred_formats_are_available_before_metadata_without_reading_contents() {
        let _com = Com::new();
        let stop = Arc::new(AtomicBool::new(false));
        let pending = DeferredFiles::new(stop.clone());
        let object = pending.object().unwrap();
        let descriptors = format(CFSTR_FILEDESCRIPTORW, -1, TYMED_HGLOBAL);
        unsafe {
            object.QueryGetData(&descriptors).ok().unwrap();
            object.EnumFormatEtc(DATADIR_GET.0 as u32).unwrap();
            let physical = FORMATETC { cfFormat: windows::Win32::System::Ole::CF_HDROP.0 as u16, dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32, ..Default::default() };
            assert!(object.QueryGetData(&physical).is_err(), "own virtual source cannot be converted into Wry inbound filesystem paths");
            assert!(object.GetData(&physical).is_err());
        }
        assert!(pending.peek().is_none(), "format negotiation cannot wait for metadata");
        let fake = Arc::new(Fake::default());
        let files = VirtualFiles::new(entries(), fake.clone(), stop).unwrap();
        pending.publish(Ok(files));
        let mut medium = unsafe { object.GetData(&descriptors).unwrap() };
        unsafe { ReleaseStgMedium(&mut medium) };
        assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn cancelled_deferred_metadata_never_revives_a_gesture() {
        let stop = Arc::new(AtomicBool::new(false));
        let pending = DeferredFiles::new(stop.clone());
        stop.store(true, Ordering::SeqCst);
        assert!(pending.get().is_err());
        let fake = Arc::new(Fake::default());
        pending.publish(Ok(VirtualFiles::new(entries(), fake.clone(), stop).unwrap()));
        assert!(pending.get().is_err());
        assert!(fake.finished.load(Ordering::SeqCst));
    }
    impl Com {
        fn new() -> Self {
            unsafe { OleInitialize(None).unwrap() };
            Self
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { OleUninitialize() }
        }
    }
    #[derive(Default)]
    struct Fake {
        reads: AtomicUsize,
        finished: AtomicBool,
    }
    impl Reader for Fake {
        fn read_at(
            &self,
            _: usize,
            _: &mut Option<Vec<u8>>,
            offset: u64,
            length: u32,
        ) -> Result<Vec<u8>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let bytes = b"abcdef";
            Ok(bytes[(offset as usize).min(6)
                ..((offset as usize).saturating_add(length as usize)).min(6)]
                .to_vec())
        }
        fn close(&self, _: Vec<u8>) {}
        fn finish(&self) {
            self.finished.store(true, Ordering::SeqCst);
        }
        fn active(&self) -> bool {
            !self.finished.load(Ordering::SeqCst)
        }
    }
    fn entries() -> Vec<VirtualEntry> {
        vec![
            VirtualEntry {
                relative: "tree".into(),
                directory: true,
                size: 0,
                modified: Some(1),
            },
            VirtualEntry {
                relative: "tree/file.txt".into(),
                directory: false,
                size: 6,
                modified: Some(1),
            },
        ]
    }
    fn format(name: windows::core::PCWSTR, index: i32, medium: TYMED) -> FORMATETC {
        FORMATETC {
            cfFormat: unsafe { RegisterClipboardFormatW(name) } as u16,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: medium.0 as u32,
            ..Default::default()
        }
    }
    unsafe fn stream(object: &IDataObject) -> IStream {
        let mut medium = unsafe {
            object
                .GetData(&format(CFSTR_FILECONTENTS, 1, TYMED_ISTREAM))
                .unwrap()
        };
        let stream = unsafe { (&*medium.u.pstm).as_ref().unwrap().clone() };
        unsafe { ReleaseStgMedium(&mut medium) };
        stream
    }
    #[test]
    fn descriptors_refuse_unsafe_or_truncated_names_and_streams_are_lazy_independent_readonly() {
        let _com = Com::new();
        for name in [
            "../escape",
            "/absolute",
            "tree//child",
            "CON.txt",
            "tree/child.",
            &"x".repeat(260),
        ] {
            assert!(descriptor_name(name).is_err(), "{name}");
        }
        assert_eq!(
            descriptor_name("tree/日本語.txt").unwrap(),
            "tree\\日本語.txt"
        );
        let fake = Arc::new(Fake::default());
        let stop = Arc::new(AtomicBool::new(false));
        let object = data_object(entries(), fake.clone(), stop.clone()).unwrap();
        object.cast::<windows::core::imp::IAgileObject>().unwrap();
        let descriptors = format(CFSTR_FILEDESCRIPTORW, -1, TYMED_HGLOBAL);
        unsafe {
            object.QueryGetData(&descriptors).ok().unwrap();
            let mut medium = object.GetData(&descriptors).unwrap();
            ReleaseStgMedium(&mut medium);
            object.EnumFormatEtc(DATADIR_GET.0 as u32).unwrap();
        }
        let first = unsafe { stream(&object) };
        let second = unsafe { stream(&object) };
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            0,
            "format queries, metadata and stream creation must not download bytes"
        );
        let mut bytes = [0u8; 4];
        let mut n = 0;
        unsafe {
            first
                .Read(bytes.as_mut_ptr().cast(), 2, Some(&mut n))
                .ok()
                .unwrap()
        };
        assert_eq!(&bytes[..n as usize], b"ab");
        unsafe {
            second
                .Read(bytes.as_mut_ptr().cast(), 2, Some(&mut n))
                .ok()
                .unwrap()
        };
        assert_eq!(&bytes[..n as usize], b"ab");
        let clone = unsafe { first.Clone().unwrap() };
        unsafe {
            clone
                .Read(bytes.as_mut_ptr().cast(), 2, Some(&mut n))
                .ok()
                .unwrap()
        };
        assert_eq!(&bytes[..n as usize], b"cd");
        unsafe { first.Seek(5, STREAM_SEEK_SET, None).unwrap() };
        assert_eq!(
            unsafe { first.Read(bytes.as_mut_ptr().cast(), 4, Some(&mut n)) },
            windows::Win32::Foundation::S_FALSE
        );
        assert_eq!(&bytes[..n as usize], b"f");
        assert!(unsafe { first.Seek(-1, STREAM_SEEK_SET, None) }.is_err());
        let mut written = 99;
        assert!(unsafe { first.Write(bytes.as_ptr().cast(), 1, Some(&mut written)) }.is_err());
        assert_eq!(written, 0);
        stop.store(true, Ordering::SeqCst);
        assert!(unsafe { second.Read(bytes.as_mut_ptr().cast(), 1, Some(&mut n)) }.is_err());
        assert_eq!(n, 0);
    }
    #[test]
    fn zero_byte_file_is_validated_on_first_read_without_eager_content_fetch() {
        let _com = Com::new();
        let fake = Arc::new(Fake::default());
        let mut list = entries();
        list[1].size = 0;
        let object = data_object(list, fake.clone(), Arc::new(AtomicBool::new(false))).unwrap();
        let stream = unsafe { stream(&object) };
        assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
        let mut byte = 0u8;
        let mut n = 99;
        assert_eq!(
            unsafe { stream.Read((&mut byte as *mut u8).cast(), 1, Some(&mut n)) },
            windows::Win32::Foundation::S_FALSE
        );
        assert_eq!(n, 0);
        assert_eq!(
            fake.reads.load(Ordering::SeqCst),
            1,
            "empty source must still be checked after metadata capture"
        );
    }
    #[test]
    fn virtual_stream_count_is_bounded_and_async_end_releases_source() {
        let _com = Com::new();
        let fake = Arc::new(Fake::default());
        let object =
            data_object(entries(), fake.clone(), Arc::new(AtomicBool::new(false))).unwrap();
        let mut streams = Vec::new();
        for _ in 0..16 {
            streams.push(unsafe { stream(&object) });
        }
        assert!(unsafe { object.GetData(&format(CFSTR_FILECONTENTS, 1, TYMED_ISTREAM)) }.is_err());
        streams.pop();
        let _next = unsafe { stream(&object) };
        let asynchronous = object.cast::<IDataObjectAsyncCapability>().unwrap();
        unsafe {
            assert!(asynchronous.GetAsyncMode().unwrap().as_bool());
            asynchronous.StartOperation(None::<&IBindCtx>).unwrap();
            assert!(asynchronous.InOperation().unwrap().as_bool());
            asynchronous
                .EndOperation(windows::Win32::Foundation::S_OK, None::<&IBindCtx>, 1)
                .unwrap();
        }
        assert!(fake.finished.load(Ordering::SeqCst));
        assert_eq!(fake.reads.load(Ordering::SeqCst), 0);
    }
}
