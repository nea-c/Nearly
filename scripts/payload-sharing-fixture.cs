// Driver for generated non-executable payload data and NSIS fixtures only.
using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class PayloadSharingFixture {
 public static int Main(string[] args) {
  try {
   if(args.Length!=1)throw new Exception("Exact generated inventory required");
   var inventory=Path.GetFullPath(args[0]);var root=Path.GetDirectoryName(inventory);
   if(Path.GetFileName(inventory)!="cases.json"||!Path.GetFileName(root).StartsWith("payload-sharing-")||Path.GetFileName(Path.GetDirectoryName(root))!="test-results"||new FileInfo(inventory).Length>65536)throw new Exception("Generated fixture root required");
   var json=new JavaScriptSerializer();var cases=json.Deserialize<Dictionary<string,string>[]>(File.ReadAllText(inventory));if(cases.Length!=4)throw new Exception("Exact four fixture cases required");
   var observations=new List<object>();
   foreach(var item in cases) {
    var name=item["name"];if(name!="transient"&&name!="persistent"&&name!="replacement"&&name!="collision")throw new Exception("Unknown generated case");
    var dir=Path.GetFullPath(item["dir"]);if(!dir.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Outside fixture root");
    string exe=Path.Combine(dir,"ONLY-GENERATED-PAYLOAD-SHARING-FIXTURE.exe"),dest=Path.Combine(dir,"owned.bin"),ready=Path.Combine(dir,"ready.txt");
    FileStream held=null;
    try {
     if(name!="collision")held=new FileStream(dest,FileMode.Open,FileAccess.Read,name=="replacement"?FileShare.Read|FileShare.Delete:FileShare.Read);
     using(var p=Process.Start(new ProcessStartInfo(exe){UseShellExecute=false,CreateNoWindow=true})) {
      try {
       var until=DateTime.UtcNow.AddSeconds(10);while(!File.Exists(ready)&&!p.HasExited&&DateTime.UtcNow<until)Thread.Sleep(20);
       if(!File.Exists(ready))throw new Exception("Generated destination snapshot was not ready");
       if(name!="collision") {
        var retry=Path.Combine(dir,"retry.txt");until=DateTime.UtcNow.AddSeconds(10);
        while(!File.Exists(retry)&&!p.HasExited&&DateTime.UtcNow<until)Thread.Sleep(10);
        if(!File.Exists(retry))throw new Exception("Actual generated sharing retry was not observed");
       }
       if(name=="transient"||name=="replacement") {
        Thread.Sleep(450);
        if(name=="replacement")File.Replace(Path.Combine(dir,"replacement.bin"),dest,Path.Combine(dir,"original.bin"));
        held.Dispose();held=null;
       }
       if(!p.WaitForExit(15000))throw new Exception("Bounded generated fixture timed out");
       observations.Add(new {name=name,exitCode=p.ExitCode});
      } finally {if(!p.HasExited){p.Kill();p.WaitForExit(5000);}}
     }
    }finally{if(held!=null)held.Dispose();}
   }
   File.WriteAllText(Path.Combine(root,"observations.json"),json.Serialize(observations));Console.WriteLine("Observed four generated sharing fixtures only.");return 0;
  }catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
 }
}
