// Hosted CI only. PureSelfTest compiles this file without launching or changing
// any process token. The PS wrapper supplies the independent hosted-run gate.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;

public static class NearlyQaStandardUser {
  const uint TOKEN_QUERY=8, TokenElevation=20, TokenIntegrityLevel=25,TokenDefaultDacl=6;
  const uint SE_GROUP_ENABLED=4, SE_GROUP_USE_FOR_DENY_ONLY=16;
  const uint CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400, EXTENDED_STARTUPINFO_PRESENT=0x80000, CREATE_NO_WINDOW=0x08000000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST=new IntPtr(0x20002);
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes {public IntPtr Sid;public uint Attributes;}
  [StructLayout(LayoutKind.Sequential)] struct GroupsOne {public uint Count;public SidAttributes First;}
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public uint Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo {public uint cb;public string Reserved;public string Desktop;public string Title;public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;public ushort Show,Reserved2;public IntPtr ReservedData,Input,Output,Error;}
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {public StartupInfo Info;public IntPtr Attributes;}
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr hProcess,hThread;public uint ProcessId,ThreadId;}
  [StructLayout(LayoutKind.Sequential)] struct GenericMapping {public uint Read,Write,Execute,All;}
  struct AccessProof {
    public bool Allowed,MinimumAllowed;public uint GrantedMask,DesiredMask,MinimumMask,Error;
    public string Json(){return "{\"allowed\":"+(Allowed?"true":"false")+",\"minimumAllowed\":"+(MinimumAllowed?"true":"false")+",\"grantedMask\":"+GrantedMask+",\"desiredMask\":"+DesiredMask+",\"minimumMask\":"+MinimumMask+",\"error\":"+Error+"}";}
  }
  struct LabelProof {
    public bool Present;public uint Rid,Policy,Error;
    public string Json(){return "{\"present\":"+(Present?"true":"false")+",\"mandatoryLabelRid\":"+Rid+",\"policyMask\":"+Policy+",\"noWriteUp\":"+((Policy&1)!=0?"true":"false")+",\"error\":"+Error+"}";}
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,uint kind,IntPtr buffer,uint length,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,uint kind,IntPtr buffer,uint length);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr source,uint flags,uint disableCount,[In] SidAttributes[] disable,uint deleteCount,IntPtr delete,uint restrictedCount,IntPtr restricted,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr source,uint access,IntPtr attributes,uint level,uint kind,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(IntPtr descriptor,IntPtr token,uint desired,ref GenericMapping mapping,IntPtr privileges,ref uint privilegeBytes,out uint granted,[MarshalAs(UnmanagedType.Bool)]out bool allowed);
  [DllImport("advapi32.dll")] static extern void MapGenericMask(ref uint desired,ref GenericMapping mapping);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,uint type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool InitializeSecurityDescriptor(IntPtr descriptor,uint revision);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetSecurityDescriptorOwner(IntPtr descriptor,IntPtr owner,bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetSecurityDescriptorGroup(IntPtr descriptor,IntPtr group,bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetSecurityDescriptorDacl(IntPtr descriptor,bool present,IntPtr dacl,bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenWindowStationW(string name,bool inherit,uint access);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktopW(string name,uint flags,bool inherit,uint access);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr handle,ref uint info,IntPtr descriptor,uint bytes,out uint needed);
  [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr handle);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
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
  static AccessProof DescriptorAccess(IntPtr descriptor,IntPtr impersonation,int kind){
    GenericMapping mapping=DiagnosticMapping(kind);uint desired=0x02000000,minimum=DiagnosticMinimum(kind);
    NormalizeSnapshotDacl(descriptor,mapping);
    uint bytes=4096,granted;bool allowed;IntPtr privileges=Marshal.AllocHGlobal((int)bytes);
    try{bool success=AccessCheck(descriptor,impersonation,desired,ref mapping,privileges,ref bytes,out granted,out allowed);return new AccessProof{Allowed=success&&allowed&&(granted&mapping.All)==mapping.All,MinimumAllowed=success&&allowed&&(granted&minimum)==minimum,GrantedMask=success?granted:0,DesiredMask=mapping.All,MinimumMask=minimum,Error=success?0:unchecked((uint)Marshal.GetLastWin32Error())};}finally{Marshal.FreeHGlobal(privileges);}
  }
  static uint MapSnapshotMask(uint mask,GenericMapping mapping){uint result=mask&0x0fffffff;if((mask&0x80000000)!=0)result|=mapping.Read;if((mask&0x40000000)!=0)result|=mapping.Write;if((mask&0x20000000)!=0)result|=mapping.Execute;if((mask&0x10000000)!=0)result|=mapping.All;return result;}
  // All descriptors passed here are private in-memory snapshots returned by
  // GetSecurityInfo/GetUserObjectSecurity or built from a copied token query.
  // AccessCheck requires generic ACE rights mapped to this object's type.
  // This only changes these snapshots; no object security setter is called.
  static void NormalizeSnapshotDacl(IntPtr descriptor,GenericMapping mapping){
    bool present,defaulted;IntPtr acl;Check(GetSecurityDescriptorDacl(descriptor,out present,out acl,out defaulted),"Read private descriptor DACL");if(!present||acl==IntPtr.Zero)return;
    int bytes=unchecked((ushort)Marshal.ReadInt16(acl,2)),count=unchecked((ushort)Marshal.ReadInt16(acl,4)),offset=8;if(bytes<8)throw new Exception("Invalid private ACL snapshot");
    for(int i=0;i<count;i++){if(offset>bytes-4)throw new Exception("Truncated private ACL snapshot");IntPtr ace=IntPtr.Add(acl,offset);int size=unchecked((ushort)Marshal.ReadInt16(ace,2));if(size<8||size>bytes-offset)throw new Exception("Invalid private ACE snapshot");byte type=Marshal.ReadByte(ace);if(type==0||type==1||type==5||type==6||type==9||type==10||type==11||type==12)Marshal.WriteInt32(ace,4,unchecked((int)MapSnapshotMask(unchecked((uint)Marshal.ReadInt32(ace,4)),mapping)));offset+=size;}
  }
  // User object mappings are published in Microsoft's window-station/desktop
  // security-and-access-rights documentation. Kernel maps are type-specific:
  // process query/VM vs thread context/query and their respective write rights.
  static GenericMapping DiagnosticMapping(int kind){
    switch(kind){
      case 0:return new GenericMapping{Read=0x20303,Write=0x2001c,Execute=0x20060,All=0xf037f};
      case 1:return new GenericMapping{Read=0x20041,Write=0x200be,Execute=0x20100,All=0xf01ff};
      case 2:return new GenericMapping{Read=0x20410,Write=0x203eb,Execute=0x120000,All=0x1fffff};
      case 3:return new GenericMapping{Read=0x20048,Write=0x203b3,Execute=0x120000,All=0x1fffff};
      default:throw new ArgumentException("Unknown diagnostic object kind");
    }
  }
  static uint DiagnosticMinimum(int kind){switch(kind){case 0:return 0x22;case 1:return 0xc3;case 2:return 0x100400;case 3:return 0x100040;default:throw new ArgumentException("Unknown diagnostic object kind");}}
  static AccessProof UserObjectAccess(IntPtr handle,IntPtr impersonation,int kind){
    if(handle==IntPtr.Zero)return new AccessProof{Error=unchecked((uint)Marshal.GetLastWin32Error())};
    uint info=7,needed;GetUserObjectSecurity(handle,ref info,IntPtr.Zero,0,out needed);
    if(needed==0||needed>1048576)return new AccessProof{Error=unchecked((uint)Marshal.GetLastWin32Error())};IntPtr descriptor=Marshal.AllocHGlobal((int)needed);
    try{if(!GetUserObjectSecurity(handle,ref info,descriptor,needed,out needed))return new AccessProof{Error=unchecked((uint)Marshal.GetLastWin32Error())};return DescriptorAccess(descriptor,impersonation,kind);}finally{Marshal.FreeHGlobal(descriptor);}
  }
  static AccessProof KernelObjectAccess(IntPtr handle,IntPtr impersonation,int kind){
    IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(handle,6,7,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)return new AccessProof{Error=error};try{return DescriptorAccess(descriptor,impersonation,kind);}finally{LocalFree(descriptor);}
  }
  static AccessProof DefaultDaclAccess(IntPtr token,IntPtr impersonation){
    IntPtr dacl=Info(token,6),user=Info(token,1),descriptor=Marshal.AllocHGlobal(64);
    try{Check(InitializeSecurityDescriptor(descriptor,1),"Initialize private diagnostic descriptor");Check(SetSecurityDescriptorOwner(descriptor,Marshal.ReadIntPtr(user),false),"Set diagnostic owner in memory");Check(SetSecurityDescriptorGroup(descriptor,Marshal.ReadIntPtr(user),false),"Set diagnostic group in memory");Check(SetSecurityDescriptorDacl(descriptor,true,Marshal.ReadIntPtr(dacl),false),"Set diagnostic DACL in memory");return DescriptorAccess(descriptor,impersonation,2);}finally{Marshal.FreeHGlobal(descriptor);Marshal.FreeHGlobal(user);Marshal.FreeHGlobal(dacl);}
  }
  // LABEL_SECURITY_INFORMATION is read-only and needs READ_CONTROL rather than
  // enabling SeSecurityPrivilege. Unavailable labels remain explicit unknowns.
  static LabelProof ParseLabel(IntPtr descriptor){
    bool present,defaulted;IntPtr acl;if(!GetSecurityDescriptorSacl(descriptor,out present,out acl,out defaulted))return new LabelProof{Error=unchecked((uint)Marshal.GetLastWin32Error())};
    if(!present||acl==IntPtr.Zero)return new LabelProof();
    int bytes=unchecked((ushort)Marshal.ReadInt16(acl,2)),count=unchecked((ushort)Marshal.ReadInt16(acl,4)),offset=8;
    if(bytes<8)return new LabelProof{Error=1336};
    for(int i=0;i<count;i++){
      if(offset>bytes-4)return new LabelProof{Error=1336};IntPtr ace=IntPtr.Add(acl,offset);int size=unchecked((ushort)Marshal.ReadInt16(ace,2));if(size<4||size>bytes-offset)return new LabelProof{Error=1336};
      if(Marshal.ReadByte(ace)==0x11){
        // SYSTEM_MANDATORY_LABEL_ACE: header, mask, S-1-16-RID.
        if(size!=20||Marshal.ReadByte(ace,8)!=1||Marshal.ReadByte(ace,9)!=1||Marshal.ReadByte(ace,15)!=16)return new LabelProof{Error=1337};
        for(int n=10;n<15;n++)if(Marshal.ReadByte(ace,n)!=0)return new LabelProof{Error=1337};
        return new LabelProof{Present=true,Rid=unchecked((uint)Marshal.ReadInt32(ace,16)),Policy=unchecked((uint)Marshal.ReadInt32(ace,4))};
      }
      offset+=size;
    }
    return new LabelProof();
  }
  static LabelProof LabelAccess(IntPtr handle,bool userObject){
    if(handle==IntPtr.Zero)return new LabelProof{Error=6};
    if(userObject){uint info=0x10,needed;GetUserObjectSecurity(handle,ref info,IntPtr.Zero,0,out needed);if(needed==0||needed>1048576)return new LabelProof{Error=unchecked((uint)Marshal.GetLastWin32Error())};IntPtr sd=Marshal.AllocHGlobal((int)needed);try{if(!GetUserObjectSecurity(handle,ref info,sd,needed,out needed))return new LabelProof{Error=unchecked((uint)Marshal.GetLastWin32Error())};return ParseLabel(sd);}finally{Marshal.FreeHGlobal(sd);}}
    IntPtr owner,group,dacl,sacl,descriptor;uint error=GetSecurityInfo(handle,6,0x10,out owner,out group,out dacl,out sacl,out descriptor);if(error!=0)return new LabelProof{Error=error};try{return ParseLabel(descriptor);}finally{LocalFree(descriptor);}
  }
  static void EmitStartupAccessDiagnostics(IntPtr filtered,IntPtr parent,IntPtr process,IntPtr thread){
    IntPtr impersonation=IntPtr.Zero,station=IntPtr.Zero,desktop=IntPtr.Zero;
    try{
      Check(DuplicateTokenEx(filtered,TOKEN_QUERY|4,IntPtr.Zero,2,2,out impersonation),"Duplicate own filtered token for read-only AccessCheck");
      station=OpenWindowStationW("WinSta0",false,0x20000);AccessProof stationProof=UserObjectAccess(station,impersonation,0);
      desktop=OpenDesktopW("Default",0,false,0x20000);AccessProof desktopProof=UserObjectAccess(desktop,impersonation,1);
      AccessProof defaultProof=DefaultDaclAccess(filtered,impersonation),processProof=KernelObjectAccess(process,impersonation,2),threadProof=KernelObjectAccess(thread,impersonation,3);
      Console.WriteLine("{\"schemaVersion\":1,\"kind\":\"installerQaStartupAccess\",\"windowStation\":"+stationProof.Json()+",\"desktopAccess\":"+desktopProof.Json()+",\"tokenDefaultDacl\":"+defaultProof.Json()+",\"childProcess\":"+processProof.Json()+",\"childThread\":"+threadProof.Json()+"}");
      Console.WriteLine("{\"schemaVersion\":1,\"kind\":\"installerQaStartupLabels\",\"windowStation\":"+LabelAccess(station,true).Json()+",\"desktopAccess\":"+LabelAccess(desktop,true).Json()+",\"childProcess\":"+LabelAccess(process,false).Json()+",\"childThread\":"+LabelAccess(thread,false).Json()+"}");
      RequireChildObjectAccess(processProof,threadProof);
    }finally{if(desktop!=IntPtr.Zero)CloseDesktop(desktop);if(station!=IntPtr.Zero)CloseWindowStation(station);if(impersonation!=IntPtr.Zero)CloseHandle(impersonation);}
  }
  static void SetOwnerAndMedium(IntPtr token,IntPtr parent){IntPtr user=Info(parent,1),owner=Marshal.AllocHGlobal(IntPtr.Size),medium=IntPtr.Zero,label=IntPtr.Zero;try{Marshal.WriteIntPtr(owner,Marshal.ReadIntPtr(user));Check(SetTokenInformation(token,4,owner,(uint)IntPtr.Size),"Set filtered token owner");Check(ConvertStringSidToSidW("S-1-16-8192",out medium),"Medium integrity SID");uint sidSize=GetLengthSid(medium);int header=Marshal.SizeOf(typeof(SidAttributes));label=Marshal.AllocHGlobal(header+(int)sidSize);IntPtr sid=IntPtr.Add(label,header);Check(CopySid(sidSize,sid,medium),"Copy medium integrity SID");Marshal.StructureToPtr(new SidAttributes{Sid=sid,Attributes=0x20},label,false);Check(SetTokenInformation(token,TokenIntegrityLevel,label,(uint)header+sidSize),"Set medium integrity");}finally{Marshal.FreeHGlobal(user);Marshal.FreeHGlobal(owner);if(label!=IntPtr.Zero)Marshal.FreeHGlobal(label);if(medium!=IntPtr.Zero)LocalFree(medium);}}
  public static string Quote(string argument){if(argument==null||argument.IndexOf('\0')>=0)throw new ArgumentException("Invalid argument");StringBuilder result=new StringBuilder("\"");int slashes=0;foreach(char c in argument){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1).Append(c);}else{result.Append('\\',slashes).Append(c);}slashes=0;}return result.Append('\\',slashes*2).Append('"').ToString();}
  static string Command(string executable,string script,string[] arguments){StringBuilder command=new StringBuilder(Quote(executable));foreach(string value in new[]{"-NoProfile","-NonInteractive","-File",script})command.Append(' ').Append(Quote(value));foreach(string value in arguments)command.Append(' ').Append(Quote(value));if(command.Length>=32767)throw new ArgumentException("Bounded command line required");return command.ToString();}
  public static int Run(string executable,string script,string[] arguments,string directory,string log,int timeoutSeconds){
    IntPtr current=IntPtr.Zero,filtered=IntPtr.Zero,admin=IntPtr.Zero,environment=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,output=IntPtr.Zero,input=IntPtr.Zero,childToken=IntPtr.Zero;ProcessInfo child=new ProcessInfo();bool initialized=false,resumed=false;
    try{
      Check(OpenProcessToken(GetCurrentProcess(),0x8B,out current),"Open own token");Check(ConvertStringSidToSidW("S-1-5-32-544",out admin),"Administrators SID");
      // DISABLE_MAX_PRIVILEGE | LUA_TOKEN. The administrative group is explicitly
      // deny-only; LUA filtering must also clear TokenElevation, or fail closed.
      Check(CreateRestrictedToken(current,1|4,1,new[]{new SidAttributes{Sid=admin}},0,IntPtr.Zero,0,IntPtr.Zero,out filtered),"Create LUA restricted own token");SetOwnerAndMedium(filtered,current);SetFilteredDefaultDacl(filtered,current);VerifyStandard(filtered,current,admin);
      SecurityAttributes security=new SecurityAttributes{Length=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=true};
      output=CreateFileW(log,0x40000000,3,ref security,1,0x80,IntPtr.Zero);Check(output!=new IntPtr(-1),"Create exclusive guest log");
      input=CreateFileW("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero);Check(input!=new IntPtr(-1),"Open guest stdin");
      IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);if(bytes==IntPtr.Zero)throw new Exception("Handle-list size unavailable");attributes=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes),"Initialize handle allowlist");initialized=true;handles=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handles,output);Marshal.WriteIntPtr(handles,IntPtr.Size,input);Check(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero),"Set exact inherited handle allowlist");
      StartupInfoEx startup=new StartupInfoEx{Info=new StartupInfo{cb=(uint)Marshal.SizeOf(typeof(StartupInfoEx)),Desktop=@"winsta0\default",Flags=0x100,Input=input,Output=output,Error=output},Attributes=attributes};
      environment=GetEnvironmentStringsW();Check(environment!=IntPtr.Zero,"Copy exact controller environment");
      Check(CreateProcessAsUserW(filtered,executable,new StringBuilder(Command(executable,script,arguments)),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,environment,directory,ref startup,out child),"Create same-user guest suspended");
      Check(OpenProcessToken(child.hProcess,TOKEN_QUERY,out childToken),"Inspect suspended guest token");bool denyOnly=VerifyStandard(childToken,current,admin);
      EmitStartupAccessDiagnostics(filtered,current,child.hProcess,child.hThread);
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
    string testUser="S-1-5-21-11-22-33-1001";
    RawSecurityDescriptor privateDescriptor=new RawSecurityDescriptor(BuildDefaultDaclSddl(testUser));
    if(privateDescriptor.DiscretionaryAcl==null||privateDescriptor.DiscretionaryAcl.Count!=3||(privateDescriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw new Exception("Expected private three-principal default DACL");
    string[] expectedSids={testUser,"S-1-5-18","S-1-5-32-544"};
    for(int i=0;i<3;i++){CommonAce ace=privateDescriptor.DiscretionaryAcl[i] as CommonAce;if(ace==null||ace.AceQualifier!=AceQualifier.AccessAllowed||ace.AceFlags!=AceFlags.None||unchecked((uint)ace.AccessMask)!=0x10000000||ace.SecurityIdentifier.Value!=expectedSids[i])throw new Exception("Unsafe default DACL template");}
    byte[] templateBytes=new byte[privateDescriptor.BinaryLength];privateDescriptor.GetBinaryForm(templateBytes,0);IntPtr template=Marshal.AllocHGlobal(templateBytes.Length);
    try{Marshal.Copy(templateBytes,0,template,templateBytes.Length);NormalizeSnapshotDacl(template,DiagnosticMapping(2));Marshal.Copy(template,templateBytes,0,templateBytes.Length);RawSecurityDescriptor mapped=new RawSecurityDescriptor(templateBytes,0);for(int i=0;i<3;i++)if(unchecked((uint)((CommonAce)mapped.DiscretionaryAcl[i]).AccessMask)!=DiagnosticMapping(2).All)throw new Exception("Generic all was not mapped in private snapshot");}finally{Marshal.FreeHGlobal(template);}
    if(MapSnapshotMask(0xa0000000,DiagnosticMapping(2))!=0x120410||MapSnapshotMask(0x80000000,DiagnosticMapping(1))!=0x20041||MapSnapshotMask(0x120410,DiagnosticMapping(2))!=0x120410)throw new Exception("Generic read/execute snapshot mapping regressed");
    foreach(string invalid in new[]{"",testUser+")(A;;GA;;;WD)","WD","S-1-5-32-544"}){bool rejected=false;try{BuildDefaultDaclSddl(invalid);}catch{rejected=true;}if(!rejected)throw new Exception("Unsafe current user SID accepted");}
    RequireChildObjectAccess(new AccessProof{Allowed=true},new AccessProof{Allowed=true});
    foreach(int denied in new[]{0,1}){bool rejected=false;try{RequireChildObjectAccess(new AccessProof{Allowed=denied!=0},new AccessProof{Allowed=denied!=1});}catch{rejected=true;}if(!rejected)throw new Exception("Insufficient suspended-object access accepted");}
    bool errored=false;try{RequireChildObjectAccess(new AccessProof{Allowed=true,Error=5},new AccessProof{Allowed=true});}catch{errored=true;}if(!errored)throw new Exception("Object access query error accepted");
    for(int kind=0;kind<4;kind++){GenericMapping mapping=DiagnosticMapping(kind);if(mapping.Read==mapping.All||mapping.Write==mapping.All||mapping.Execute==mapping.All||(DiagnosticMinimum(kind)&mapping.All)!=DiagnosticMinimum(kind))throw new Exception("Invalid object-specific generic mapping");}
    if(DiagnosticMapping(0).Read!=0x20303||DiagnosticMapping(0).Write!=0x2001c||DiagnosticMapping(0).Execute!=0x20060||DiagnosticMapping(1).Read!=0x20041||DiagnosticMapping(1).Write!=0x200be||DiagnosticMapping(1).Execute!=0x20100||DiagnosticMinimum(0)!=0x22||DiagnosticMinimum(1)!=0xc3||DiagnosticMapping(2).Read==DiagnosticMapping(3).Read)throw new Exception("Object-specific diagnostic masks regressed");
    if(Quote("")!="\"\""||Quote("a b")!="\"a b\""||Quote("a\"b")!="\"a\\\"b\""||Quote("C:\\end\\")!="\"C:\\end\\\\\"")throw new Exception("CRT quoting failed");
    if(Command("C:\\pwsh.exe","C:\\日本語 space\\guest.ps1",new[]{"-Action","ui"}).IndexOf("日本語 space",StringComparison.Ordinal)<0)throw new Exception("Unicode argument lost");
    RequireStandard(false,8192,false,true,true);foreach(int invalid in new[]{0,1,2,3,4}){bool rejected=false;try{RequireStandard(invalid==0,invalid==1?12288u:8192u,invalid==2,invalid!=3,invalid!=4);}catch{rejected=true;}if(!rejected)throw new Exception("Unsafe token proof accepted");}
  }
  static string BuildDefaultDaclSddl(string user){
    // Account SID only, obtained from our actual TokenUser in production.
    SecurityIdentifier sid=new SecurityIdentifier(user);if(sid.Value!=user||!sid.IsAccountSid()||!user.StartsWith("S-1-5-21-",StringComparison.Ordinal))throw new ArgumentException("Expected exact current-user account SID");
    return "D:P(A;;GA;;;"+sid.Value+")(A;;GA;;;SY)(A;;GA;;;BA)";
  }
  static void SetFilteredDefaultDacl(IntPtr filtered,IntPtr parent){
    IntPtr user=Info(parent,1),descriptor=IntPtr.Zero,tokenDacl=IntPtr.Zero;
    try{
      string sid=new SecurityIdentifier(Marshal.ReadIntPtr(user)).Value;RawSecurityDescriptor sd=new RawSecurityDescriptor(BuildDefaultDaclSddl(sid));byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);descriptor=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,descriptor,bytes.Length);
      bool present,defaulted;IntPtr acl;Check(GetSecurityDescriptorDacl(descriptor,out present,out acl,out defaulted),"Read private default DACL template");if(!present||acl==IntPtr.Zero)throw new Exception("Private default DACL required");
      tokenDacl=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(tokenDacl,acl);
      // Only this newly created, launcher-owned filtered token is adjusted.
      // Existing desktop/window-station/process/file ACLs remain untouched.
      Check(SetTokenInformation(filtered,TokenDefaultDacl,tokenDacl,(uint)IntPtr.Size),"Set own filtered token default DACL");
    }finally{if(tokenDacl!=IntPtr.Zero)Marshal.FreeHGlobal(tokenDacl);if(descriptor!=IntPtr.Zero)Marshal.FreeHGlobal(descriptor);Marshal.FreeHGlobal(user);}
  }
  static void RequireChildObjectAccess(AccessProof process,AccessProof thread){if(!process.Allowed||!thread.Allowed||process.Error!=0||thread.Error!=0)throw new Exception("Filtered user must have full access to own suspended process and thread");}
}
