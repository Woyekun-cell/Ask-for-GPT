(function (root) {
  'use strict';
  function windows(dependencies) {
    return dependencies.Services?.appinfo?.OS === 'WINNT' || dependencies.Zotero?.isWin === true;
  }
  function readerDirectory(dependencies) {
    const { Services, Components } = dependencies;
    const file = Services.dirsvc.get(windows(dependencies) ? 'AppData' : 'Home', Components.interfaces.nsIFile).clone();
    for (const part of windows(dependencies) ? ['AskGPTReader'] : ['Library', 'Application Support', 'AskGPTReader']) file.append(part);
    return file;
  }
  function error() { const value = new Error('unsafe_connection_file'); value.code = 'permissions'; return value; }

  // Zotero's privileged Gecko process provides js-ctypes. Unix mode bits do
  // not describe an NTFS DACL, so Windows validates the opened native object.
  function nativeWindowsFile(dependencies, file, write = false, directory = false, createNew = false) {
    const ctypes = dependencies.ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs').ctypes;
    const kernel = ctypes.open('kernel32.dll'), advapi = ctypes.open('advapi32.dll');
    const P = ctypes.voidptr_t, D = ctypes.uint32_t, B = ctypes.int32_t, W = ctypes.uint16_t;
    const wide = ctypes.jschar.ptr, bind = (lib, name, result, args) => lib.declare(name, ctypes.winapi_abi, result, ...args);
    const close = bind(kernel, 'CloseHandle', B, [P]);
    const free = bind(kernel, 'LocalFree', P, [P]);
    const create = bind(kernel, 'CreateFileW', P, [wide, D, D, P, D, D, P]);
    const attributes = bind(kernel, 'GetFileAttributesW', D, [wide]);
    const info = bind(kernel, 'GetFileInformationByHandle', B, [P, D.ptr]);
    const current = bind(kernel, 'GetCurrentProcess', P, []);
    const openToken = bind(advapi, 'OpenProcessToken', B, [P, D, P.ptr]);
    const tokenInfo = bind(advapi, 'GetTokenInformation', B, [P, D, P, D, D.ptr]);
    const sidText = bind(advapi, 'ConvertSidToStringSidW', B, [P, wide.ptr]);
    const securityInfo = bind(advapi, 'GetSecurityInfo', D, [P, D, D, P.ptr, P.ptr, P.ptr, P.ptr, P.ptr]);
    const securityControl = bind(advapi, 'GetSecurityDescriptorControl', B, [P, W.ptr, D.ptr]);
    const getAce = bind(advapi, 'GetAce', B, [P, D, P.ptr]);
    const convertDescriptor = bind(advapi, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', B, [wide, D, P.ptr, D.ptr]);
    const writeFile = bind(kernel, 'WriteFile', B, [P, P, D, D.ptr, P]);
    const setEnd = bind(kernel, 'SetEndOfFile', B, [P]);
    const SecurityAttributes = ctypes.StructType('SECURITY_ATTRIBUTES', [{length:D}, {descriptor:P}, {inherit:B}]);
    let handle = null;
    const check = value => { if (!value) throw error(); return value; };
    function sid(value) {
      const text = wide(); check(sidText(value, text.address()));
      try { return text.readString(); } finally { free(text); }
    }
    function userSID() {
      const token = P(); check(openToken(current(), 8, token.address()));
      try {
        const required = D(); tokenInfo(token, 1, null, 0, required.address());
        if (!required.value || required.value > 65536) throw error();
        const buffer = ctypes.uint8_t.array(required.value)();
        check(tokenInfo(token, 1, buffer, required.value, required.address()));
        return sid(ctypes.cast(buffer.address(), P.ptr).contents);
      } finally { close(token); }
    }
    try {
      for (let cursor = file; cursor; cursor = cursor.parent) {
        const value = attributes(cursor.path);
        if (cursor === file && createNew && value === 0xffffffff && !file.exists()) continue;
        if (value === 0xffffffff || (value & 0x400)) throw error();
      }
      const newDescriptor = P();
      try {
        let security = null;
        if (createNew) {
          const user = userSID();
          const sddl = `O:${user}D:P` + [user, 'SY', 'BA'].map(value => `(A;;FA;;;${value})`).join('');
          check(convertDescriptor(sddl, 1, newDescriptor.address(), null));
          security = SecurityAttributes(SecurityAttributes.size, newDescriptor, 0);
        }
        handle = create(file.path, 0x20000 | (write ? 0x40000000 : 0x80000000), 1,
                        security ? security.address() : null, createNew ? 1 : 3,
                        0x00200000 | (directory ? 0x02000000 : 0), null);
      } finally { if (!newDescriptor.isNull()) free(newDescriptor); }
      if (handle.isNull() || ctypes.cast(handle, ctypes.intptr_t).value.toString() === '-1') { handle = null; throw error(); }
      const details = D.array(13)(); check(info(handle, details));
      if ((details[0] & 0x400) || Boolean(details[0] & 0x10) !== directory || (!directory && details[10] !== 1)) throw error();
      if (!directory && (details[8] !== 0 || details[9] > 4096)) throw error();
      const owner = P(), dacl = P(), descriptor = P();
      if (securityInfo(handle, 1, 5, owner.address(), null, dacl.address(), null, descriptor.address()) !== 0) throw error();
      try {
        const user = userSID(), control = W(), revision = D();
        if (owner.isNull() || sid(owner) !== user || dacl.isNull()) throw error();
        check(securityControl(descriptor, control.address(), revision.address()));
        if (!(control.value & 0x1000)) throw error();
        const count = ctypes.cast(dacl, W.ptr).increment(2).contents;
        if (!count || count > 128) throw error();
        const allowed = new Set([user, 'S-1-5-18', 'S-1-5-32-544']); let hasUser = false;
        for (let index = 0; index < count; index++) {
          const ace = P(); check(getAce(dacl, index, ace.address()));
          const bytes = ctypes.cast(ace, ctypes.uint8_t.ptr);
          if (bytes.contents !== 0) throw error();
          const trustee = sid(bytes.increment(8));
          if (!allowed.has(trustee)) throw error();
          hasUser ||= trustee === user;
        }
        if (!hasUser) throw error();
      } finally { if (!descriptor.isNull()) free(descriptor); }
      let disposed = false;
      const release = () => { if (disposed) return; disposed = true; close(handle); advapi.close(); kernel.close(); };
      release.write = text => {
        if (!write || disposed) throw error();
        const encoded = new TextEncoder().encode(text);
        if (encoded.length > 4096) throw error();
        const buffer = ctypes.uint8_t.array(encoded.length)();
        for (let index = 0; index < encoded.length; index++) buffer[index] = encoded[index];
        const written = D(); check(writeFile(handle, buffer, encoded.length, written.address(), null));
        if (written.value !== encoded.length) throw error();
        check(setEnd(handle));
      };
      return release;
    } catch (_) {
      if (handle) close(handle);
      advapi.close(); kernel.close(); throw error();
    }
  }

  async function withPrivateFile(dependencies, file, callback, write = false) {
    if (!file.exists() || !file.isFile() || file.isSymlink() || file.fileSize > 4096) throw error();
    if (windows(dependencies)) {
      const release = nativeWindowsFile(dependencies, file, write);
      try { return await callback(file.path); } finally { release(); }
    }
    if ((file.permissions & 0o077) !== 0) throw error();
    return callback(file.path);
  }

  async function writeDiagnostic(dependencies, record) {
    const { Components, Zotero } = dependencies, directory = readerDirectory(dependencies);
    if (windows(dependencies)) {
      // The application owns creation and DACL protection. Never create a
      // diagnostic in an unprotected fallback directory when it is absent.
      if (!directory.exists()) return;
      const release = nativeWindowsFile(dependencies, directory, false, true);
      try {
        const file = directory.clone(); file.append('pdf-inline-diagnostic.json');
        const output = nativeWindowsFile(dependencies, file, true, false, !file.exists());
        try { output.write(JSON.stringify(record)); } finally { output(); }
      } finally { release(); }
      return;
    }
    if (!directory.exists()) directory.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
    if (directory.isSymlink()) return;
    const file = directory.clone(); file.append('pdf-inline-diagnostic.json');
    if (file.exists() && file.isSymlink()) return;
    if (!file.exists()) file.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o600);
    file.permissions = 0o600;
    await withPrivateFile(dependencies, file, path => Zotero.File.putContentsAsync(path, JSON.stringify(record)), true);
    file.permissions = 0o600;
  }
  const api = { windows, readerDirectory, withPrivateFile, writeDiagnostic };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AskGPTConnectionSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
