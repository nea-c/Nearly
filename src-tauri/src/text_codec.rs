//! Strict byte-preserving text policy. Unknown formats are refused, never guessed.
pub const MAX_BYTES:usize=1024*1024;
#[derive(Clone,Copy)] enum Encoding{Utf8,Utf8Bom,Utf16Le,Utf16Be}
pub struct Decoded {pub text:String,encoding:Encoding,newline:&'static str}
pub fn decode(bytes:&[u8])->Result<Decoded,String>{
    if bytes.len()>MAX_BYTES{return Err("Text editor limit is 1 MiB".into());}
    let (encoding,text)=if bytes.starts_with(&[0xff,0xfe])||bytes.starts_with(&[0xfe,0xff]){
        if bytes.len()%2!=0{return Err("Invalid UTF-16 text".into());}
        let little=bytes[0]==0xff;
        let units:Vec<u16>=bytes[2..].chunks_exact(2).map(|c|if little{u16::from_le_bytes([c[0],c[1]])}else{u16::from_be_bytes([c[0],c[1]])}).collect();
        (if little{Encoding::Utf16Le}else{Encoding::Utf16Be},String::from_utf16(&units).map_err(|_|"Invalid UTF-16 text")?)
    }else{
        let bom=bytes.starts_with(&[0xef,0xbb,0xbf]);let data=if bom{&bytes[3..]}else{bytes};
        (if bom{Encoding::Utf8Bom}else{Encoding::Utf8},std::str::from_utf8(data).map_err(|_|"Unsupported text encoding; no automatic conversion was attempted")?.to_owned())
    };
    validate(&text)?;
    let mut kinds=[false;3];let b=text.as_bytes();let mut i=0;
    while i<b.len(){if b[i]==b'\r'{if b.get(i+1)==Some(&b'\n'){kinds[0]=true;i+=1;}else{kinds[1]=true;}}else if b[i]==b'\n'{kinds[2]=true;}i+=1;}
    if kinds.iter().filter(|v|**v).count()>1{return Err("Mixed line endings are read-only in this text editor; use an external editor".into());}
    let newline=if kinds[0]{"\r\n"}else if kinds[1]{"\r"}else{"\n"};
    Ok(Decoded{text:text.replace("\r\n","\n").replace('\r',"\n"),encoding,newline})
}
fn validate(text:&str)->Result<(),String>{if text.chars().any(|c|c.is_control()&&!matches!(c,'\t'|'\r'|'\n')){return Err("Binary or unsupported control characters; editing refused".into());}Ok(())}
impl Decoded {
    pub fn encoding(&self)->&'static str{match self.encoding{Encoding::Utf8=>"UTF-8",Encoding::Utf8Bom=>"UTF-8 BOM",Encoding::Utf16Le=>"UTF-16 LE BOM",Encoding::Utf16Be=>"UTF-16 BE BOM"}}
    pub fn newline(&self)->&'static str{match self.newline{"\r\n"=>"CRLF","\r"=>"CR",_=>"LF"}}
    pub fn encode(&self,text:&str)->Result<Vec<u8>,String>{
        if text.len()>MAX_BYTES*2||text.contains('\r'){return Err("Text too large or non-normalized line endings".into());}validate(text)?;
        let text=text.replace('\n',self.newline);let mut out=Vec::new();
        match self.encoding{
            Encoding::Utf8=>out.extend_from_slice(text.as_bytes()),
            Encoding::Utf8Bom=>{out.extend_from_slice(&[0xef,0xbb,0xbf]);out.extend_from_slice(text.as_bytes());},
            Encoding::Utf16Le|Encoding::Utf16Be=>{let little=matches!(self.encoding,Encoding::Utf16Le);out.extend_from_slice(if little{&[0xff,0xfe]}else{&[0xfe,0xff]});for unit in text.encode_utf16(){out.extend_from_slice(&if little{unit.to_le_bytes()}else{unit.to_be_bytes()});}}
        }
        if out.len()>MAX_BYTES{return Err("Text editor limit is 1 MiB".into());}Ok(out)
    }
}
#[cfg(test)] mod tests {
    #[test] fn utf8_crlf_bom_roundtrip_and_edit_keep_format(){
        let d=super::decode(b"\xef\xbb\xbfhello\r\nworld\r\n").unwrap();
        assert_eq!(d.text,"hello\nworld\n");assert_eq!(d.encode(&d.text).unwrap(),b"\xef\xbb\xbfhello\r\nworld\r\n");
        assert_eq!(d.encode("changed\n").unwrap(),b"\xef\xbb\xbfchanged\r\n");
    }
    #[test] fn unsupported_input_is_refused_instead_of_converted(){for input in [b"a\x00b".as_slice(),b"\x82\xa0",b"a\r\nb\nc",b"a\x01b"]{assert!(super::decode(input).is_err());}assert!(super::decode(&vec![b'a';1024*1024+1]).is_err());}
    #[test] fn utf16_bom_roundtrips_and_invalid_surrogates_are_refused(){
        for input in [vec![0xff,0xfe,0x41,0,13,0,10,0],vec![0xfe,0xff,0,0x41,0,13,0,10]]{let d=super::decode(&input).unwrap();assert_eq!(d.text,"A\n");assert_eq!(d.encode(&d.text).unwrap(),input);}
        for input in [vec![0xff,0xfe,0],vec![0xff,0xfe,0,0xd8],vec![0xff,0xfe,0,0xdc]]{assert!(super::decode(&input).is_err());}
    }
}
