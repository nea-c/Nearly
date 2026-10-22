//! Deterministic generated-fixture race only. Never compiled into product builds.
use std::{path::Path,sync::atomic::AtomicBool,time::{Duration,Instant}};
pub(super) fn after_capture(source:&Path,stop:&AtomicBool)->Result<(),String>{
 if source.file_name().is_none_or(|name|name!="hint-race.txt"){return Ok(());}
 let Some(base)=std::env::var_os("NEARLY_LISTING_TEST_ROOT") else{return Ok(());};
 let base=std::path::PathBuf::from(base);
 if !base.file_name().is_some_and(|name|name.to_string_lossy().starts_with("listing-worker-"))
    ||base.parent().and_then(Path::file_name).is_none_or(|name|name!="test-results"){return Err("Invalid generated listing fixture".into());}
 let base=base.canonicalize().map_err(|_|"Generated listing fixture unavailable")?;
 if !source.canonicalize().map_err(|_|"Generated source unavailable")?.starts_with(&base){return Err("Generated source escaped fixture".into());}
 std::fs::write(base.join("hint-captured"),b"generated").map_err(|_|"Generated listing marker failed")?;
 let deadline=Instant::now()+Duration::from_secs(10);
 while !base.join("hint-continue").exists(){crate::file_ops::check(stop)?;if Instant::now()>deadline{return Err("Generated listing barrier timeout".into());}std::thread::sleep(Duration::from_millis(2));}
 Ok(())
}
