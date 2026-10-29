//! Fixed process-lifetime HICONs for the five existing states. Windows borrows
//! these handles; keeping them alive avoids destroying an icon used by another window.
//! Both WM_SETICON slots are required: Tauri set_icon only updates ICON_SMALL.
use std::sync::Mutex;
use tauri::image::Image;
use windows::Win32::{Foundation::{HWND,LPARAM,WPARAM},UI::WindowsAndMessaging::{CreateIcon,DestroyIcon,HICON,SendMessageW,WM_SETICON,ICON_SMALL,ICON_BIG}};
static ICONS:Mutex<Option<[usize;5]>>=Mutex::new(None);
fn create(image:&Image<'_>)->Result<usize,String>{
 let (w,h)=(image.width() as usize,image.height() as usize);
 let mut bgra=image.rgba().to_vec();
 // CreateIcon's monochrome mask scanlines are WORD aligned (not DIB DWORD aligned).
 let stride=((w+15)/16)*2;
 let mut mask=vec![0u8;stride*h];
 for (i,p) in bgra.chunks_exact_mut(4).enumerate(){p.swap(0,2);if p[3]==0 {mask[(i/w)*stride+(i%w)/8]|=0x80>>((i%w)%8);}}
 unsafe{CreateIcon(None,w as i32,h as i32,1,32,mask.as_ptr(),bgra.as_ptr())}.map(|icon|icon.0 as usize).map_err(|e|e.to_string())
}
fn handles(images:[Image<'static>;5])->Result<[usize;5],String>{
 let mut cached=ICONS.lock().map_err(|_|"Icon cache lock failed")?;
 if let Some(icons)=*cached{return Ok(icons);}
  let mut result=[0;5];
  for (i,image) in images.iter().enumerate(){match create(image){Ok(icon)=>result[i]=icon,Err(e)=>{for value in &result[..i]{unsafe{let _=DestroyIcon(HICON(*value as *mut _));}}return Err(e);}}}
  *cached=Some(result);
  Ok(result)
}
pub fn apply(hwnd:HWND,index:usize,images:[Image<'static>;5])->Result<(),String>{
 let icons=handles(images)?;
 let icon=icons.get(index).ok_or("Invalid icon state")?;
 // The application owns hwnd; WM_SETICON does not take ownership of the HICON.
 unsafe{SendMessageW(hwnd,WM_SETICON,Some(WPARAM(ICON_SMALL as usize)),Some(LPARAM(*icon as isize)));SendMessageW(hwnd,WM_SETICON,Some(WPARAM(ICON_BIG as usize)),Some(LPARAM(*icon as isize)));}
 Ok(())
}

// Shell badges use the adopted composite's exact 16px corner, not a redesigned
// glyph. Restore r3.6's SetOverlayIcon path; the Shell chooses its placement.
fn badge_pixels(image:&Image<'_>)->Result<Image<'static>,String>{
 if image.width()!=32||image.height()!=32{return Err("Expected a 32px adopted composite".into());}
 let mut pixels=Vec::with_capacity(16*16*4);
 for y in 0..16usize{pixels.extend_from_slice(&image.rgba()[(y*32+16)*4..(y*32+32)*4]);}
 Ok(Image::new_owned(pixels,16,16))
}
static BADGES:Mutex<Option<[usize;4]>>=Mutex::new(None);
fn badge_handles(images:[Image<'static>;5])->Result<[usize;4],String>{
 let mut cache=BADGES.lock().map_err(|_|"Badge cache lock failed")?;
 if let Some(value)=*cache{return Ok(value);}
 let mut value=[0usize;4];
 for i in 0..4 {match badge_pixels(&images[i+1]).and_then(|image|create(&image)){
  Ok(handle)=>value[i]=handle,
  Err(error)=>{for handle in &value[..i]{unsafe{let _=DestroyIcon(HICON(*handle as *mut _));}}return Err(error);}
 }}
 *cache=Some(value);Ok(value)
}
fn overlay_handle(index:usize,images:[Image<'static>;5])->Result<HICON,String>{
 if index==0{return Ok(HICON::default());}
 badge_handles(images)?.get(index-1).copied().map(|h|HICON(h as *mut _)).ok_or("Invalid badge state".into())
}
pub fn apply_shell(hwnd:HWND,index:usize,images:[Image<'static>;5])->Result<(),String>{
 use windows::Win32::{System::Com::{CoInitializeEx,CoUninitialize,CoCreateInstance,COINIT_APARTMENTTHREADED,CLSCTX_INPROC_SERVER},UI::{Shell::{ITaskbarList3,TaskbarList},WindowsAndMessaging::IsWindow}};
 if !unsafe{IsWindow(Some(hwnd))}.as_bool(){return Err("Invalid badge window".into());}
 let icon=overlay_handle(index,images.clone())?;
 // Uncombined taskbars/Alt+Tab must not show both the composite and Shell badge.
 apply(hwnd,0,images)?;
 let initialized=unsafe{CoInitializeEx(None,COINIT_APARTMENTTHREADED)};
 if initialized.is_err()&&initialized!=windows::Win32::Foundation::RPC_E_CHANGED_MODE{return Err(initialized.to_string());}
 struct Com(bool);impl Drop for Com{fn drop(&mut self){if self.0{unsafe{CoUninitialize();}}}}
 let _com=Com(initialized.is_ok());
 let description=match index{0=>"",1=>"Syncing",2=>"Up to date",3=>"Sync error",4=>"Sync paused",_=>return Err("Invalid badge state".into())};
 let text:Vec<u16>=description.encode_utf16().chain(Some(0)).collect();
 let result=unsafe{(move||{let shell:ITaskbarList3=CoCreateInstance(&TaskbarList,None,CLSCTX_INPROC_SERVER)?;shell.HrInit()?;shell.SetOverlayIcon(hwnd,icon,windows::core::PCWSTR(text.as_ptr()))})()};
 result.map_err(|e:windows::core::Error|format!("SetOverlayIcon failed: {e}"))
}

// Track Shell button recreation on the owning UI thread. Do not restart
// Explorer or periodically flash/reset the badge. The next poll reapplies it.
use std::{collections::HashMap,sync::{OnceLock,atomic::{AtomicU64,Ordering}}};
use windows::{core::BOOL,Win32::Foundation::LRESULT};
static BUTTONS:Mutex<Option<HashMap<usize,u64>>>=Mutex::new(None);
static EPOCH:AtomicU64=AtomicU64::new(1);
const SUBCLASS:usize=0x4e424447;
type SubclassProc=unsafe extern "system" fn(HWND,u32,WPARAM,LPARAM,usize,usize)->LRESULT;
#[link(name="comctl32")]
unsafe extern "system"{
 fn SetWindowSubclass(hwnd:HWND,callback:Option<SubclassProc>,id:usize,data:usize)->BOOL;
 fn RemoveWindowSubclass(hwnd:HWND,callback:Option<SubclassProc>,id:usize)->BOOL;
 fn DefSubclassProc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM)->LRESULT;
}
fn button_message()->u32{static MESSAGE:OnceLock<u32>=OnceLock::new();*MESSAGE.get_or_init(||unsafe{windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW(windows::core::w!("TaskbarButtonCreated"))})}
unsafe extern "system" fn button_proc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM,_id:usize,_data:usize)->LRESULT{
 if message==button_message(){if let Ok(mut map)=BUTTONS.lock(){if let Some(value)=map.as_mut().and_then(|m|m.get_mut(&(hwnd.0 as usize))){*value=EPOCH.fetch_add(1,Ordering::Relaxed);}}}
 if message==windows::Win32::UI::WindowsAndMessaging::WM_NCDESTROY{
  if let Ok(mut map)=BUTTONS.lock(){if let Some(map)=map.as_mut(){map.remove(&(hwnd.0 as usize));}}
  unsafe{let _=RemoveWindowSubclass(hwnd,Some(button_proc),SUBCLASS);}
 }
 unsafe{DefSubclassProc(hwnd,message,wparam,lparam)}
}
pub fn button_epoch(hwnd:HWND)->Result<u64,String>{
 if button_message()==0{return Err("TaskbarButtonCreated registration failed".into());}
 let mut cache=BUTTONS.lock().map_err(|_|"Taskbar button lock failed")?;let map=cache.get_or_insert_with(HashMap::new);let key=hwnd.0 as usize;
 if let Some(value)=map.get(&key){return Ok(*value);}
 if !unsafe{SetWindowSubclass(hwnd,Some(button_proc),SUBCLASS,0)}.as_bool(){return Err("Taskbar recreation hook failed".into());}
 let epoch=EPOCH.fetch_add(1,Ordering::Relaxed);map.insert(key,epoch);Ok(epoch)
}
#[cfg(test)]mod tests{
 use super::*;
 fn images()->[Image<'static>;5]{[tauri::include_image!("./icons/icon-source.png"),tauri::include_image!("./icons/badges/sync.png"),tauri::include_image!("./icons/badges/done.png"),tauri::include_image!("./icons/badges/error.png"),tauri::include_image!("./icons/badges/paused.png")]}
 #[test]fn restored_shell_badges_keep_every_adopted_pixel_and_clear_with_null(){
  let images=images();
  for index in 1..5 {let badge=badge_pixels(&images[index]).unwrap();assert_eq!((badge.width(),badge.height()),(16,16));
   for y in 0..16usize {assert_eq!(&badge.rgba()[y*64..y*64+64],&images[index].rgba()[(y*32+16)*4..(y*32+32)*4]);}
   assert!(!overlay_handle(index,images.clone()).unwrap().is_invalid());
  }
  assert!(overlay_handle(0,images.clone()).unwrap().is_invalid());assert!(overlay_handle(5,images.clone()).is_err());
  assert!(apply_shell(HWND::default(),2,images).is_err());
 }
 #[test]fn recreation_hook_invalidates_unchanged_states_and_destroy_releases_window(){
  use windows::{core::w,Win32::UI::WindowsAndMessaging::{CreateWindowExW,DestroyWindow,WM_GETICON,WINDOW_EX_STYLE,WS_OVERLAPPED}};
  let create=||unsafe{CreateWindowExW(WINDOW_EX_STYLE::default(),w!("STATIC"),w!("Nearly isolated shell badge test"),WS_OVERLAPPED,0,0,32,32,None,None,None,None)}.unwrap();
  struct Window(HWND);impl Drop for Window{fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}
  let a=Window(create());let b=Window(create());let first=button_epoch(a.0).unwrap();let other=button_epoch(b.0).unwrap();
  assert_eq!(button_epoch(a.0).unwrap(),first);
  unsafe{SendMessageW(a.0,button_message(),None,None);}
  assert_ne!(button_epoch(a.0).unwrap(),first);assert_eq!(button_epoch(b.0).unwrap(),other);
  // Native COM results on hidden windows are API evidence, not Shell pixels.
  for state in [1,2,3,4,0,2] {apply_shell(a.0,state,images()).unwrap();
   let read=|slot|unsafe{SendMessageW(a.0,WM_GETICON,Some(WPARAM(slot)),None).0};
   assert_eq!(read(ICON_SMALL as usize),handles(images()).unwrap()[0] as isize);
   assert_eq!(read(ICON_BIG as usize),read(ICON_SMALL as usize));
  }
  let key=a.0.0 as usize;drop(a);assert!(!BUTTONS.lock().unwrap().as_ref().unwrap().contains_key(&key));
  let recreated=Window(create());assert_ne!(button_epoch(recreated.0).unwrap(),first);
 }
 #[test]fn native_handles_are_valid_fixed_and_reused(){
  let base=tauri::include_image!("./icons/icon-source.png");
  let images=[base,tauri::include_image!("./icons/badges/sync.png"),tauri::include_image!("./icons/badges/done.png"),tauri::include_image!("./icons/badges/error.png"),tauri::include_image!("./icons/badges/paused.png")];
  let first=handles(images.clone()).unwrap();
  for _ in 0..100{assert_eq!(handles(images.clone()).unwrap(),first);}
  assert!(first.iter().all(|h|*h!=0));
 }
 #[test]fn hidden_dummy_windows_receive_both_icon_slots_without_cross_window_changes(){
  use windows::{core::w,Win32::UI::WindowsAndMessaging::{CreateWindowExW,DestroyWindow,WM_GETICON,WINDOW_EX_STYLE,WS_OVERLAPPED}};
  let create=||unsafe{CreateWindowExW(WINDOW_EX_STYLE::default(),w!("STATIC"),w!("Nearly isolated icon test"),WS_OVERLAPPED,0,0,32,32,None,None,None,None)}.unwrap();
  let a=create();let b=create();
  struct Window(HWND);impl Drop for Window{fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}
  let (_a,_b)=(Window(a),Window(b));
  let images=[tauri::include_image!("./icons/icon-source.png"),tauri::include_image!("./icons/badges/sync.png"),tauri::include_image!("./icons/badges/done.png"),tauri::include_image!("./icons/badges/error.png"),tauri::include_image!("./icons/badges/paused.png")];
  let read=|hwnd,slot|unsafe{SendMessageW(hwnd,WM_GETICON,Some(WPARAM(slot as usize)),None).0};
  apply(a,3,images.clone()).unwrap();
  assert_ne!(read(a,ICON_SMALL),0);assert_eq!(read(a,ICON_SMALL),read(a,ICON_BIG));
  let error=read(a,ICON_BIG);
  assert_eq!(read(b,ICON_SMALL),0);assert_eq!(read(b,ICON_BIG),0);
  apply(b,1,images.clone()).unwrap();assert_ne!(read(b,ICON_BIG),error);assert_eq!(read(a,ICON_BIG),error);
  apply(a,0,images).unwrap();assert_ne!(read(a,ICON_BIG),error);
 }
}
