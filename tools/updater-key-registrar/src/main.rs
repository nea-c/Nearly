use nearly_updater_key_registrar::{
    credential, preflight, public_record::FilePublicRecord, register, Api, PublicRecord, ENV, REPO,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    rc::Rc,
};
type Journal = Rc<RefCell<File>>;
fn append(journal: &Journal, value: Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "receipt encoding failed")?;
    let mut file = journal.borrow_mut();
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| "receipt persistence failed")
}
struct Audited<A> {
    api: A,
    journal: Journal,
}
fn metadata(path: &str, value: &Value) -> Value {
    if path.contains("/secrets?") {
        json!({"total_count":value["total_count"],"secrets":value["secrets"].as_array().map(|s|s.iter().map(|v|json!({"name":v["name"],"created_at":v["created_at"],"updated_at":v["updated_at"]})).collect::<Vec<_>>())})
    } else if path.ends_with("/secrets/public-key") {
        json!({"key_id":value["key_id"]})
    } else if path == "/user" {
        json!({"login":value["login"],"id":value["id"]})
    } else if path == REPO {
        json!({"full_name":value["full_name"],"owner_type":value["owner"]["type"],"default_branch":value["default_branch"]})
    } else if path == ENV {
        json!({"name":value["name"],"can_admins_bypass":value["can_admins_bypass"],"deployment_branch_policy":value["deployment_branch_policy"],"required_reviewers":value["protection_rules"].as_array().map(|rules|rules.iter().filter(|r|r["type"]=="required_reviewers").map(|r|json!({"prevent_self_review":r["prevent_self_review"],"reviewers":r["reviewers"].as_array().map(|people|people.iter().map(|p|json!({"type":p["type"],"id":p["reviewer"]["id"]})).collect::<Vec<_>>())})).collect::<Vec<_>>())})
    } else if path.contains("/deployment-branch-policies?") {
        json!({"total_count":value["total_count"],"branch_policies":value["branch_policies"]})
    } else {
        json!({"enforce_admins":value["enforce_admins"]["enabled"],"required_pull_request_reviews":value["required_pull_request_reviews"],"allow_force_pushes":value["allow_force_pushes"]["enabled"],"allow_deletions":value["allow_deletions"]["enabled"]})
    }
}
impl<A: Api> Api for Audited<A> {
    fn get(&mut self, path: &str) -> Result<Value, &'static str> {
        let value = self.api.get(path)?;
        append(
            &self.journal,
            json!({"event":"metadata","path":path,"value":metadata(path,&value)}),
        )?;
        Ok(value)
    }
    fn put(&mut self, path: &str, body: &str) -> Result<u16, &'static str> {
        append(
            &self.journal,
            json!({"event":"secret_put_intent","path":path}),
        )?;
        let response = self.api.put(path, body);
        append(
            &self.journal,
            json!({"event":"secret_put_response","path":path,"status":response.as_ref().ok(),"outcome_uncertain":response.is_err()}),
        )?;
        response
    }
}
struct Recorded {
    record: FilePublicRecord,
    journal: Journal,
}
impl PublicRecord for Recorded {
    fn assert_absent(&mut self) -> Result<(), &'static str> {
        self.record.assert_absent()
    }
    fn save_new(&mut self, public: &str) -> Result<(), &'static str> {
        self.record.save_new(public)?;
        append(
            &self.journal,
            json!({"event":"generated_public_key_saved","public_key_sha256":nearly_updater_signer::hash(public.as_bytes()),"encrypted_roundtrip":true,"public_probe_verified":true,"native_protocol3_probe_verified":true}),
        )
    }
}
#[cfg(windows)]
struct Lease(*mut std::ffi::c_void);
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(
        attributes: *const std::ffi::c_void,
        owner: i32,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn GetLastError() -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}
#[cfg(windows)]
impl Lease {
    fn acquire() -> Result<Self, &'static str> {
        let name: Vec<u16> = "Local\\NearlyProductionSigningRegistrar-nea-c-Nearly\0"
            .encode_utf16()
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err("registration lease unavailable");
        }
        if unsafe { GetLastError() } == 183 {
            unsafe { CloseHandle(handle) };
            return Err("another registration process exists");
        }
        Ok(Self(handle))
    }
}
#[cfg(windows)]
impl Drop for Lease {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
#[cfg(not(windows))]
struct Lease;
#[cfg(not(windows))]
impl Lease {
    fn acquire() -> Result<Self, &'static str> {
        Err("Windows required")
    }
}
fn absolute(path: &Path, extension: &str) -> bool {
    path.is_absolute() && path.extension().and_then(|s| s.to_str()) == Some(extension)
}
fn run() -> Result<(), &'static str> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("use --help")?;
    if mode == "--help" {
        println!("Nearly registrar: inspect --public-key ABS.pub | register --public-key ABS.pub --receipt ABS.jsonl --confirm-target nea-c/Nearly:nearly-updater-production\nUses existing Git credentials in memory; no secret input arguments or files. Production operations require prior human approval. No backup, retry or overwrite.");
        return Ok(());
    }
    if !matches!(mode.as_str(), "inspect" | "register") {
        return Err("unknown command");
    }
    let mut options = std::collections::BTreeMap::new();
    while let Some(option) = args.next() {
        if !["--public-key", "--receipt", "--confirm-target"].contains(&option.as_str()) {
            return Err("unknown option");
        }
        let value = args.next().ok_or("missing option value")?;
        if options.insert(option, value).is_some() {
            return Err("duplicate option");
        }
    }
    let public = PathBuf::from(
        options
            .get("--public-key")
            .ok_or("public key path required")?,
    );
    if !absolute(&public, "pub") {
        return Err("absolute .pub path required");
    }
    if mode == "inspect"
        && (options.contains_key("--receipt") || options.contains_key("--confirm-target"))
    {
        return Err("inspect takes only public key path");
    }
    let mut record = FilePublicRecord::new(
        public.clone(),
        vec![
            public.with_extension("key"),
            public.with_extension("key.pub"),
            PathBuf::from(r"D:\Codex\Nearly\.github\updater-public-key.pub"),
            PathBuf::from(r"D:\Codex\Nearly\.github\updater-private-key.key"),
            public.with_file_name("updater-private-key.key"),
        ],
    );
    record.assert_absent()?;
    if mode == "inspect" {
        let mut api = credential::existing()?.into_api()?;
        preflight(&mut api, &mut record)?;
        println!("Read-only preflight verified nea-c/Nearly nearly-updater-production; no key generation or registration.");
        return Ok(());
    }
    if options.get("--confirm-target").map(String::as_str)
        != Some("nea-c/Nearly:nearly-updater-production")
    {
        return Err("exact public target confirmation required");
    }
    let receipt = PathBuf::from(options.get("--receipt").ok_or("receipt path required")?);
    if !absolute(&receipt, "jsonl") {
        return Err("absolute .jsonl receipt path required");
    }
    let _lease = Lease::acquire()?;
    let journal = Rc::new(RefCell::new(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(receipt)
            .map_err(|_| "receipt already exists or cannot be created; inspect before retry")?,
    ));
    append(
        &journal,
        json!({"event":"started","target":"nea-c/Nearly:nearly-updater-production","public_key_path":public,"private_backup":false,"process_id":std::process::id()}),
    )?;
    // The credential child and reader are fully reaped before register can
    // generate. No later code launches any child process.
    let credential = credential::existing()?;
    append(
        &journal,
        json!({"event":"existing_credential_acquired_no_value_recorded"}),
    )?;
    let api = credential.into_api()?;
    let mut api = Audited {
        api,
        journal: Rc::clone(&journal),
    };
    let mut record = Recorded {
        record,
        journal: Rc::clone(&journal),
    };
    match register(&mut api, &mut record) {
        Ok(()) => {
            append(
                &journal,
                json!({"event":"completed","confirmed_created":2,"final_metadata_verified":true}),
            )?;
            println!("Created and metadata-verified both Environment Secrets; public key saved. No secret values or backup retained.");
            Ok(())
        }
        Err(error) => {
            append(
                &journal,
                json!({"event":"stopped","stage":format!("{:?}",error.stage),"confirmed_created":error.confirmed_created,"outcome_uncertain":error.outcome_uncertain}),
            )?;
            eprintln!("Stopped at {:?}; confirmed creations: {}; uncertain: {}. Inspect receipt/metadata; no automatic retry.",error.stage,error.confirmed_created,error.outcome_uncertain);
            Err("registration stopped")
        }
    }
}
fn main() {
    std::panic::set_hook(Box::new(|_| {
        eprintln!("Registrar aborted; inspect public receipt and metadata before any retry.")
    }));
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
