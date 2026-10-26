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
#[cfg(test)]mod tests{
 use super::*;
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
