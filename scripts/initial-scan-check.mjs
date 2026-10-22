// Standalone pure filesystem regression/benchmark. Never starts Nearly or a server.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'test-results','initial-scan');fs.mkdirSync(out,{recursive:true});
const baseline=execFileSync('git',['show','c3c241e7bfeac1a80d284eb1f87182758db0722b:src-tauri/src/engine.rs'],{cwd:root,encoding:'utf8'});
const part=(a,b)=>baseline.slice(baseline.indexOf(a),baseline.indexOf(b,baseline.indexOf(a)));
const measure=s=>s.replaceAll('std::fs::read_dir(', 'crate::measured::read_dir(').replaceAll('std::fs::symlink_metadata(', 'crate::measured::symlink_metadata(').replaceAll('std::fs::File::open(', 'crate::measured::open(');
const previous=measure(part('fn reparse(', 'fn local_transfer_action(')+part('fn queue_directories(', 'fn directory_action(')+part('fn enqueue_at(', 'fn queue_removed<T>'));
const modulePath=path.join(root,'src-tauri','src','initial_scan.rs');
const optimized=fs.existsSync(modulePath)?measure(fs.readFileSync(modulePath,'utf8')):String.raw`
pub fn walk<F>(root:&Path,stop:&AtomicBool,rules:&crate::exclusion::Rules,recursive:bool,track:bool,mut emit:F)->Result<(),String> where F:FnMut(PathBuf,bool)->Result<(),String>{
 let mut q=HashMap::new();scan(root,root,&mut q,stop,rules,recursive)?;
 let mut dirs=HashMap::new();if track&&recursive{queue_directories(root,root,&mut q,&mut dirs,stop,rules,Instant::now())?;}
 for p in q.keys(){emit(p.clone(),dirs.contains_key(p))?;}Ok(())
}`;
const code=String.raw`
use std::{collections::HashMap,path::{Path,PathBuf},sync::atomic::{AtomicBool,AtomicUsize,Ordering},time::Instant};
static READS:AtomicUsize=AtomicUsize::new(0); static METAS:AtomicUsize=AtomicUsize::new(0); static OPENS:AtomicUsize=AtomicUsize::new(0);
mod measured { use super::*; pub fn read_dir(p:impl AsRef<Path>)->std::io::Result<std::fs::ReadDir>{READS.fetch_add(1,Ordering::Relaxed);std::fs::read_dir(p)} pub fn symlink_metadata(p:impl AsRef<Path>)->std::io::Result<std::fs::Metadata>{METAS.fetch_add(1,Ordering::Relaxed);std::fs::symlink_metadata(p)} pub fn open(p:impl AsRef<Path>)->std::io::Result<std::fs::File>{OPENS.fetch_add(1,Ordering::Relaxed);std::fs::File::open(p)} }
mod sftp {pub struct RemoteDirectoryStamp;}
mod exclusion {use super::*;pub struct Rules;impl Rules{pub fn compile(_: &str)->Result<Self,String>{Ok(Self)}pub fn excludes(&self,p:&Path,_:bool)->Result<bool,String>{Ok(p.components().any(|c|c.as_os_str()=="excluded"))}}}
mod file_ops {use super::*;pub fn check(s:&AtomicBool)->Result<(),String>{if s.load(Ordering::Relaxed){Err("Operation stopped".into())}else{Ok(())}}}
struct Pending{first:Instant,last:Instant,attempt:u8}
fn counters()->(usize,usize,usize){(READS.swap(0,Ordering::Relaxed),METAS.swap(0,Ordering::Relaxed),OPENS.swap(0,Ordering::Relaxed))}
BASELINE
mod initial_scan {use super::*;OPTIMIZED}
fn fixture(name:&str)->PathBuf{let p=std::env::current_dir().unwrap().join(name);std::fs::create_dir_all(&p).unwrap();p}
#[test]fn combined_scan_does_not_read_every_directory_twice(){let p=fixture("single-pass");std::fs::create_dir_all(p.join("child")).unwrap();std::fs::write(p.join("a"),b"a").unwrap();std::fs::write(p.join("child/b"),b"b").unwrap();counters();let mut v=Vec::new();initial_scan::walk(&p,&AtomicBool::new(false),&exclusion::Rules,true,true,|p,d|{v.push((p,d));Ok(())}).unwrap();let c=counters();assert_eq!(v.len(),3);assert_eq!(c.0,2,"directory enumeration must be once per directory");assert!(c.1<=5,"metadata must not revisit all files");assert_eq!(c.2,2);}
#[test]fn non_recursive_stays_at_root(){let p=fixture("nonrecursive");std::fs::create_dir_all(p.join("child")).unwrap();std::fs::write(p.join("a"),b"a").unwrap();std::fs::write(p.join("child/b"),b"b").unwrap();let mut v=Vec::new();initial_scan::walk(&p,&AtomicBool::new(false),&exclusion::Rules,false,true,|p,d|{v.push((p,d));Ok(())}).unwrap();assert_eq!(v,vec![(PathBuf::from("a"),false)]);}
#[test]fn excluded_parent_and_children_are_out_of_scope(){let p=fixture("excluded-test");std::fs::create_dir_all(p.join("excluded")).unwrap();std::fs::write(p.join("excluded/secret"),b"a").unwrap();let mut v=Vec::new();initial_scan::walk(&p,&AtomicBool::new(false),&exclusion::Rules,true,true,|p,d|{v.push((p,d));Ok(())}).unwrap();assert!(v.is_empty());}
#[test]fn cancellation_never_reports_complete_inventory(){let p=fixture("cancel");assert!(initial_scan::walk(&p,&AtomicBool::new(true),&exclusion::Rules,true,true,|_,_|Ok(())).is_err());}
#[test]fn callback_error_aborts_snapshot(){let p=fixture("callback-error");std::fs::write(p.join("a"),b"a").unwrap();assert_eq!(initial_scan::walk(&p,&AtomicBool::new(false),&exclusion::Rules,true,true,|_,_|Err("capacity".into())).unwrap_err().to_string(),"capacity");}
#[cfg(windows)]#[test]fn unreadable_file_cannot_complete_inventory(){use std::os::windows::fs::OpenOptionsExt;let p=fixture("locked");std::fs::write(p.join("a"),b"a").unwrap();let _held=std::fs::OpenOptions::new().read(true).share_mode(0).open(p.join("a")).unwrap();let mut emitted=0;let r=initial_scan::walk(&p,&AtomicBool::new(false),&exclusion::Rules,true,true,|_,_|{emitted+=1;Ok(())});assert!(r.unwrap_err().to_string().contains("initial scan incomplete"));assert_eq!(emitted,0);}
fn main(){println!("files,run,before_ms,after_ms,before_read_dir,after_read_dir,before_metadata,after_metadata,before_open,after_open");for n in [100usize,1000,5000]{let p=fixture(&format!("bench-{n}"));for i in 0..n{let d=p.join(format!("d{}",i/100));std::fs::create_dir_all(&d).unwrap();std::fs::write(d.join(format!("f{i}")),b"synthetic").unwrap();}for run in 0..5{let before=||{let mut q=HashMap::new();let mut dirs=HashMap::new();scan(&p,&p,&mut q,&AtomicBool::new(false),&exclusion::Rules,true).unwrap();queue_directories(&p,&p,&mut q,&mut dirs,&AtomicBool::new(false),&exclusion::Rules,Instant::now()).unwrap();q.keys().map(|p|(p.clone(),dirs.contains_key(p))).collect::<std::collections::HashSet<_>>()};let after=||{let mut q=std::collections::HashSet::new();initial_scan::walk(&p,&AtomicBool::new(false),&exclusion::Rules,true,true,|p,d|{q.insert((p,d));Ok(())}).unwrap();q};counters();let t=Instant::now();let b=before();let bm=t.elapsed().as_secs_f64()*1000.;let bc=counters();let t=Instant::now();let a=after();let am=t.elapsed().as_secs_f64()*1000.;let ac=counters();assert_eq!(a,b);println!("{n},{run},{bm:.3},{am:.3},{},{},{},{},{},{}",bc.0,ac.0,bc.1,ac.1,bc.2,ac.2);}}}
`.replace('BASELINE',previous).replace('OPTIMIZED',optimized.replace(/^use [\s\S]*?;\r?\n/,' '));
const rust=path.join(out,'harness.rs');fs.writeFileSync(rust,code);
execFileSync('rustc',['--edition=2021','--test',rust,'-o',path.join(out,'checks.exe')],{stdio:'inherit'});
execFileSync(path.join(out,'checks.exe'),['--test-threads=1'],{cwd:out,stdio:'inherit'});
if(process.argv.includes('--benchmark')){execFileSync('rustc',['--edition=2021','-O',rust,'-o',path.join(out,'bench.exe')],{stdio:'inherit'});const result=execFileSync(path.join(out,'bench.exe'),[],{cwd:out,encoding:'utf8'});fs.writeFileSync(path.join(out,'before-after.csv'),result);process.stdout.write(result);}


