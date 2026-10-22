"""Private files, owned subprocesses and bounded pipes on POSIX and Windows.

Windows uses handle-based owner/DACL validation and rejects reparse points;
Unix permission checks are never treated as meaningful Windows ACL checks.
No PID supplied by a request is ever accepted as a process ownership token.
"""
from __future__ import annotations

import errno
import os
from pathlib import Path
import selectors
import stat
import subprocess
import threading
import time

IS_WINDOWS = os.name == 'nt'
if not IS_WINDOWS:
    import fcntl
    import pwd
else:
    import ctypes
    from ctypes import wintypes as wt
    import msvcrt

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    def _bind(library, name, result, arguments):
        value = getattr(library, name); value.restype = result; value.argtypes = arguments
        return value
    _bind(kernel, 'CloseHandle', wt.BOOL, [wt.HANDLE])
    _bind(kernel, 'LocalFree', wt.HANDLE, [wt.HANDLE])
    _bind(kernel, 'GetCurrentProcess', wt.HANDLE, [])
    _bind(kernel, 'CreateFileW', wt.HANDLE, [wt.LPCWSTR, wt.DWORD, wt.DWORD, wt.LPVOID, wt.DWORD, wt.DWORD, wt.HANDLE])
    _bind(kernel, 'GetFileAttributesW', wt.DWORD, [wt.LPCWSTR])
    _bind(kernel, 'CreateDirectoryW', wt.BOOL, [wt.LPCWSTR, wt.LPVOID])
    class _SecurityAttributes(ctypes.Structure):
        _fields_ = [('length', wt.DWORD), ('descriptor', wt.LPVOID), ('inherit', wt.BOOL)]
    class _FileInfo(ctypes.Structure):
        _fields_ = [('attributes', wt.DWORD), ('created', wt.FILETIME), ('accessed', wt.FILETIME), ('written', wt.FILETIME), ('volume', wt.DWORD), ('size_high', wt.DWORD), ('size_low', wt.DWORD), ('links', wt.DWORD), ('index_high', wt.DWORD), ('index_low', wt.DWORD)]
    _bind(kernel, 'GetFileInformationByHandle', wt.BOOL, [wt.HANDLE, ctypes.POINTER(_FileInfo)])
    _bind(advapi, 'OpenProcessToken', wt.BOOL, [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)])
    _bind(advapi, 'GetTokenInformation', wt.BOOL, [wt.HANDLE, ctypes.c_int, wt.LPVOID, wt.DWORD, ctypes.POINTER(wt.DWORD)])
    _bind(advapi, 'ConvertSidToStringSidW', wt.BOOL, [wt.LPVOID, ctypes.POINTER(wt.LPWSTR)])
    _bind(advapi, 'ConvertStringSidToSidW', wt.BOOL, [wt.LPCWSTR, ctypes.POINTER(wt.LPVOID)])
    _bind(advapi, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', wt.BOOL, [wt.LPCWSTR, wt.DWORD, ctypes.POINTER(wt.LPVOID), ctypes.POINTER(wt.DWORD)])
    _bind(advapi, 'GetSecurityInfo', wt.DWORD, [wt.HANDLE, ctypes.c_int, wt.DWORD, ctypes.POINTER(wt.LPVOID), ctypes.POINTER(wt.LPVOID), ctypes.POINTER(wt.LPVOID), ctypes.POINTER(wt.LPVOID), ctypes.POINTER(wt.LPVOID)])
    _bind(advapi, 'GetSecurityDescriptorControl', wt.BOOL, [wt.LPVOID, ctypes.POINTER(wt.WORD), ctypes.POINTER(wt.DWORD)])
    _bind(advapi, 'GetSecurityDescriptorDacl', wt.BOOL, [wt.LPVOID, ctypes.POINTER(wt.BOOL), ctypes.POINTER(wt.LPVOID), ctypes.POINTER(wt.BOOL)])
    _bind(advapi, 'SetSecurityInfo', wt.DWORD, [wt.HANDLE, ctypes.c_int, wt.DWORD, wt.LPVOID, wt.LPVOID, wt.LPVOID, wt.LPVOID])
    _bind(advapi, 'GetAce', wt.BOOL, [wt.LPVOID, wt.DWORD, ctypes.POINTER(wt.LPVOID)])
    _bind(kernel, 'PeekNamedPipe', wt.BOOL, [wt.HANDLE, wt.LPVOID, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD)])
    _bind(kernel, 'CreateJobObjectW', wt.HANDLE, [wt.LPVOID, wt.LPCWSTR])
    _bind(kernel, 'SetInformationJobObject', wt.BOOL, [wt.HANDLE, ctypes.c_int, wt.LPVOID, wt.DWORD])
    _bind(kernel, 'AssignProcessToJobObject', wt.BOOL, [wt.HANDLE, wt.HANDLE])
    _bind(kernel, 'TerminateJobObject', wt.BOOL, [wt.HANDLE, wt.UINT])
    _bind(kernel, 'QueryInformationJobObject', wt.BOOL, [wt.HANDLE, ctypes.c_int, wt.LPVOID, wt.DWORD, ctypes.POINTER(wt.DWORD)])
    _bind(kernel, 'IsProcessInJob', wt.BOOL, [wt.HANDLE, wt.HANDLE, ctypes.POINTER(wt.BOOL)])
    _bind(kernel, 'CreateToolhelp32Snapshot', wt.HANDLE, [wt.DWORD, wt.DWORD])
    _bind(kernel, 'OpenThread', wt.HANDLE, [wt.DWORD, wt.BOOL, wt.DWORD])
    _bind(kernel, 'ResumeThread', wt.DWORD, [wt.HANDLE])
    _bind(kernel, 'OpenProcess', wt.HANDLE, [wt.DWORD, wt.BOOL, wt.DWORD])
    _bind(kernel, 'WaitForSingleObject', wt.DWORD, [wt.HANDLE, wt.DWORD])

    class _ACL(ctypes.Structure):
        _fields_ = [('revision', wt.BYTE), ('reserved', wt.BYTE), ('size', wt.WORD), ('count', wt.WORD), ('reserved2', wt.WORD)]
    class _ThreadEntry(ctypes.Structure):
        _fields_ = [('size', wt.DWORD), ('usage', wt.DWORD), ('id', wt.DWORD), ('pid', wt.DWORD), ('priority', wt.LONG), ('delta', wt.LONG), ('flags', wt.DWORD)]
    _bind(kernel, 'Thread32First', wt.BOOL, [wt.HANDLE, ctypes.POINTER(_ThreadEntry)])
    _bind(kernel, 'Thread32Next', wt.BOOL, [wt.HANDLE, ctypes.POINTER(_ThreadEntry)])
    class _BasicJob(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64), ('flags', wt.DWORD),
                    ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t), ('active', wt.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority', wt.DWORD), ('scheduling', wt.DWORD)]
    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ('reads','writes','others','read_bytes','write_bytes','other_bytes')]
    class _ExtendedJob(ctypes.Structure):
        _fields_ = [('basic', _BasicJob), ('io', _IoCounters), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]

    def _wincheck(result):
        if not result: raise ctypes.WinError(ctypes.get_last_error())
        return result

    def _job_process_handles(job):
        # JOBOBJECT_BASIC_PROCESS_ID_LIST includes nested child jobs. Open only
        # members of this owned job, then verify membership again against PID
        # reuse before keeping a SYNCHRONIZE handle.
        capacity = 16
        while capacity <= 4096:
            buffer = ctypes.create_string_buffer(8 + capacity * ctypes.sizeof(ctypes.c_size_t))
            success = kernel.QueryInformationJobObject(job, 3, buffer, ctypes.sizeof(buffer), None)
            error = ctypes.get_last_error() if not success else 0
            if error not in (0, 234): raise ctypes.WinError(error)
            assigned, count = ctypes.cast(buffer, ctypes.POINTER(wt.DWORD))[:2]
            if success and assigned == count and count <= capacity:
                identities = list((ctypes.c_size_t * count).from_buffer(buffer, 8))
                break
            capacity = max(capacity * 2, assigned)
        else: raise ValueError('owned_job_process_limit')
        handles = []
        try:
            for identity in identities:
                process = kernel.OpenProcess(0x101000, False, identity)  # SYNCHRONIZE, QUERY_LIMITED_INFORMATION
                if not process:
                    error = ctypes.get_last_error()
                    if error in (87, 1168): continue  # Already destroyed after the job snapshot.
                    raise ctypes.WinError(error)
                try:
                    member = wt.BOOL()
                    _wincheck(kernel.IsProcessInJob(process, job, ctypes.byref(member)))
                    if member.value:
                        handles.append((identity, process)); process = None
                finally:
                    if process is not None: kernel.CloseHandle(process)
            return handles
        except BaseException:
            for _, process in handles: kernel.CloseHandle(process)
            raise

    def _sid_string(sid):
        output = wt.LPWSTR()
        _wincheck(advapi.ConvertSidToStringSidW(sid, ctypes.byref(output)))
        try: return output.value
        finally: kernel.LocalFree(output)

    def _user_sid():
        token = wt.HANDLE()
        _wincheck(advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)))
        try:
            required = wt.DWORD()
            advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(required))
            buffer = ctypes.create_string_buffer(required.value)
            _wincheck(advapi.GetTokenInformation(token, 1, buffer, required, ctypes.byref(required)))
            return _sid_string(ctypes.cast(buffer, ctypes.POINTER(wt.LPVOID))[0])
        finally: kernel.CloseHandle(token)

    def _windows_security(handle, *, protect=False, directory=False, new_generated=False):
        information = _FileInfo()
        _wincheck(kernel.GetFileInformationByHandle(handle, ctypes.byref(information)))
        if information.attributes & 0x400: raise ValueError('unsafe_reparse_point')
        if directory and not information.attributes & 0x10: raise ValueError('unsafe_cache_directory')
        if not information.attributes & 0x10 and information.links != 1: raise ValueError('unsafe_cache_file')
        owner, dacl, security = wt.LPVOID(), wt.LPVOID(), wt.LPVOID()
        status = advapi.GetSecurityInfo(handle, 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(security))
        if status: raise ctypes.WinError(status)
        try:
            user = _user_sid()
            allowed_owners = {user, 'S-1-5-32-544'} if new_generated else {user}
            if not owner or _sid_string(owner) not in allowed_owners: raise ValueError('unsafe_file_owner')
            if protect:
                replacement = wt.LPVOID()
                inheritance = 'OICI' if directory else ''
                # SYSTEM and administrators retain recovery access; no other
                # account can read or replace protected reader state.
                sddl = 'D:P' + ''.join(f'(A;{inheritance};FA;;;{sid})' for sid in (user, 'SY', 'BA'))
                _wincheck(advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(replacement), None))
                try:
                    present, defaulted, restricted = wt.BOOL(), wt.BOOL(), wt.LPVOID()
                    _wincheck(advapi.GetSecurityDescriptorDacl(replacement, ctypes.byref(present), ctypes.byref(restricted), ctypes.byref(defaulted)))
                    status = advapi.SetSecurityInfo(handle, 1, 0x80000004, None, None, restricted, None)
                    if status: raise ctypes.WinError(status)
                finally: kernel.LocalFree(replacement)
            else:
                control, revision = wt.WORD(), wt.DWORD()
                _wincheck(advapi.GetSecurityDescriptorControl(security, ctypes.byref(control), ctypes.byref(revision)))
                if (not new_generated and not control.value & 0x1000) or not dacl: raise ValueError('unsafe_file_acl')
                allowed = {user, 'S-1-5-18', 'S-1-5-32-544'}
                acl = ctypes.cast(dacl, ctypes.POINTER(_ACL)).contents
                if not acl.count: raise ValueError('unsafe_file_acl')
                has_user = False
                for index in range(acl.count):
                    ace = wt.LPVOID()
                    _wincheck(advapi.GetAce(dacl, index, ctypes.byref(ace)))
                    # ACCESS_ALLOWED_ACE header (4), mask (4), then SID. Reject
                    # object/callback ACEs and unexpected trustees fail-closed.
                    header = ctypes.cast(ace, ctypes.POINTER(wt.BYTE))
                    if header[0] != 0: raise ValueError('unsafe_file_acl')
                    sid = _sid_string(ace.value + 8)
                    if sid not in allowed: raise ValueError('unsafe_file_acl')
                    mask = ctypes.cast(ace, ctypes.POINTER(wt.DWORD))[1]
                    usable_user = sid == user and not header[1] & 8
                    if new_generated: usable_user = usable_user and mask & 0x1f01ff == 0x1f01ff
                    has_user = has_user or usable_user
                if not has_user: raise ValueError('unsafe_file_acl')
        finally: kernel.LocalFree(security)

    def _protect_new_generated_item(path, *, directory=False):
        # The caller proves this path did not exist in a checked private root
        # before the current operation. Elevated Python can create it with the
        # Administrators default owner; never accept that owner for old files.
        path = _reject_reparse(path)
        handle = kernel.CreateFileW(str(path), 0xe0080, 1, None, 3,
                                    0x00200000 | (0x02000000 if directory else 0), None)
        if handle == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
        try:
            _windows_security(handle, directory=directory, new_generated=True)
            user = wt.LPVOID()
            _wincheck(advapi.ConvertStringSidToSidW(_user_sid(), ctypes.byref(user)))
            try:
                status = advapi.SetSecurityInfo(handle, 1, 1, user, None, None, None)
                if status: raise ctypes.WinError(status)
            finally: kernel.LocalFree(user)
            _windows_security(handle, protect=True, directory=directory)
            _windows_security(handle, directory=directory)
        finally: kernel.CloseHandle(handle)

    def _reject_reparse(path):
        path = Path(os.path.abspath(path))
        for component in reversed((path, *path.parents)):
            attributes = kernel.GetFileAttributesW(str(component))
            if attributes == 0xffffffff:
                error = ctypes.get_last_error()
                if error in (2, 3): continue
                raise ctypes.WinError(error)
            if attributes & 0x400: raise ValueError('unsafe_reparse_point')
        return path

    def _creation_security(*, directory=False):
        user = _user_sid()
        inheritance = 'OICI' if directory else ''
        sddl = f'O:{user}D:P' + ''.join(f'(A;{inheritance};FA;;;{sid})' for sid in (user, 'SY', 'BA'))
        descriptor = wt.LPVOID()
        _wincheck(advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None))
        attributes = _SecurityAttributes(ctypes.sizeof(_SecurityAttributes), descriptor, False)
        return attributes, descriptor

    def _windows_open(path, flags, *, directory=False, repair=False):
        path = _reject_reparse(path)
        write = bool(flags & (os.O_WRONLY | os.O_RDWR))
        desired = 0x80000000 | (0x40000000 if write else 0) | 0x20000
        create = bool(flags & os.O_CREAT)
        if create or repair: desired |= 0x40000  # WRITE_DAC, only for narrowing newly owned files.
        disposition = 1 if create and flags & os.O_EXCL else 4 if create else 3
        attributes, security = _creation_security() if create else (None, None)
        try:
            ctypes.set_last_error(0)
            handle = kernel.CreateFileW(str(path), desired, 7, ctypes.byref(attributes) if attributes else None,
                                       disposition, 0x00200000 | (0x02000000 if directory else 0), None)
            opened_existing = ctypes.get_last_error() == 183
        finally:
            if security: kernel.LocalFree(security)
        if handle == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
        try:
            # Check the final object through its open handle, never merely lstat.
            if os.stat(path, follow_symlinks=False).st_file_attributes & 0x400: raise ValueError('unsafe_reparse_point')
            protecting = repair or (create and (bool(flags & os.O_EXCL) or not opened_existing))
            _windows_security(handle, protect=protecting, directory=directory)
            if protecting: _windows_security(handle)
            if directory:
                owned = handle
                handle = None
                return owned
            descriptor = msvcrt.open_osfhandle(handle, flags & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR) | os.O_BINARY)
            handle = None
            os.set_inheritable(descriptor, False)
            return descriptor
        finally:
            if handle is not None: kernel.CloseHandle(handle)


def actual_user_home() -> str:
    return os.environ.get('ASKGPT_ORIGINAL_USERPROFILE', str(Path.home())) if IS_WINDOWS else pwd.getpwuid(os.getuid()).pw_dir


def private_directory(path: Path) -> Path:
    path = Path(path)
    if IS_WINDOWS:
        path = _reject_reparse(path)
        attributes, security = _creation_security(directory=True)
        try:
            for component in reversed((path, *path.parents)):
                if component.exists(): continue
                if not kernel.CreateDirectoryW(str(component), ctypes.byref(attributes)):
                    error = ctypes.get_last_error()
                    if error != 183: raise ctypes.WinError(error)
                _reject_reparse(component)
        finally: kernel.LocalFree(security)
        # READ_CONTROL + WRITE_DAC through a no-follow directory handle.
        handle = kernel.CreateFileW(str(path.absolute()), 0x60000, 7, None, 3, 0x02200000, None)
        if handle == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not path.is_dir(): raise ValueError('unsafe_cache_directory')
            _reject_reparse(path)
            _windows_security(handle, protect=True, directory=True)
            _windows_security(handle)
        finally: kernel.CloseHandle(handle)
    else:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid(): raise ValueError('unsafe_cache_directory')
        path.chmod(0o700)
    return path


def directory_is_private(path) -> bool:
    try:
        if IS_WINDOWS:
            handle = _windows_open(path, os.O_RDONLY, directory=True)
            kernel.CloseHandle(handle)
            return Path(path).is_dir()
        info = Path(path).lstat()
        return stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
    except (OSError, ValueError): return False


def open_private_directory(path):
    if IS_WINDOWS: return _windows_open(path, os.O_RDONLY, directory=True)
    if not directory_is_private(path): raise ValueError('unsafe_cache_directory')
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def close_directory(descriptor):
    if IS_WINDOWS: kernel.CloseHandle(descriptor)
    else: os.close(descriptor)


def check_directory_binding(descriptor, path):
    if IS_WINDOWS:
        expected = _FileInfo(); _wincheck(kernel.GetFileInformationByHandle(descriptor, ctypes.byref(expected)))
        current = open_private_directory(path)
        try:
            actual = _FileInfo(); _wincheck(kernel.GetFileInformationByHandle(current, ctypes.byref(actual)))
            if (expected.volume, expected.index_high, expected.index_low) != (actual.volume, actual.index_high, actual.index_low):
                raise ValueError('changed_cache_directory')
        finally: close_directory(current)
    else:
        expected, actual = os.fstat(descriptor), os.stat(path, follow_symlinks=False)
        if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino): raise ValueError('changed_cache_directory')


def secure_open(path, flags, mode=0o600, *, repair=False, **kwargs):
    if IS_WINDOWS:
        if kwargs: raise ValueError('unsupported_windows_relative_open')
        return _windows_open(path, flags, repair=repair)
    return os.open(path, flags | os.O_NOFOLLOW, mode, **kwargs)


def validate_file(descriptor, *, private=True, repair=False):
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError('unsafe_cache_file')
    if IS_WINDOWS:
        _windows_security(msvcrt.get_osfhandle(descriptor), protect=repair)
        if repair: _windows_security(msvcrt.get_osfhandle(descriptor))
    else:
        if info.st_uid != os.getuid(): raise ValueError('unsafe_cache_file')
        if repair: os.fchmod(descriptor, 0o600); info = os.fstat(descriptor)
        if private and stat.S_IMODE(info.st_mode) != 0o600: raise ValueError('unsafe_cache_file')
    return info


def protect_path(path, *, directory=False):
    if directory: private_directory(Path(path)); return
    if IS_WINDOWS:
        descriptor = _windows_open(path, os.O_RDWR, repair=True)
        try: validate_file(descriptor)
        finally: os.close(descriptor)
    else: Path(path).chmod(0o600)


def _plain_items(root, *, recursive=True):
    info = root.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('unsafe_reparse_point')
    if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise ValueError('unsafe_cache_file')
    yield root, info
    if stat.S_ISDIR(info.st_mode):
        for child in sorted(root.iterdir()):
            if recursive: yield from _plain_items(child)
            else:
                child_info = child.lstat()
                if stat.S_ISLNK(child_info.st_mode) or getattr(child_info, 'st_file_attributes', 0) & 0x400:
                    raise ValueError('unsafe_reparse_point')
                if not stat.S_ISDIR(child_info.st_mode) and (not stat.S_ISREG(child_info.st_mode) or child_info.st_nlink != 1):
                    raise ValueError('unsafe_cache_file')
                yield child, child_info


def _assert_private_item(path, info):
    if stat.S_ISDIR(info.st_mode):
        descriptor = open_private_directory(path)
        close_directory(descriptor)
    else:
        descriptor = secure_open(path, os.O_RDONLY)
        try: validate_file(descriptor)
        finally: os.close(descriptor)


def snapshot_private_tree(root, *, recursive=True):
    """Record pre-existing protected entries before trusted asset/output creation."""
    root = Path(os.path.abspath(root))
    if not directory_is_private(root): raise ValueError('unsafe_cache_directory')
    result = {}
    for path, info in _plain_items(root, recursive=recursive):
        _assert_private_item(path, info)
        result[path] = (info.st_dev, info.st_ino)
    return result


def _check_generated_root(root, previous):
    if root not in previous or not directory_is_private(root): raise ValueError('unsafe_cache_directory')
    info = root.lstat()
    if (info.st_dev, info.st_ino) != previous[root]: raise ValueError('changed_cache_directory')


def protect_generated_tree(root, previous):
    """Narrow only newly generated items inside the same previously private root."""
    root = Path(os.path.abspath(root))
    _check_generated_root(root, previous)
    for path, info in _plain_items(root):
        if path in previous:
            _assert_private_item(path, info)
        elif IS_WINDOWS:
            _protect_new_generated_item(path, directory=stat.S_ISDIR(info.st_mode))
        else:
            if info.st_uid != os.getuid(): raise ValueError('unsafe_file_owner')
            protect_path(path, directory=stat.S_ISDIR(info.st_mode))
    snapshot_private_tree(root)


def protect_generated_file(path, root, previous):
    """Protect a new direct child output; existing files retain strict validation."""
    path, root = Path(os.path.abspath(path)), Path(os.path.abspath(root))
    if path.parent != root: raise ValueError('unsafe_generated_path')
    _check_generated_root(root, previous)
    info = next(_plain_items(path))[1]
    if not stat.S_ISREG(info.st_mode): raise ValueError('unsafe_cache_file')
    if path in previous:
        _assert_private_item(path, info)
    elif IS_WINDOWS:
        _protect_new_generated_item(path)
    else:
        if info.st_uid != os.getuid(): raise ValueError('unsafe_file_owner')
        protect_path(path)
    _assert_private_item(path, path.lstat())


def lock_exclusive(descriptor):
    if IS_WINDOWS:
        os.lseek(descriptor, 0, os.SEEK_SET)
        try: msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        except OSError as error:
            # Align contention with flock's EAGAIN policy.
            if error.errno in (errno.EACCES, errno.EDEADLK): raise BlockingIOError(errno.EAGAIN, 'lock_busy') from None
            raise
    else: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock(descriptor):
    if IS_WINDOWS:
        os.lseek(descriptor, 0, os.SEEK_SET); msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
    else: fcntl.flock(descriptor, fcntl.LOCK_UN)


def spawn_owned(arguments, *, popen=subprocess.Popen, own_group=True, **kwargs):
    if not IS_WINDOWS:
        if own_group: kwargs.setdefault("start_new_session", True)
        return popen(arguments, **kwargs)
    kwargs.pop('start_new_session', None)
    kwargs['creationflags'] = kwargs.get('creationflags', 0) | 4 | 0x08000000  # SUSPENDED, NO_WINDOW
    job = _wincheck(kernel.CreateJobObjectW(None, None))
    process = None
    try:
        limits = _ExtendedJob(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE
        _wincheck(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        process = popen(arguments, **kwargs)
        _wincheck(kernel.AssignProcessToJobObject(job, int(process._handle)))
        snapshot = kernel.CreateToolhelp32Snapshot(4, 0)
        if snapshot == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = _ThreadEntry(); entry.size = ctypes.sizeof(entry)
            success = kernel.Thread32First(snapshot, ctypes.byref(entry)); resumed = False
            while success:
                if entry.pid == process.pid:
                    thread = _wincheck(kernel.OpenThread(2, False, entry.id))
                    try:
                        if kernel.ResumeThread(thread) == 0xffffffff: raise ctypes.WinError(ctypes.get_last_error())
                        resumed = True
                    finally: kernel.CloseHandle(thread)
                success = kernel.Thread32Next(snapshot, ctypes.byref(entry))
            if not resumed: raise OSError('owned_process_resume_failed')
        finally: kernel.CloseHandle(snapshot)
        process._askgpt_job_handle = job
        process._askgpt_job_lock = threading.Lock()
        return process
    except BaseException:
        try:
            if process is not None:
                kernel.TerminateJobObject(job, 1)
                if process.poll() is None: process.kill()
                process.wait(timeout=3)
        finally: kernel.CloseHandle(job)
        raise


def _terminate_windows_job(job, timeout=3):
    """Terminate and observe every owned descendant's asynchronous process exit."""
    handles = {}
    deadline = time.monotonic() + timeout
    def capture():
        for identity, handle in _job_process_handles(job):
            if identity in handles: kernel.CloseHandle(handle)
            else: handles[identity] = handle
    try:
        capture()
        _wincheck(kernel.TerminateJobObject(job, 1))
        while True:
            if time.monotonic() > deadline: raise TimeoutError('owned_job_cleanup_timeout')
            capture()
            pending = []
            for handle in handles.values():
                state = kernel.WaitForSingleObject(handle, 0)
                if state == 0x102: pending.append(handle)
                elif state != 0: raise OSError('owned_job_wait_failed')
            if not pending:
                known = len(handles)
                capture()  # Include children created during the first termination snapshot.
                if len(handles) == known: return
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('owned_job_cleanup_timeout')
            kernel.WaitForSingleObject(pending[0], max(1, min(50, int(remaining * 1000))))
    finally:
        for handle in handles.values(): kernel.CloseHandle(handle)


def finish_owned(process, *, grace=3.5):
    if IS_WINDOWS:
        if not hasattr(process, '_askgpt_job_handle'): raise ValueError('unowned_process')
        with process._askgpt_job_lock:
            handle = process._askgpt_job_handle
            if handle is None: return
            # The job keeps descendants owned even after its leader exits.
            try:
                if process.poll() is None and grace > 0:
                    try: process.wait(timeout=grace)
                    except subprocess.TimeoutExpired: pass
                _terminate_windows_job(handle)
                if process.poll() is None: process.wait(timeout=3)
                join_pipe_writer(process.stdin)
            finally:
                kernel.CloseHandle(handle); process._askgpt_job_handle = None
        return
    import signal
    try: os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError): return
    deadline = time.monotonic() + max(0, grace)
    while time.monotonic() < deadline:
        try: os.killpg(process.pid, 0)
        except (ProcessLookupError, PermissionError): return
        time.sleep(.025)
    try: os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError): pass


def windows_process_alive(pid):
    handle = kernel.OpenProcess(0x100000, False, pid)
    if not handle: return False
    try: return kernel.WaitForSingleObject(handle, 0) == 0x102
    finally: kernel.CloseHandle(handle)


def write_pipe(pipe, encoded, deadline):
    descriptor = pipe.fileno()
    if IS_WINDOWS:
        # A private duplicate stays owned by this thread. Even cancellation
        # racing the caller's close cannot redirect a late write to a reused fd.
        descriptor = os.dup(descriptor)
        os.set_inheritable(descriptor, False)
        completed = threading.Event(); failures = []
        def writer():
            try:
                pending = memoryview(encoded)
                while pending:
                    count = os.write(descriptor, pending[:65536])
                    if count <= 0: raise BrokenPipeError('pipe_closed')
                    pending = pending[count:]
            except BaseException as error: failures.append(error)
            finally:
                os.close(descriptor)
                completed.set()
        # Timeout caller must retire its owned process before closing the pipe;
        # killing that job unblocks the one outstanding anonymous-pipe writer.
        thread = threading.Thread(target=writer, daemon=True, name='askgpt-pipe-write')
        pipe._askgpt_writer_thread = thread
        thread.start()
        if not completed.wait(max(0, deadline - time.monotonic())): raise TimeoutError('pipe_timeout')
        join_pipe_writer(pipe)
        if failures: raise failures[0]
        return
    os.set_blocking(descriptor, False)
    pending = memoryview(encoded)
    with selectors.DefaultSelector() as selector:
        selector.register(descriptor, selectors.EVENT_WRITE)
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining): raise TimeoutError('pipe_timeout')
            try: count = os.write(descriptor, pending[:65536])
            except BlockingIOError: continue
            if count <= 0: raise BrokenPipeError('pipe_closed')
            pending = pending[count:]


def join_pipe_writer(pipe, timeout=3):
    """After retiring its owned child, join a timed-out writer before close."""
    thread = getattr(pipe, '_askgpt_writer_thread', None)
    if thread is None: return
    thread.join(timeout)
    if thread.is_alive(): raise TimeoutError('pipe_writer_cleanup_timeout')
    pipe._askgpt_writer_thread = None


def read_pipe(pipe, deadline, *, maximum=65536):
    if IS_WINDOWS:
        available = wt.DWORD()
        handle = msvcrt.get_osfhandle(pipe.fileno())
        while time.monotonic() < deadline:
            if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                error = ctypes.get_last_error()
                if error in (109, 232): return b''
                raise ctypes.WinError(error)
            if available.value: return os.read(pipe.fileno(), min(maximum, available.value))
            time.sleep(min(.005, max(0, deadline - time.monotonic())))
        raise TimeoutError('pipe_timeout')
    with selectors.DefaultSelector() as selector:
        selector.register(pipe, selectors.EVENT_READ)
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not selector.select(remaining): raise TimeoutError('pipe_timeout')
        return os.read(pipe.fileno(), maximum)
