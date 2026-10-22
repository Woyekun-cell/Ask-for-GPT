using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AskGPT.Windows.Core;

/// Own the entire Windows descendant tree before any child code can execute.
/// Only the three redirected pipe handles are inherited by a Windows child.
public sealed class OwnedProcess : IAsyncDisposable {
    public Process Process { get; }
    public StreamWriter StandardInput { get; }
    public StreamReader StandardOutput { get; }
    public StreamReader StandardError { get; }
    private readonly SafeFileHandle? job;
    private readonly string directory;
    private bool disposed;
    private OwnedProcess(Process process,SafeFileHandle? job,string directory,StreamWriter input,StreamReader output,StreamReader error) {
        Process=process;this.job=job;this.directory=directory;StandardInput=input;StandardOutput=output;StandardError=error;
    }
    public static OwnedProcess Start(string executable,IEnumerable<string> arguments,IReadOnlyDictionary<string,string?>? environment=null,bool redirect=true) {
        if(!redirect)throw new ArgumentException("Owned processes require redirected pipes.");
        var directory=Path.Combine(AppPaths.DataDirectory,"sessions","request-"+Guid.NewGuid().ToString("N"));ProtectedFiles.EnsureDirectory(directory);
        var info=new ProcessStartInfo(executable) {UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=directory,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false),StandardErrorEncoding=new UTF8Encoding(false)};
        foreach(var arg in arguments)info.ArgumentList.Add(arg);
        if(environment is not null)foreach(var pair in environment){if(pair.Value is null)info.Environment.Remove(pair.Key);else info.Environment[pair.Key]=pair.Value;}
        try {
            if(OperatingSystem.IsWindows())return StartWindows(info,directory);
            var process=Process.Start(info)??throw new TranslationException("无法启动翻译进程。");
            return new(process,null,directory,process.StandardInput,process.StandardOutput,process.StandardError);
        }catch{try{Directory.Delete(directory,true);}catch{}throw;}
    }
    private static OwnedProcess StartWindows(ProcessStartInfo info,string directory) {
        SafeFileHandle? job=null,childInput=null,parentInput=null,parentOutput=null,childOutput=null,parentError=null,childError=null;
        Process? process=null;ProcessInformation native=default;IntPtr attributes=IntPtr.Zero,handles=IntPtr.Zero,environment=IntPtr.Zero;var attributesInitialized=false;
        try {
            job=CreateJobObjectW(IntPtr.Zero,null);var limits=new ExtendedLimitInformation();limits.BasicLimitInformation.LimitFlags=0x2000;
            if(job.IsInvalid||!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimitInformation>()))throw new TranslationException("无法创建安全的子进程隔离区。");
            var security=new SecurityAttributes {Length=Marshal.SizeOf<SecurityAttributes>(),Inherit=true};
            if(!CreatePipe(out childInput,out parentInput,ref security,0)||!CreatePipe(out parentOutput,out childOutput,ref security,0)||!CreatePipe(out parentError,out childError,ref security,0))throw new TranslationException("无法创建子进程管道。");
            foreach(var handle in new[]{parentInput,parentOutput,parentError})if(!SetHandleInformation(handle,1,0))throw new TranslationException("无法保护子进程管道。");
            nuint size=0;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attributes=Marshal.AllocHGlobal(checked((int)size));
            if(!InitializeProcThreadAttributeList(attributes,1,0,ref size))throw new TranslationException("无法初始化子进程句柄隔离。");
            attributesInitialized=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size*3);var inherited=new[]{childInput.DangerousGetHandle(),childOutput.DangerousGetHandle(),childError.DangerousGetHandle()};
            for(var i=0;i<inherited.Length;i++)Marshal.WriteIntPtr(handles,i*IntPtr.Size,inherited[i]);
            if(!UpdateProcThreadAttribute(attributes,0,(IntPtr)0x00020002,handles,(nuint)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new TranslationException("无法限制子进程继承句柄。");
            var startup=new StartupInformationEx {Startup=new StartupInformation {Size=Marshal.SizeOf<StartupInformationEx>(),Flags=0x100,Input=inherited[0],Output=inherited[1],Error=inherited[2]},Attributes=attributes};
            var block=string.Join('\0',info.Environment.OrderBy(p=>p.Key,StringComparer.OrdinalIgnoreCase).Select(p=>p.Key+"="+p.Value))+"\0\0";
            environment=Marshal.StringToHGlobalUni(block);
            var command=new StringBuilder(string.Join(" ",new[]{info.FileName}.Concat(info.ArgumentList).Select(QuoteArgument)));
            // The first instruction cannot run or create descendants until the
            // process is attached to this kill-on-close Job Object.
            if(!CreateProcessW(info.FileName,command,IntPtr.Zero,IntPtr.Zero,true,0x00000004|0x00000400|0x00080000|0x08000000,environment,info.WorkingDirectory,ref startup,out native))throw new TranslationException("无法启动安全的子进程。");
            if(!AssignProcessToJobObject(job,native.Process))throw new TranslationException("无法隔离子进程，已停止启动。");
            process=Process.GetProcessById((int)native.ProcessId);_ = process.Handle;
            if(ResumeThread(native.Thread)==uint.MaxValue)throw new TranslationException("无法恢复隔离子进程。");
            childInput.Dispose();childOutput.Dispose();childError.Dispose();
            var input=new StreamWriter(new FileStream(parentInput,FileAccess.Write,8192,false),new UTF8Encoding(false));parentInput=null;
            var output=new StreamReader(new FileStream(parentOutput,FileAccess.Read,8192,false),new UTF8Encoding(false));parentOutput=null;
            var error=new StreamReader(new FileStream(parentError,FileAccess.Read,8192,false),new UTF8Encoding(false));parentError=null;
            var owned=new OwnedProcess(process,job,directory,input,output,error);process=null;job=null;return owned;
        }catch{if(native.Process!=IntPtr.Zero)TerminateProcess(native.Process,1);process?.Dispose();throw;}
        finally {
            if(native.Thread!=IntPtr.Zero)CloseHandle(native.Thread);if(native.Process!=IntPtr.Zero)CloseHandle(native.Process);
            childInput?.Dispose();childOutput?.Dispose();childError?.Dispose();parentInput?.Dispose();parentOutput?.Dispose();parentError?.Dispose();job?.Dispose();
            if(attributes!=IntPtr.Zero){if(attributesInitialized)DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
        }
    }
    private static string QuoteArgument(string value) {
        if(value.Length>0&&!value.Any(c=>char.IsWhiteSpace(c)||c=='"'))return value;
        var result=new StringBuilder("\"");var slashes=0;
        foreach(var character in value){if(character=='\\'){slashes++;continue;}if(character=='"'){result.Append('\\',slashes*2+1).Append('"');slashes=0;continue;}result.Append('\\',slashes).Append(character);slashes=0;}
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    public static async Task<byte[]> RunAsync(string executable,IEnumerable<string> arguments,string input,CancellationToken ct,IReadOnlyDictionary<string,string?>? environment=null) {
        ct.ThrowIfCancellationRequested();await using var owned=Start(executable,arguments,environment);using var cancellation=ct.Register(owned.Kill);
        try {
            var stdout=BoundedIO.ReadAsync(owned.StandardOutput.BaseStream,8*1024*1024,ct);var stderr=BoundedIO.DrainAsync(owned.StandardError.BaseStream,64*1024,ct);
            foreach(var reader in new Task[]{stdout,stderr})_=reader.ContinueWith(_=>owned.Kill(),CancellationToken.None,TaskContinuationOptions.OnlyOnFaulted,TaskScheduler.Default);
            await owned.StandardInput.WriteAsync(input.AsMemory(),ct);owned.StandardInput.Close();
            await owned.Process.WaitForExitAsync(ct);await stderr;var result=await stdout;
            if(owned.Process.ExitCode!=0)throw new TranslationException("翻译 CLI 未正常完成。请检查版本和登录。");return result;
        }finally{owned.Kill();}
    }
    public void Kill() {if(job is not null&&!job.IsClosed){try{TerminateJobObject(job,1);}catch{}}try{if(!Process.HasExited)Process.Kill(true);}catch(InvalidOperationException){}catch(System.ComponentModel.Win32Exception){}}
    public async ValueTask DisposeAsync() {if(disposed)return;disposed=true;Kill();try{await Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));}catch{}try{StandardInput.Dispose();}catch(IOException){}try{StandardOutput.Dispose();}catch(IOException){}try{StandardError.Dispose();}catch(IOException){}Process.Dispose();job?.Dispose();try{Directory.Delete(directory,true);}catch{}}
    [StructLayout(LayoutKind.Sequential)]private struct SecurityAttributes {public int Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]private struct StartupInformation {public int Size;public string? Reserved,Desktop,Title;public int X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public short Show,ReservedSize;public IntPtr ReservedPointer,Input,Output,Error;}
    [StructLayout(LayoutKind.Sequential)]private struct StartupInformationEx {public StartupInformation Startup;public IntPtr Attributes;}
    [StructLayout(LayoutKind.Sequential)]private struct ProcessInformation {public IntPtr Process,Thread;public uint ProcessId,ThreadId;}
    [StructLayout(LayoutKind.Sequential)]private struct BasicLimitInformation {public long PerProcessUserTimeLimit,PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint PriorityClass,SchedulingClass;}
    [StructLayout(LayoutKind.Sequential)]private struct IoCounters {public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;}
    [StructLayout(LayoutKind.Sequential)]private struct ExtendedLimitInformation {public BasicLimitInformation BasicLimitInformation;public IoCounters IoInfo;public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes,string? name);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool SetInformationJobObject(SafeFileHandle job,int informationClass,ref ExtendedLimitInformation information,uint length);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool TerminateJobObject(SafeFileHandle job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool CreatePipe(out SafeFileHandle read,out SafeFileHandle write,ref SecurityAttributes attributes,uint size);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool SetHandleInformation(SafeFileHandle handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref nuint size);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,nuint size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")]private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,[MarshalAs(UnmanagedType.Bool)]bool inherit,uint flags,IntPtr environment,string directory,ref StartupInformationEx startup,out ProcessInformation process);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")][return:MarshalAs(UnmanagedType.Bool)]private static extern bool CloseHandle(IntPtr handle);
}
