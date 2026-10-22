using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace AskGPT.Windows.Core;

/// Private app objects receive their owner and protected ACL at creation time.
/// Existing directories are validated without taking ownership or rewriting ACLs.
public static class ProtectedFiles {
    public static string CreatePrivateSubdirectory(string parent,string prefix) {
        parent=Path.GetFullPath(parent);RejectLinks(parent);
        if(!Directory.Exists(parent))throw new ConfigurationException("请选择现有的导出父目录。");
        if(prefix.Length==0||prefix.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c!='-'))throw new ArgumentException("Invalid private directory prefix.",nameof(prefix));
        for(var attempt=0;attempt<8;attempt++) {
            var path=Path.Combine(parent,prefix+Guid.NewGuid().ToString("N"));
            if(!TryCreatePrivateDirectory(path))continue;
            RejectLinks(path);ValidatePrivateDirectory(path);return path;
        }
        throw new IOException("无法取得新的导出目录名称，请重试。");
    }
    public static void RejectLinks(string path) {
        var current=Path.GetFullPath(path);
        while(!string.IsNullOrEmpty(current)) {if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new ConfigurationException("不接受符号链接或重解析点路径。");current=Path.GetDirectoryName(current);}
    }
    public static void EnsureDirectory(string path) {
        path=Path.GetFullPath(path);RejectLinks(path);
        if(Directory.Exists(path)){ValidatePrivateDirectory(path);return;}
        // Recursive framework creation can assign an elevated token's default
        // Administrators owner to intermediate folders. Create each new level
        // explicitly, stopping before an existing user-selected parent.
        var parent=Path.GetDirectoryName(path);
        if(string.IsNullOrEmpty(parent))throw new ConfigurationException("无法创建私密目录。");
        if(!Directory.Exists(parent))EnsureDirectory(parent);
        _=TryCreatePrivateDirectory(path);RejectLinks(path);ValidatePrivateDirectory(path);
    }
    private static bool TryCreatePrivateDirectory(string path) {
        if(OperatingSystem.IsWindows()) {
            var descriptor=GCHandle.Alloc(PrivateWindowsSecurity(true).GetSecurityDescriptorBinaryForm(),GCHandleType.Pinned);
            try {
                var attributes=new SecurityAttributes {Length=Marshal.SizeOf<SecurityAttributes>(),Descriptor=descriptor.AddrOfPinnedObject()};
                if(CreateDirectoryW(path,ref attributes))return true;
                var error=Marshal.GetLastWin32Error();if(error==183)return false;
                throw new IOException($"无法原子创建私密目录 (Win32 {error})。");
            }finally{descriptor.Free();}
        }
        if(MakeDirectory(path,0x1c0)==0){File.SetUnixFileMode(path,UnixFileMode.UserRead|UnixFileMode.UserWrite|UnixFileMode.UserExecute);return true;}
        var code=Marshal.GetLastWin32Error();if(code==17)return false;throw new IOException($"无法原子创建私密目录 (errno {code})。");
    }
    [SupportedOSPlatform("windows")]
    private static FileSystemSecurity PrivateWindowsSecurity(bool directory) {
        var user=WindowsIdentity.GetCurrent().User!;
        FileSystemSecurity security=directory?new DirectorySecurity():new FileSecurity();
        security.SetOwner(user);security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(directory?new FileSystemAccessRule(user,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow):new FileSystemAccessRule(user,FileSystemRights.FullControl,AccessControlType.Allow));
        return security;
    }
    private static void ValidatePrivateDirectory(string path) {
        if(OperatingSystem.IsWindows())ValidateWindowsSecurity(new DirectoryInfo(path).GetAccessControl(),true,"私密目录");
        else if((File.GetUnixFileMode(path)&(UnixFileMode.GroupRead|UnixFileMode.GroupWrite|UnixFileMode.GroupExecute|UnixFileMode.OtherRead|UnixFileMode.OtherWrite|UnixFileMode.OtherExecute))!=0)throw new ConfigurationException("已有目录不是私密目录，未更改其权限。");
    }
    public static byte[] Read(string path,int maximumBytes,bool secret,bool requireProtectedAcl=true) {
        if(!Path.IsPathFullyQualified(path))throw new ConfigurationException("文件路径须为绝对路径。");RejectLinks(path);
        try {
            using var stream=Open(path);
            if(stream.Length==0||stream.Length>maximumBytes)throw new ConfigurationException("文件为空或超出大小限制。");
            if(secret)ValidatePrivate(stream,path,requireProtectedAcl);
            using var output=new MemoryStream();var buffer=new byte[8192];int count;
            while((count=stream.Read(buffer))>0){if(output.Length+count>maximumBytes)throw new ConfigurationException("文件超出大小限制。");output.Write(buffer,0,count);}
            return output.ToArray();
        }catch(ConfigurationException){throw;}catch(Exception e) when(e is IOException or UnauthorizedAccessException){throw new ConfigurationException("无法安全读取配置或密钥文件。");}
    }
    private static FileStream Open(string path) {
        if(!OperatingSystem.IsWindows())return new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
        var handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
        if(handle.IsInvalid){var error=Marshal.GetLastWin32Error();handle.Dispose();throw new ConfigurationException($"无法打开配置文件 (Win32 {error})。");}
        if(!GetFileInformationByHandle(handle,out var info)||info.Links!=1||(info.Attributes&(uint)(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0){handle.Dispose();throw new ConfigurationException("配置文件须为单一链接的普通文件。");}
        return new FileStream(handle,FileAccess.Read);
    }
    [SupportedOSPlatform("windows")]
    private static void ValidateWindowsSecurity(FileSystemSecurity security,bool requireProtectedAcl,string kind) {
        var user=WindowsIdentity.GetCurrent().User!;
        if(!user.Equals(security.GetOwner(typeof(SecurityIdentifier))))throw new ConfigurationException(kind+"须归当前用户所有。");
        if(requireProtectedAcl&&!security.AreAccessRulesProtected)throw new ConfigurationException(kind+" ACL 不得继承其他账户权限。");
        if(new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(),0).DiscretionaryAcl is null)throw new ConfigurationException(kind+" 缺少限制访问的 ACL。");
        var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);var administrators=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
        foreach(FileSystemAccessRule rule in security.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!user.Equals(rule.IdentityReference)&&!system.Equals(rule.IdentityReference)&&!administrators.Equals(rule.IdentityReference)&&rule.FileSystemRights!=0)throw new ConfigurationException(kind+" ACL 允许其他账户访问，请限制到当前用户及系统管理员。");
    }
    private static void ValidatePrivate(FileStream stream,string path,bool requireProtectedAcl) {
        if(OperatingSystem.IsWindows())ValidateWindowsSecurity(stream.GetAccessControl(),requireProtectedAcl,"私密文件");
        else if((File.GetUnixFileMode(path)&(UnixFileMode.GroupRead|UnixFileMode.GroupWrite|UnixFileMode.GroupExecute|UnixFileMode.OtherRead|UnixFileMode.OtherWrite|UnixFileMode.OtherExecute))!=0)throw new ConfigurationException("私密文件权限须为 600。");
    }
    private static FileStream CreatePrivateFile(string path) {
        if(!OperatingSystem.IsWindows())return new FileStream(path,new FileStreamOptions {Mode=FileMode.CreateNew,Access=FileAccess.Write,Share=FileShare.None,UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite});
        var descriptor=GCHandle.Alloc(PrivateWindowsSecurity(false).GetSecurityDescriptorBinaryForm(),GCHandleType.Pinned);
        try {
            var attributes=new SecurityAttributes {Length=Marshal.SizeOf<SecurityAttributes>(),Descriptor=descriptor.AddrOfPinnedObject()};
            // A normal write-only FileStream handle does not grant WRITE_DAC or
            // WRITE_OWNER. Set the complete descriptor with CREATE_NEW instead
            // of changing owner/ACL through that handle after creation.
            var handle=CreatePrivateFileW(path,0x40000000,0,ref attributes,1,0x00200080,IntPtr.Zero);
            if(handle.IsInvalid){var error=Marshal.GetLastWin32Error();handle.Dispose();throw new IOException($"无法原子创建私密文件 (Win32 {error})。");}
            return new FileStream(handle,FileAccess.Write);
        }finally{descriptor.Free();}
    }
    public static void Write(string path,byte[] data) {
        var parent=Path.GetDirectoryName(Path.GetFullPath(path))!;EnsureDirectory(parent);RejectLinks(path);
        var temporary=Path.Combine(parent,".askgpt-"+Guid.NewGuid().ToString("N"));
        try {
            using(var stream=CreatePrivateFile(temporary)){stream.Write(data);stream.Flush(true);}
            RejectLinks(path);File.Move(temporary,path,true);
        }finally{if(File.Exists(temporary))File.Delete(temporary);}
    }
    [StructLayout(LayoutKind.Sequential)]private struct FileInformation {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [StructLayout(LayoutKind.Sequential)]private struct SecurityAttributes {public int Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)]public bool Inherit;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool CreateDirectoryW(string path,ref SecurityAttributes security);
    [DllImport("libc",EntryPoint="mkdir",SetLastError=true)]private static extern int MakeDirectory([MarshalAs(UnmanagedType.LPUTF8Str)]string path,uint mode);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]private static extern SafeFileHandle CreatePrivateFileW(string name,uint access,uint share,ref SecurityAttributes security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInformation info);
}
