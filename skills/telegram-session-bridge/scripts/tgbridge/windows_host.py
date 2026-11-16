"""Windows process identities and bounded, job-owned trusted host hooks."""

import json
import msvcrt
import os
import subprocess
import tempfile

import pywintypes
import win32api
import win32con
import win32event
import win32job
import win32process


def process_identity(pid):
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        return None
    process = None
    try:
        process = win32api.OpenProcess(0x1000 | win32con.SYNCHRONIZE, False, pid)
        if win32event.WaitForSingleObject(process, 0) != win32event.WAIT_TIMEOUT:
            return None
        times = win32process.GetProcessTimes(process)
        return (pid, times["CreationTime"].isoformat())
    except pywintypes.error:
        return None
    finally:
        if process is not None:
            process.Close()


def send(command, payload, timeout):
    """Start suspended so the job owns every descendant before any hook runs."""
    process = thread = job = None
    inherited = []
    try:
        with (
            tempfile.TemporaryFile() as incoming,
            tempfile.TemporaryFile() as output,
            open(os.devnull, "wb") as errors,
        ):
            incoming.write(json.dumps(payload).encode())
            incoming.seek(0)
            current = win32api.GetCurrentProcess()
            for stream in (incoming, output, errors):
                inherited.append(
                    win32api.DuplicateHandle(
                        current,
                        msvcrt.get_osfhandle(stream.fileno()),
                        current,
                        0,
                        True,
                        win32con.DUPLICATE_SAME_ACCESS,
                    )
                )
            startup = win32process.STARTUPINFO()
            startup.dwFlags = (
                win32con.STARTF_USESTDHANDLES | win32con.STARTF_USESHOWWINDOW
            )
            startup.wShowWindow = win32con.SW_HIDE
            startup.hStdInput, startup.hStdOutput, startup.hStdError = inherited
            job = win32job.CreateJobObject(None, "")
            limits = win32job.QueryInformationJobObject(
                job, win32job.JobObjectExtendedLimitInformation
            )
            limits["BasicLimitInformation"]["LimitFlags"] |= (
                win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            )
            win32job.SetInformationJobObject(
                job, win32job.JobObjectExtendedLimitInformation, limits
            )
            process, thread, _, _ = win32process.CreateProcess(
                None,
                subprocess.list2cmdline(command),
                None,
                None,
                True,
                win32con.CREATE_SUSPENDED | win32con.CREATE_NO_WINDOW,
                None,
                None,
                startup,
            )
            win32job.AssignProcessToJobObject(job, process)
            win32process.ResumeThread(thread)
            if (
                win32event.WaitForSingleObject(process, max(1, int(timeout * 1000)))
                == win32event.WAIT_TIMEOUT
            ):
                win32job.TerminateJobObject(job, 1)
                win32event.WaitForSingleObject(process, 5000)
                return {"status": "unsupported", "reason": "timeout"}
            if win32process.GetExitCodeProcess(process) != 0:
                return {"status": "unsupported", "reason": "failed"}
            # Closing the job also stops children left behind by a successful hook.
            job.Close()
            job = None
            output.seek(0)
            response = json.loads(output.read(8193))
            if isinstance(response, dict) and response.get("status") == "accepted":
                return {"status": "accepted"}
    except (pywintypes.error, OSError, ValueError, TypeError):
        return {"status": "unsupported", "reason": "unsupported"}
    finally:
        if process is not None:
            if win32event.WaitForSingleObject(process, 0) == win32event.WAIT_TIMEOUT:
                win32api.TerminateProcess(process, 1)
            process.Close()
        for handle in [thread, job, *inherited]:
            if handle is not None:
                handle.Close()
    return {"status": "unsupported", "reason": "unsupported"}
