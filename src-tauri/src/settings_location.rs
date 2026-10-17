//! Explicit fixture override or the running executable's own directory only.
//! No storage migration, alternate-location search, or AppData fallback.
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn write_error(path: &Path, action: &str, error: &std::io::Error) -> String {
    format!("設定ファイル「{}」の{}ができません（{}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",path.display(),action,error)
}

fn select_directory(executable: &Path, override_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(dir) = override_dir {
        if dir.as_os_str().is_empty() {
            return Err(
                "SYNCFILES_CONFIG_DIR が空です。書き込み可能な設定フォルダーを指定してください。"
                    .into(),
            );
        }
        return Ok(dir);
    }
    if !executable.is_absolute() {
        return Err(
            "実行中の Nearly.exe の絶対パスを取得できません。設定は読み込み・保存していません。"
                .into(),
        );
    }
    executable
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| "Nearly.exe の保存フォルダーを取得できません。".into())
}

pub(crate) fn resolve() -> Result<PathBuf, String> {
    let override_dir = std::env::var_os("SYNCFILES_CONFIG_DIR").map(PathBuf::from);
    let executable = if override_dir.is_some() {
        PathBuf::new()
    } else {
        std::env::current_exe().map_err(|_| {
            "実行中の Nearly.exe の場所を取得できません。設定は読み込み・保存していません。"
        })?
    };
    let dir = select_directory(&executable, override_dir)?;
    prepare_directory(&dir, probe_writable)
}

fn prepare_directory(
    dir: &Path,
    probe: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<PathBuf, String> {
    let settings = dir.join("settings.json");
    std::fs::create_dir_all(dir).map_err(|e| write_error(&settings, "保存フォルダーの準備", &e))?;
    probe(dir).map_err(|e| write_error(&settings, "保存先の書き込み確認", &e))?;
    Ok(settings)
}

fn probe_writable(dir: &Path) -> std::io::Result<()> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| std::io::Error::other(e.to_string()))?;
    let suffix = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let probe = dir.join(format!(
        ".nearly-write-probe-{}-{suffix}.tmp",
        std::process::id()
    ));
    // Cleanup follows only this call's successful create_new, never a pre-existing path.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)?;
    let written = file
        .write_all(b"Nearly settings write check\n")
        .and_then(|_| file.sync_all());
    drop(file);
    let removed = std::fs::remove_file(&probe);
    written.and(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).unwrap();
            let suffix = random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let p = std::env::temp_dir().join(format!("nearly-portable-generated-{suffix}"));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn default_directory_is_executable_parent_not_appdata_or_working_directory() {
        let executable = Path::new("D:\\generated-portable\\Nearly.exe");
        assert_eq!(
            select_directory(executable, None).unwrap(),
            PathBuf::from("D:\\generated-portable")
        );
        assert_eq!(
            select_directory(Path::new("C:\\different-place\\Nearly.exe"), None).unwrap(),
            PathBuf::from("C:\\different-place")
        );
    }
    #[test]
    fn explicit_test_override_wins_over_executable_location() {
        assert_eq!(
            select_directory(
                Path::new("D:\\generated-portable\\Nearly.exe"),
                Some(PathBuf::from("C:\\generated-fixture"))
            )
            .unwrap(),
            PathBuf::from("C:\\generated-fixture")
        );
        assert!(select_directory(Path::new(""), Some(PathBuf::new())).is_err());
    }
    #[test]
    fn unavailable_executable_never_falls_back_to_current_directory() {
        for path in ["", "Nearly.exe", "relative\\Nearly.exe"] {
            assert!(select_directory(Path::new(path), None).is_err());
        }
    }
    #[test]
    fn owned_probe_is_removed_and_existing_settings_bytes_are_untouched() {
        let f = Fixture::new();
        let p = f.0.join("settings.json");
        std::fs::write(&p, b"generated sentinel bytes").unwrap();
        assert_eq!(prepare_directory(&f.0, probe_writable).unwrap(), p);
        assert_eq!(std::fs::read(&p).unwrap(), b"generated sentinel bytes");
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
    }
    #[test]
    fn permission_denied_is_actionable_and_never_returns_defaults_or_another_path() {
        let f = Fixture::new();
        let p = f.0.join("settings.json");
        std::fs::write(&p, b"generated sentinel bytes").unwrap();
        let error = prepare_directory(&f.0, |_| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();
        assert!(error.contains(&p.display().to_string()));
        assert!(error.contains("書き込み可能なフォルダーへ移動"));
        assert_eq!(std::fs::read(&p).unwrap(), b"generated sentinel bytes");
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
    }
    #[test]
    fn actual_destination_collision_fails_without_modifying_the_existing_file() {
        let f = Fixture::new();
        let blocked = f.0.join("not-a-directory");
        std::fs::write(&blocked, b"generated collision").unwrap();
        let error = prepare_directory(&blocked, probe_writable).unwrap_err();
        assert!(error.contains("settings.json"));
        assert!(error.contains("書き込み可能なフォルダーへ移動"));
        assert_eq!(std::fs::read(&blocked).unwrap(), b"generated collision");
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
    }
}
