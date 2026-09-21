# Sends a real console Ctrl-C (CTRL_C_EVENT) to zebrad by PID.
#
# WHY A SEPARATE PROCESS EXISTS FOR THIS.
# zebrad on Windows only shuts down gracefully when its console receives a
# Ctrl-C: it listens with tokio::signal::ctrl_c and has no SIGTERM equivalent
# and no service control handler. Node/Electron's child.kill('SIGTERM') maps to
# TerminateProcess, which is a hard kill and leaves the RocksDB state directory
# to be repaired on the next start. `taskkill` without /F does nothing to a
# console app with no window.
#
# The event must be generated from a process attached to the child's console,
# and a process can only be attached to one console at a time. Doing it inside
# the Electron main process would mean detaching Electron from its own console
# and delivering the Ctrl-C to Electron's process group as well, so this runs
# as a short-lived helper process instead and dies straight after.
#
# Ported unchanged in behaviour from the 2026-09-21 native-build spike helper
# C:\Users\o5o-o\swarm-work\native-test\send-ctrlc.ps1, which was verified
# against a real zebrad 6.3.0 on this machine.
#
# Exit codes: 0 = event generated, 2 = AttachConsole failed (process gone or
# has no console), 3 = GenerateConsoleCtrlEvent failed.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ProcessId
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace SwarmWin -Name Console -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@

# Leave whatever console this helper was started with, then join the child's.
[void][SwarmWin.Console]::FreeConsole()
if (-not [SwarmWin.Console]::AttachConsole([uint32]$ProcessId)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "AttachConsole($ProcessId) failed: win32 error $code"
    exit 2
}

# Ignore the event in this process so the helper survives to report the result.
[void][SwarmWin.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
# 0 = CTRL_C_EVENT; process group 0 = every process on the attached console.
$sent = [SwarmWin.Console]::GenerateConsoleCtrlEvent(0, 0)
Start-Sleep -Milliseconds 200
[void][SwarmWin.Console]::FreeConsole()
[void][SwarmWin.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)

if (-not $sent) {
    Write-Error 'GenerateConsoleCtrlEvent(CTRL_C_EVENT) failed'
    exit 3
}
Write-Output "CTRL_C_EVENT sent to PID $ProcessId"
exit 0
