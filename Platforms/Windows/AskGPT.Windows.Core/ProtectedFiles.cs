using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace AskGPT.Windows.Core;

/// Private app files are opened without following a final reparse point. Their
/// parent chain is checked too; writes use a private sibling plus atomic move.
public static class ProtectedFiles {
    public static string CreatePrivateSubdirectory(string parent,string prefix) {
        parent=Path.GetFullPath(parent);RejectLinks(parent);
        if(!Directory.Exists(parent))throw new ConfigurationException("请选择现有的导出父目录。");
        if(prefix.Length==0||prefix.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c!='-'))throw new ArgumentException("Invalid private directory prefix.",nameof(prefix));
        for(var attempt=0;attempt<8;attempt++) {
            var path=Path.Combine(parent,prefix+Guid.NewGuid().ToString("N"));
            if(OperatingSystem.IsWindows()) {
                var security=new DirectorySecurity();var sid=WindowsIdentity.GetCurrent().User!;security.SetOwner(sid);security.SetAccessRuleProtection(true,false);security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
                var descriptor=GCHandle.Alloc(security.GetSecurityDescriptorBinaryForm(),GCHandleType.Pinned);
                try {
                    var attributes=new DirectorySecurityAttributes {Length=Marshal.SizeOf<DirectorySecurityAttributes>(),Descriptor=descriptor.AddrOfPinnedObject()};
                    if(!CreateDirectoryW(path,ref attributes)){if(Marshal.GetLastWin32Error()==183)continue;throw new IOException("无法创建新的私密导出目录。");}
                }finally{descriptor.Free();}
            } else {
                if(MakeDirectory(path,0x1c0)!=0){if(Marshal.GetLastWin32Error()==17)continue;throw new IOException("无法创建新的私密导出目录。");}
                File.SetUnixFileMode(path,UnixFileMode.UserRead|UnixFileMode.UserWrite|UnixFileMode.UserExecute);
            }
            RejectLinks(path);return path;
        }
        throw new IOException("无法取得新的导出目录名称，请重试。");
    }
    public static void RejectLinks(string path) {
        var current=Path.GetFullPath(path);
        while(!string.IsNullOrEmpty(current)) { if((File.Exists(current)||Directory.Exists(current)) && (File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new ConfigurationException("不接受符号链接或重解析点路径。"); current=Path.GetDirectoryName(current); }
    }
    public static void EnsureDirectory(string path) {
        RejectLinks(path);
        if(OperatingSystem.IsWindows()) {
            var security=new DirectorySecurity(); var sid=WindowsIdentity.GetCurrent().User!;
            security.SetOwner(sid); security.SetAccessRuleProtection(true,false); security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
            if(!Directory.Exists(path)) new DirectoryInfo(path).Create(security);
            else {
                var existing=new DirectoryInfo(path);
                if(!sid.Equals(existing.GetAccessControl().GetOwner(typeof(SecurityIdentifier))))throw new ConfigurationException("私密目录须归当前用户所有。");
                existing.SetAccessControl(security);
            }
        } else { Directory.CreateDirectory(path); File.SetUnixFileMode(path,UnixFileMode.UserRead|UnixFileMode.UserWrite|UnixFileMode.UserExecute); }
        RejectLinks(path);
    }
    public static byte[] Read(string path,int maximumBytes,bool secret,bool requireProtectedAcl=true) {
        if(!Path.IsPathFullyQualified(path)) throw new ConfigurationException("文件路径须为绝对路径。"); RejectLinks(path);
        try {
            using var stream=Open(path);
            if(stream.Length==0 || stream.Length>maximumBytes) throw new ConfigurationException("文件为空或超出大小限制。");
            if(secret) ValidatePrivate(stream,path,requireProtectedAcl);
            using var output=new MemoryStream(); var buffer=new byte[8192]; int count;
            while((count=stream.Read(buffer))>0) { if(output.Length+count>maximumBytes) throw new ConfigurationException("文件超出大小限制。"); output.Write(buffer,0,count); }
            return output.ToArray();
        } catch(ConfigurationException) { throw; } catch(Exception e) when(e is IOException or UnauthorizedAccessException) { throw new ConfigurationException("无法安全读取配置或密钥文件。"); }
    }
    private static FileStream Open(string path) {
        if(!OperatingSystem.IsWindows()) return new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
        var handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
        if(handle.IsInvalid) { handle.Dispose(); throw new ConfigurationException("无法打开配置文件。"); }
        if(!GetFileInformationByHandle(handle,out var info) || info.Links!=1 || (info.Attributes&(uint)(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0) { handle.Dispose(); throw new ConfigurationException("配置文件须为单一链接的普通文件。"); }
        return new FileStream(handle,FileAccess.Read);
    }
    private static void ValidatePrivate(FileStream stream,string path,bool requireProtectedAcl) {
        if(OperatingSystem.IsWindows()) {
            var security=stream.GetAccessControl(); var user=WindowsIdentity.GetCurrent().User!;
            if(!user.Equals(security.GetOwner(typeof(SecurityIdentifier)))) throw new ConfigurationException("私密文件须归当前用户所有。");
            if(requireProtectedAcl&&!security.AreAccessRulesProtected)throw new ConfigurationException("私密文件 ACL 不得继承其他账户权限。");
            var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);var administrators=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
            foreach(FileSystemAccessRule rule in security.GetAccessRules(true,true,typeof(SecurityIdentifier))) if(rule.AccessControlType==AccessControlType.Allow && !user.Equals(rule.IdentityReference) && !system.Equals(rule.IdentityReference) && !administrators.Equals(rule.IdentityReference) && rule.FileSystemRights!=0) throw new ConfigurationException("私密文件 ACL 允许其他账户访问，请限制到当前用户及系统管理员。");
        } else if((File.GetUnixFileMode(path)&(UnixFileMode.GroupRead|UnixFileMode.GroupWrite|UnixFileMode.GroupExecute|UnixFileMode.OtherRead|UnixFileMode.OtherWrite|UnixFileMode.OtherExecute))!=0) throw new ConfigurationException("私密文件权限须为 600。");
    }
    public static void Write(string path,byte[] data) {
        var parent=Path.GetDirectoryName(Path.GetFullPath(path))!; EnsureDirectory(parent); RejectLinks(path);
        var temporary=Path.Combine(parent,".askgpt-"+Guid.NewGuid().ToString("N"));
        try {
            using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                if(OperatingSystem.IsWindows()) { var security=new FileSecurity(); var sid=WindowsIdentity.GetCurrent().User!; security.SetOwner(sid); security.SetAccessRuleProtection(true,false); security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow)); stream.SetAccessControl(security); }
                else File.SetUnixFileMode(temporary,UnixFileMode.UserRead|UnixFileMode.UserWrite);
                stream.Write(data); stream.Flush(true);
            }
            RejectLinks(path); File.Move(temporary,path,true);
        } finally { if(File.Exists(temporary)) File.Delete(temporary); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct DirectorySecurityAttributes {public int Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CreateDirectoryW(string path,ref DirectorySecurityAttributes security);
    [DllImport("libc",EntryPoint="mkdir",SetLastError=true)]private static extern int MakeDirectory([MarshalAs(UnmanagedType.LPUTF8Str)]string path,uint mode);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInformation info);
}
