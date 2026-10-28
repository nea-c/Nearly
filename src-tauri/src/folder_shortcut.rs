//! Read a local folder shortcut without launching it or asking the Shell to find moved targets.
use std::path::PathBuf;

const INVALID: &str = "Folder shortcut could not be read";
const TARGET: &str = "Folder shortcut target is unavailable or is not a folder";
const NETWORK: &str = "Network shortcut targets are unsupported; no connection was attempted";
const REPARSE: &str = "Folder shortcut paths through links or reparse points are unsupported";
const ARGUMENTS: &str = "Folder shortcuts with arguments are unsupported";

fn local_path(raw: &str) -> Result<PathBuf, String> {
  if raw.starts_with("\\\\") || raw.starts_with("//") { return Err(NETWORK.into()); }
  let path = raw.replace('/', "\\");
  let bytes = path.as_bytes();
  if path.encode_utf16().count() > 4096 || bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() ||
    bytes[1] != b':' || bytes[2] != b'\\' || path.chars().any(|c| c.is_control() || "<>\"|?*".contains(c)) {
    return Err(INVALID.into());
  }
  let parts: Vec<_> = path[3..].split('\\').filter(|p| !p.is_empty()).collect();
  if parts.iter().any(|p| *p == "." || *p == ".." || p.contains(':') || p.ends_with('.') || p.ends_with(' ')) {
    return Err(INVALID.into());
  }
  Ok(PathBuf::from(format!("{}{}", &path[..3], parts.join("\\"))))
}

#[cfg(windows)]
fn checked_path(raw: &str, directory: bool) -> Result<PathBuf, String> {
  use std::os::windows::fs::MetadataExt;
  use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
  let path = local_path(raw)?;
  let text = path.to_str().ok_or(INVALID)?;
  let drive: Vec<u16> = text[..3].encode_utf16().chain(Some(0)).collect();
  // Consult drive metadata before touching any path: mapped network drives are refused too.
  match unsafe { GetDriveTypeW(PCWSTR(drive.as_ptr())) } {
    4 => return Err(NETWORK.into()),
    2 | 3 | 5 | 6 => {},
    _ => return Err(TARGET.into()),
  }
  for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
    let meta = std::fs::symlink_metadata(ancestor).map_err(|_| TARGET)?;
    // Do not follow junctions/cloud placeholders/symlinks that could cross into a share.
    if meta.file_attributes() & 0x400 != 0 { return Err(REPARSE.into()); }
    let last = ancestor == path;
    if (!last || directory) && !meta.is_dir() { return Err(TARGET.into()); }
    if last && !directory && (!meta.is_file() || meta.len() > 1024 * 1024) { return Err(INVALID.into()); }
  }
  Ok(path)
}

#[cfg(windows)]
struct Apartment(bool);
#[cfg(windows)]
impl Apartment {
  fn new() -> Result<Self, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if result.is_ok() { return Ok(Self(true)); }
    // Tokio can reuse a worker whose apartment was initialized by another operation.
    // ShellLink supports that apartment; do not uninitialize someone else's COM reference.
    if result == windows::Win32::Foundation::RPC_E_CHANGED_MODE { return Ok(Self(false)); }
    Err(INVALID.into())
  }
}
#[cfg(windows)]
impl Drop for Apartment {
  fn drop(&mut self) { if self.0 { unsafe { windows::Win32::System::Com::CoUninitialize() }; } }
}

#[cfg(windows)]
pub fn resolve(raw: &str) -> Result<String, String> {
  use windows::{core::{Interface, PCWSTR}, Win32::{System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ}, UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH}}};
  let source = local_path(raw)?;
  if !source.extension().is_some_and(|s| s.eq_ignore_ascii_case("lnk")) { return Err(INVALID.into()); }
  let source = checked_path(raw, false)?;
  let wide: Vec<u16> = source.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
  let _apartment = Apartment::new()?;
  let target = unsafe {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|_| INVALID)?;
    let persist: IPersistFile = link.cast().map_err(|_| INVALID)?;
    persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).map_err(|_| INVALID)?;
    let mut arguments = [0u16; 32768];
    link.GetArguments(&mut arguments).map_err(|_| INVALID)?;
    if arguments[0] != 0 { return Err(ARGUMENTS.into()); }
    let mut buffer = [0u16; 32768];
    // No Resolve, ShellExecute, icon lookup, or environment expansion. No target is launched.
    link.GetPath(&mut buffer, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32).map_err(|_| INVALID)?;
    let end = buffer.iter().position(|c| *c == 0).ok_or(INVALID)?;
    if end == 0 { return Err(TARGET.into()); }
    String::from_utf16(&buffer[..end]).map_err(|_| INVALID)?
  };
  let target = checked_path(&target, true)?;
  target.into_os_string().into_string().map_err(|_| INVALID.into())
}

#[cfg(not(windows))]
pub fn resolve(_raw: &str) -> Result<String, String> {
  Err("Folder shortcuts are only supported on Windows".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn path_validation_refuses_network_device_relative_and_traversal_before_io() {
    for path in ["", "relative.lnk", "C:relative.lnk", "C:\\a\\..\\b", "C:\\a:stream", "C:\\a.\\b", "C:\\a\0b"] {
      assert!(local_path(path).is_err(), "{path:?}");
    }
    assert_eq!(local_path("\\\\fixture.invalid\\share").unwrap_err(), NETWORK);
    assert!(local_path("\\\\?\\C:\\target").is_err());
    assert_eq!(local_path("C:/folder/child").unwrap(), PathBuf::from("C:\\folder\\child"));
  }

  #[cfg(windows)]
  mod native {
    use super::*;
    use windows::{core::{Interface, PCWSTR}, Win32::{System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER}, UI::Shell::{IShellLinkW, ShellLink}}};

    struct Fixture(PathBuf);
    impl Fixture {
      fn new() -> Self {
        let path = std::env::temp_dir().join(format!("nearly-shortcut-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&path).unwrap(); Self(path)
      }
      fn link(&self, name: &str, target: Option<&std::path::Path>, args: Option<&str>) -> PathBuf {
        let path = self.0.join(name);
        let wide = |s: &std::ffi::OsStr| s.to_string_lossy().encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let _apartment = Apartment::new().unwrap();
        unsafe {
          let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
          if let Some(target) = target { link.SetPath(PCWSTR(wide(target.as_os_str()).as_ptr())).unwrap(); }
          if let Some(args) = args { link.SetArguments(PCWSTR(wide(std::ffi::OsStr::new(args)).as_ptr())).unwrap(); }
          let persist: IPersistFile = link.cast().unwrap();
          persist.Save(PCWSTR(wide(path.as_os_str()).as_ptr()), true).unwrap();
        }
        path
      }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn assert_same_folder(actual: &std::path::Path, expected: &std::path::Path) {
      // ShellLink may expand a runner's 8.3 TEMP path to its long spelling.
      // Require the exact existing directory, rather than an identical path spelling.
      assert!(std::fs::metadata(actual).unwrap().is_dir());
      assert_eq!(std::fs::canonicalize(actual).unwrap(), std::fs::canonicalize(expected).unwrap());
    }

    #[test]
    fn real_lnk_returns_local_directory_without_changing_link_or_classification() {
      let f = Fixture::new(); let target = f.0.join("日本語 folder"); std::fs::create_dir(&target).unwrap();
      let link = f.link("folder.LNK", Some(&target), None);
      let before = std::fs::read(&link).unwrap();
      assert!(!std::fs::metadata(&link).unwrap().is_dir());
      assert_same_folder(&PathBuf::from(resolve(link.to_str().unwrap()).unwrap()), &target);
      assert_eq!(std::fs::read(link).unwrap(), before);
    }
    #[test]
    fn existing_multithreaded_com_apartment_can_read_a_shortcut() {
      use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
      let f = Fixture::new();
      let target = f.0.join("target"); std::fs::create_dir(&target).unwrap();
      let link = f.link("mta.lnk", Some(&target), None);
      unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().unwrap();
      assert_same_folder(&PathBuf::from(resolve(link.to_str().unwrap()).unwrap()), &target);
      unsafe { CoUninitialize() };
    }
    #[test]
    fn short_path_aliases_still_identify_the_exact_fixture_directory() {
      use windows::Win32::Storage::FileSystem::GetShortPathNameW;
      let short = |path: &std::path::Path| {
        let input: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
        let mut buffer = [0u16; 32768];
        let length = unsafe { GetShortPathNameW(PCWSTR(input.as_ptr()), Some(&mut buffer)) } as usize;
        assert!(length > 0 && length < buffer.len());
        PathBuf::from(String::from_utf16(&buffer[..length]).unwrap())
      };
      let f = Fixture::new(); let target = f.0.join("folder with spaces"); std::fs::create_dir(&target).unwrap();
      let link = f.link("alias-link.lnk", Some(&short(&target)), None);
      let resolved = resolve(short(&link).to_str().unwrap()).unwrap();
      assert_same_folder(&PathBuf::from(resolved), &target);
    }
    #[test]
    fn broken_empty_file_executable_argument_and_malformed_targets_are_not_opened() {
      let f = Fixture::new();
      let file = f.0.join("sentinel.exe"); std::fs::write(&file, b"not a program; never execute").unwrap();
      let dir = f.0.join("folder"); std::fs::create_dir(&dir).unwrap();
      for link in [f.link("file.lnk", Some(&file), None), f.link("broken.lnk", Some(&f.0.join("missing")), None), f.link("empty.lnk", None, None), f.link("args.lnk", Some(&dir), Some("--never-run"))] {
        assert!(resolve(link.to_str().unwrap()).is_err());
      }
      let bad = f.0.join("malformed.lnk"); std::fs::write(&bad, b"not a shell link").unwrap();
      assert!(resolve(bad.to_str().unwrap()).is_err());
      assert!(resolve(file.to_str().unwrap()).is_err());
      assert_eq!(std::fs::read(file).unwrap(), b"not a program; never execute");
    }
    #[test]
    fn source_and_target_through_a_local_junction_are_refused() {
      let f = Fixture::new(); let dir=f.0.join("target"); std::fs::create_dir(&dir).unwrap();
      let junction=f.0.join("junction");
      // This test only creates a junction between two private fixture paths.
      let result=std::process::Command::new("cmd").args(["/c","mklink","/J"]).arg(&junction).arg(&dir).output().unwrap();
      assert!(result.status.success());
      let link=f.link("junction.lnk",Some(&junction),None);
      assert_eq!(resolve(link.to_str().unwrap()).unwrap_err(),REPARSE);
      let source = f.link("source.lnk", Some(&dir), None);
      std::fs::copy(source, dir.join("source.lnk")).unwrap();
      assert_eq!(resolve(junction.join("source.lnk").to_str().unwrap()).unwrap_err(),REPARSE);
      std::fs::remove_dir(junction).unwrap();
    }
  }
}
