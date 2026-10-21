// Observer for generated NSIS fixtures only. No registry or installed app access.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public static class CompletionFixtureUi {
  public delegate bool EnumProc(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumProc f,IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr r);
  static int Send(IntPtr h,int pid,uint m,int w,int l) { uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)throw new Exception("Foreign window refused");IntPtr r;if(SendMessageTimeout(h,m,(IntPtr)w,(IntPtr)l,2,2000,out r)==IntPtr.Zero)throw new Exception("Owned window query failed");return r.ToInt32(); }
  static string Text(IntPtr h) {var s=new StringBuilder(4096);GetWindowText(h,s,s.Capacity);return s.ToString();}
  static string Class(IntPtr h) {var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);return s.ToString();}
  static List<IntPtr> Owned(int pid) {var all=new List<IntPtr>();EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid){all.Add(h);EnumChildWindows(h,(c,q)=>{GetWindowThreadProcessId(c,out owner);if(owner==pid)all.Add(c);return true;},IntPtr.Zero);}return true;},IntPtr.Zero);return all;}
  public static int Main(string[] args) {
    try {
      if(args.Length!=1)throw new Exception("Exact generated inventory required");
      var inventory=Path.GetFullPath(args[0]);var root=Path.GetDirectoryName(inventory);
      if(Path.GetFileName(inventory)!="cases.json"||!Path.GetFileName(root).StartsWith("uninstall-completion-")||Path.GetFileName(Path.GetDirectoryName(root))!="test-results"||new FileInfo(inventory).Length>65536)throw new Exception("Generated fixture root required");
      var json=new JavaScriptSerializer();var cases=json.Deserialize<Dictionary<string,object>[]>(File.ReadAllText(inventory));if(cases.Length!=9)throw new Exception("Exact nine cases required");
      var observations=new List<Dictionary<string,object>>();
      foreach(var item in cases){
        var exe=Path.GetFullPath((string)item["exe"]);if(!exe.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||Path.GetFileName(exe)!="ONLY-GENERATED-COMPLETION-FIXTURE.exe")throw new Exception("Only generated fixture may run");
        var start=new ProcessStartInfo(exe);start.UseShellExecute=false;
        using(var p=Process.Start(start)){
          try{
            var deadline=DateTime.UtcNow.AddSeconds(20);Dictionary<string,object> row=null;string lastState="";
            while(DateTime.UtcNow<deadline&&!p.HasExited){
              var all=Owned(p.Id);var bars=new List<IntPtr>();var close=new List<IntPtr>();var cancel=new List<IntPtr>();var text=new StringBuilder();
              foreach(var h in all){var cls=Class(h);var label=Text(h);text.Append(label).Append('|');if(cls=="msctls_progress32")bars.Add(h);if(cls=="Button"&&IsWindowEnabled(h)){if(GetDlgCtrlID(h)==1&&label.IndexOf("Close",StringComparison.OrdinalIgnoreCase)>=0)close.Add(h);if(GetDlgCtrlID(h)==2)cancel.Add(h);}}
              var failed=close.Count==0&&cancel.Count==1&&text.ToString().IndexOf("failure",StringComparison.OrdinalIgnoreCase)>=0;
              lastState="bars="+bars.Count+" close="+close.Count+" cancel="+cancel.Count+" text="+text.ToString();
              if(bars.Count==1&&(close.Count==1||failed&&cancel.Count==1)){
                row=new Dictionary<string,object>{{"name",item["name"]},{"completed",!failed&&close.Count==1},{"position",Send(bars[0],p.Id,1032,0,0)},{"minimum",Send(bars[0],p.Id,1031,1,0)},{"maximum",Send(bars[0],p.Id,1031,0,0)}};
                Send(failed?cancel[0]:close[0],p.Id,245,0,0);break;
              }
              Thread.Sleep(50);
            }
            if(row==null)throw new Exception("Generated UI did not complete: "+item["name"]+" / "+lastState);
            if(!p.WaitForExit(5000))throw new Exception("Owned fixture did not exit");row["exitCode"]=p.ExitCode;observations.Add(row);
            File.WriteAllText(Path.Combine(root,"observations.json"),json.Serialize(observations),new UTF8Encoding(false));
          }finally{if(!p.HasExited){p.Kill();p.WaitForExit(5000);}}
        }
      }
      File.WriteAllText(Path.Combine(root,"observations.json"),json.Serialize(observations),new UTF8Encoding(false));Console.WriteLine("Observed nine generated UI cases; no installed application or registry accessed.");return 0;
    }catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
  }
}
