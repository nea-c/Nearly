use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Drive {
    pub path: String,
    pub name: String,
    pub kind: String,
}

// The logical-drive mask describes drive letters, not media readiness. Never
// open a volume or enumerate its contents merely to populate the picker.
#[cfg(any(windows, test))]
fn roots_from_mask(mask: u32) -> Vec<String> {
    (0..26)
        .filter(|letter| mask & (1 << letter) != 0)
        .map(|letter| format!("{}:\\", (b'A' + letter as u8) as char))
        .collect()
}

#[cfg(windows)]
pub fn list() -> Result<Vec<Drive>, String> {
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives},
    };
    // These calls consult Windows' logical-drive information, without a disk
    // scan, directory access, volume-label lookup, or network-share traversal.
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err("Windows could not list logical drives".into());
    }
    Ok(roots_from_mask(mask)
        .into_iter()
        .map(|path| {
            let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
            let kind = match unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } {
                1 => "unavailable",
                2 => "removable",
                3 => "fixed",
                4 => "network",
                5 => "optical",
                6 => "ramdisk",
                _ => "unknown",
            };
            Drive {
                name: path[..2].into(),
                path,
                kind: kind.into(),
            }
        })
        .collect())
}

#[cfg(not(windows))]
pub fn list() -> Result<Vec<Drive>, String> {
    Err("Logical drive listing is available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_mask_preserves_letters_without_probing_contents() {
        let drives = roots_from_mask((1 << 2) | (1 << 3) | (1 << 25));
        assert_eq!(drives, vec!["C:\\", "D:\\", "Z:\\"]);
        assert!(roots_from_mask(0).is_empty());
        assert!(roots_from_mask(1 << 31).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn os_drive_list_has_canonical_roots_and_serializable_names() {
        let drives = list().unwrap();
        assert!(!drives.is_empty());
        let mut previous = String::new();
        for drive in drives {
            let bytes = drive.path.as_bytes();
            assert_eq!(bytes.len(), 3);
            assert!(bytes[0].is_ascii_uppercase());
            assert_eq!(&bytes[1..], b":\\");
            assert_eq!(drive.name, drive.path[..2]);
            assert!(drive.path > previous);
            assert!(serde_json::to_value(&drive).unwrap()["kind"].is_string());
            previous = drive.path;
        }
    }
}
