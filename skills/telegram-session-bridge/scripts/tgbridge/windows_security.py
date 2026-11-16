"""Native Windows private storage; no chmod-based security assumptions."""

import msvcrt
from pathlib import Path

import ntsecuritycon
import pywintypes
import win32api
import win32con
import win32file
import win32security
import winerror


def current_sid():
    token = win32security.OpenProcessToken(
        win32api.GetCurrentProcess(), win32con.TOKEN_QUERY
    )
    try:
        return win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()


def private_descriptor(*, directory=False, readonly=False):
    sid = current_sid()
    acl = win32security.ACL()
    inheritance = 3 if directory else 0
    acl.AddAccessAllowedAceEx(
        win32security.ACL_REVISION,
        inheritance,
        ntsecuritycon.FILE_GENERIC_READ if readonly else ntsecuritycon.FILE_ALL_ACCESS,
        sid,
    )
    descriptor = win32security.SECURITY_DESCRIPTOR()
    descriptor.SetSecurityDescriptorOwner(sid, False)
    descriptor.SetSecurityDescriptorDacl(True, acl, False)
    descriptor.SetSecurityDescriptorControl(win32security.SE_DACL_PROTECTED, 0x1000)
    return descriptor


def private_directory(path, *, parents=True):
    path = Path(path)
    if path.exists():
        check_private(path, directory=True)
        return
    if parents and not path.parent.exists():
        private_directory(path.parent)
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = private_descriptor(directory=True)
    try:
        win32file.CreateDirectory(str(path), attributes)
    except pywintypes.error as exc:
        if exc.winerror != winerror.ERROR_ALREADY_EXISTS:
            raise
    check_private(path, directory=True)


def _check_descriptor(descriptor):
    sid = current_sid()
    if descriptor.GetSecurityDescriptorOwner() != sid:
        raise ValueError("Private storage must be owned by the current Windows user")
    acl = descriptor.GetSecurityDescriptorDacl()
    if acl is None:
        raise ValueError("Private storage requires a DACL")
    trusted = {
        win32security.ConvertSidToStringSid(sid),
        "S-1-5-18",  # SYSTEM and Administrators are privileged on Windows already.
        "S-1-5-32-544",
        "S-1-3-4",  # OWNER RIGHTS applies only to the already-validated owner.
    }
    for index in range(acl.GetAceCount()):
        ace = acl.GetAce(index)
        kind = ace[0][0]
        if kind == win32security.ACCESS_DENIED_ACE_TYPE:
            continue
        if kind != win32security.ACCESS_ALLOWED_ACE_TYPE:
            raise ValueError("Unsupported private-storage ACL entry")
        if win32security.ConvertSidToStringSid(ace[2]) not in trusted and ace[1]:
            raise ValueError(
                "Private storage grants access to another Windows principal"
            )


def check_private(path, *, directory=False, fd=None):
    own_handle = fd is None
    handle = (
        win32file.CreateFile(
            str(path),
            win32con.READ_CONTROL,
            win32con.FILE_SHARE_READ
            | win32con.FILE_SHARE_WRITE
            | win32con.FILE_SHARE_DELETE,
            None,
            win32con.OPEN_EXISTING,
            win32con.FILE_FLAG_BACKUP_SEMANTICS
            | win32file.FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        if own_handle
        else msvcrt.get_osfhandle(fd)
    )
    try:
        attributes = win32file.GetFileInformationByHandle(handle)[0]
        if attributes & win32con.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("Reparse points are not permitted in private paths")
        if bool(attributes & win32con.FILE_ATTRIBUTE_DIRECTORY) != directory:
            raise ValueError("Private storage has the wrong file type")
        descriptor = win32security.GetSecurityInfo(
            handle,
            win32security.SE_FILE_OBJECT,
            win32security.OWNER_SECURITY_INFORMATION
            | win32security.DACL_SECURITY_INFORMATION,
        )
        _check_descriptor(descriptor)
    finally:
        if own_handle:
            handle.Close()


def open_nofollow(path, flags, mode=0o600):
    import os

    if flags & os.O_EXCL:
        disposition = win32con.CREATE_NEW
    elif flags & os.O_CREAT:
        disposition = win32con.OPEN_ALWAYS
    else:
        disposition = win32con.OPEN_EXISTING
    writable = bool(flags & (os.O_WRONLY | os.O_RDWR))
    access = win32con.GENERIC_READ | win32con.READ_CONTROL
    if writable:
        access |= win32con.GENERIC_WRITE
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = private_descriptor()
    handle = win32file.CreateFile(
        str(path),
        access,
        win32con.FILE_SHARE_READ
        | win32con.FILE_SHARE_WRITE
        | win32con.FILE_SHARE_DELETE,
        attributes,
        disposition,
        win32file.FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    try:
        attributes = win32file.GetFileInformationByHandle(handle)[0]
        if attributes & (
            win32con.FILE_ATTRIBUTE_REPARSE_POINT | win32con.FILE_ATTRIBUTE_DIRECTORY
        ):
            raise ValueError("Expected a regular file without reparse points")
        return msvcrt.open_osfhandle(handle.Detach(), flags | os.O_BINARY)
    finally:
        handle.Close()


def readonly_snapshot(fd):
    descriptor = private_descriptor(readonly=True)
    handle = win32file.ReOpenFile(
        msvcrt.get_osfhandle(fd),
        win32con.WRITE_DAC | win32con.READ_CONTROL,
        win32con.FILE_SHARE_READ
        | win32con.FILE_SHARE_WRITE
        | win32con.FILE_SHARE_DELETE,
        win32file.FILE_FLAG_OPEN_REPARSE_POINT,
    )
    try:
        win32security.SetSecurityInfo(
            handle,
            win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION
            | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            descriptor.GetSecurityDescriptorDacl(),
            None,
        )
    finally:
        handle.Close()
