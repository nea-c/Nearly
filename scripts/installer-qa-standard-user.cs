// Hosted CI only. PureSelfTest compiles this file without launching or changing
// any process token. The PS wrapper supplies the independent hosted-run gate.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class NearlyQaStandardUser {
  const uint TOKEN_QUERY=8, TokenElevation=20, TokenIntegrityLevel=25;
  const uint SE_GROUP_ENABLED=4, SE_GROUP_USE_FOR_DENY_ONLY=16;
  const uint CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400, EXTENDED_STARTUPINFO_PRESENT=0x80000, CREATE_NO_WINDOW=0x08000000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST=new IntPtr(0x20002);
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes {public IntPtr Sid;public uint Attributes;}
  [StructLayout(LayoutKind.Sequential)] struct GroupsOne {public uint Count;public SidAttributes First;}
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public uint Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo {public uint cb;public string Reserved;public string Desktop;public string Title;public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;public ushort Show,Reserved2;public IntPtr ReservedData,Input,Output,Error;}
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {public StartupInfo Info;public IntPtr Attributes;}
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr hProcess,hThread;public uint ProcessId,ThreadId;}
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,uint kind,IntPtr buffer,uint length,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,uint kind,IntPtr buffer,uint length);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr source,uint flags,uint disableCount,[In] SidAttributes[] disable,uint deleteCount,IntPtr delete,uint restrictedCount,IntPtr restricted,out IntPtr token);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSidW(string value,out IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern bool CopySid(uint length,IntPtr destination,IntPtr source);
  [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr first,IntPtr second);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetEnvironmentStringsW();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool FreeEnvironmentStringsW(IntPtr block);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr bytes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string file,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  static void Check(bool ok,string action){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),action);}
  static IntPtr Info(IntPtr token,uint kind){uint needed;GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);if(needed==0||needed>1048576)throw new Exception("Bounded token query required");IntPtr result=Marshal.AllocHGlobal((int)needed);try{Check(GetTokenInformation(token,kind,result,needed,out needed),"Token query");return result;}catch{Marshal.FreeHGlobal(result);throw;}}
  static int Scalar(IntPtr token,uint kind){IntPtr data=Info(token,kind);try{return Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
  static bool SameUser(IntPtr first,IntPtr second){IntPtr a=Info(first,1),b=Info(second,1);try{return EqualSid(Marshal.ReadIntPtr(a),Marshal.ReadIntPtr(b));}finally{Marshal.FreeHGlobal(a);Marshal.FreeHGlobal(b);}}
  static uint Integrity(IntPtr token){IntPtr data=Info(token,TokenIntegrityLevel);try{IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));if(count==0)throw new Exception("Missing integrity SID");return unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)count-1)));}finally{Marshal.FreeHGlobal(data);}}
  static void AdminState(IntPtr token,IntPtr admin,out bool enabled,out bool denyOnly){enabled=false;denyOnly=false;IntPtr data=Info(token,2);try{int count=Marshal.ReadInt32(data),offset=(int)Marshal.OffsetOf(typeof(GroupsOne),"First"),size=Marshal.SizeOf(typeof(SidAttributes));if(count<0||count>4096)throw new Exception("Bounded token groups required");for(int i=0;i<count;i++){SidAttributes item=Marshal.PtrToStructure<SidAttributes>(IntPtr.Add(data,offset+i*size));if(EqualSid(item.Sid,admin)){enabled=(item.Attributes&SE_GROUP_ENABLED)!=0;denyOnly=(item.Attributes&SE_GROUP_USE_FOR_DENY_ONLY)!=0;return;}}}finally{Marshal.FreeHGlobal(data);}}
  static void RequireStandard(bool elevated,uint integrity,bool adminEnabled,bool sameUser,bool sameSession){if(elevated||integrity!=8192||adminEnabled||!sameUser||!sameSession)throw new Exception("Expected same-user non-elevated medium token");}
  static bool VerifyStandard(IntPtr token,IntPtr parent,IntPtr admin){bool enabled,deny;AdminState(token,admin,out enabled,out deny);RequireStandard(Scalar(token,TokenElevation)!=0,Integrity(token),enabled,SameUser(token,parent),Scalar(token,12)==Scalar(parent,12));if(Scalar(token,12)==0)throw new Exception("Interactive user session required");return deny;}
  static void SetOwnerAndMedium(IntPtr token,IntPtr parent){IntPtr user=Info(parent,1),owner=Marshal.AllocHGlobal(IntPtr.Size),medium=IntPtr.Zero,label=IntPtr.Zero;try{Marshal.WriteIntPtr(owner,Marshal.ReadIntPtr(user));Check(SetTokenInformation(token,4,owner,(uint)IntPtr.Size),"Set filtered token owner");Check(ConvertStringSidToSidW("S-1-16-8192",out medium),"Medium integrity SID");uint sidSize=GetLengthSid(medium);int header=Marshal.SizeOf(typeof(SidAttributes));label=Marshal.AllocHGlobal(header+(int)sidSize);IntPtr sid=IntPtr.Add(label,header);Check(CopySid(sidSize,sid,medium),"Copy medium integrity SID");Marshal.StructureToPtr(new SidAttributes{Sid=sid,Attributes=0x20},label,false);Check(SetTokenInformation(token,TokenIntegrityLevel,label,(uint)header+sidSize),"Set medium integrity");}finally{Marshal.FreeHGlobal(user);Marshal.FreeHGlobal(owner);if(label!=IntPtr.Zero)Marshal.FreeHGlobal(label);if(medium!=IntPtr.Zero)LocalFree(medium);}}
  public static string Quote(string argument){if(argument==null||argument.IndexOf('\0')>=0)throw new ArgumentException("Invalid argument");StringBuilder result=new StringBuilder("\"");int slashes=0;foreach(char c in argument){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1).Append(c);}else{result.Append('\\',slashes).Append(c);}slashes=0;}return result.Append('\\',slashes*2).Append('"').ToString();}
  static string Command(string executable,string script,string[] arguments){StringBuilder command=new StringBuilder(Quote(executable));foreach(string value in new[]{"-NoProfile","-NonInteractive","-File",script})command.Append(' ').Append(Quote(value));foreach(string value in arguments)command.Append(' ').Append(Quote(value));if(command.Length>=32767)throw new ArgumentException("Bounded command line required");return command.ToString();}
  public static int Run(string executable,string script,string[] arguments,string directory,string log,int timeoutSeconds){
    IntPtr current=IntPtr.Zero,filtered=IntPtr.Zero,admin=IntPtr.Zero,environment=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,output=IntPtr.Zero,input=IntPtr.Zero,childToken=IntPtr.Zero;ProcessInfo child=new ProcessInfo();bool initialized=false,resumed=false;
    try{
      Check(OpenProcessToken(GetCurrentProcess(),0x8B,out current),"Open own token");Check(ConvertStringSidToSidW("S-1-5-32-544",out admin),"Administrators SID");
      // DISABLE_MAX_PRIVILEGE | LUA_TOKEN. The administrative group is explicitly
      // deny-only; LUA filtering must also clear TokenElevation, or fail closed.
      Check(CreateRestrictedToken(current,1|4,1,new[]{new SidAttributes{Sid=admin}},0,IntPtr.Zero,0,IntPtr.Zero,out filtered),"Create LUA restricted own token");SetOwnerAndMedium(filtered,current);VerifyStandard(filtered,current,admin);
      SecurityAttributes security=new SecurityAttributes{Length=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};
      output=CreateFileW(log,0x40000000,3,ref security,1,0x80,IntPtr.Zero);Check(output!=new IntPtr(-1),"Create exclusive guest log");
      input=CreateFileW("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero);Check(input!=new IntPtr(-1),"Open guest stdin");
      IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);if(bytes==IntPtr.Zero)throw new Exception("Handle-list size unavailable");attributes=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes),"Initialize handle allowlist");initialized=true;handles=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handles,output);Marshal.WriteIntPtr(handles,IntPtr.Size,input);Check(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero),"Set exact inherited handle allowlist");
      StartupInfoEx startup=new StartupInfoEx{Info=new StartupInfo{cb=(uint)Marshal.SizeOf(typeof(StartupInfoEx)),Desktop=@"winsta0\default",Flags=0x100,Input=input,Output=output,Error=output},Attributes=attributes};
      environment=GetEnvironmentStringsW();Check(environment!=IntPtr.Zero,"Copy exact controller environment");
      Check(CreateProcessAsUserW(filtered,executable,new StringBuilder(Command(executable,script,arguments)),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,environment,directory,ref startup,out child),"Create same-user guest suspended");
      Check(OpenProcessToken(child.hProcess,TOKEN_QUERY,out childToken),"Inspect suspended guest token");bool denyOnly=VerifyStandard(childToken,current,admin);
      Console.WriteLine("{\"schemaVersion\":1,\"kind\":\"installerQaStandardUser\",\"tokenElevation\":0,\"integrityRid\":8192,\"administratorsEnabled\":false,\"administratorsDenyOnly\":"+(denyOnly?"true":"false")+",\"sameUser\":true,\"sameSession\":true,\"desktop\":\"winsta0\\\\default\",\"childPid\":"+child.ProcessId+"}");
      Check(ResumeThread(child.hThread)!=0xffffffff,"Resume verified guest");resumed=true;uint wait=WaitForSingleObject(child.hProcess,checked((uint)timeoutSeconds*1000));if(wait==258)throw new TimeoutException("Standard-user guest timeout; processes and log retained for hosted evidence");Check(wait==0,"Wait for exact guest process");uint code;Check(GetExitCodeProcess(child.hProcess,out code),"Read exact guest exit code");return unchecked((int)code);
    } finally {
      // Only a launcher-owned, still-suspended and unexecuted child is cancelled.
      // Running guest/app descendants survive action completion and timeouts.
      if(child.hProcess!=IntPtr.Zero&&!resumed)TerminateProcess(child.hProcess,125);
      foreach(IntPtr handle in new[]{childToken,child.hThread,child.hProcess,input,output,filtered,current})if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1))CloseHandle(handle);
      if(environment!=IntPtr.Zero)FreeEnvironmentStringsW(environment);if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(admin!=IntPtr.Zero)LocalFree(admin);
    }
  }
  public static void PureSelfTest(){
    if(Quote("")!="\"\""||Quote("a b")!="\"a b\""||Quote("a\"b")!="\"a\\\"b\""||Quote("C:\\end\\")!="\"C:\\end\\\\\"")throw new Exception("CRT quoting failed");
    if(Command("C:\\pwsh.exe","C:\\日本語 space\\guest.ps1",new[]{"-Action","ui"}).IndexOf("日本語 space",StringComparison.Ordinal)<0)throw new Exception("Unicode argument lost");
    RequireStandard(false,8192,false,true,true);foreach(int invalid in new[]{0,1,2,3,4}){bool rejected=false;try{RequireStandard(invalid==0,invalid==1?12288u:8192u,invalid==2,invalid!=3,invalid!=4);}catch{rejected=true;}if(!rejected)throw new Exception("Unsafe token proof accepted");}
  }
}
