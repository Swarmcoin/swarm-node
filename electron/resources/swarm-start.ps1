# Starts a console program with a REAL but hidden console, and prints its PID.
#
# WHY THIS EXISTS — measured on this machine on 2026-09-21.
# Node/Electron's spawn({ windowsHide: true }) makes libuv pass CREATE_NO_WINDOW.
# A process created that way never acts on CTRL_C_EVENT: AttachConsole succeeds
# and GenerateConsoleCtrlEvent reports success, yet zebrad keeps running and has
# to be killed hard. Measured over 5 start/stop cycles: 0 graceful stops, every
# one ending in taskkill /F after the 25 s budget.
# Start-Process -WindowStyle Hidden instead uses CREATE_NEW_CONSOLE plus SW_HIDE,
# which gives the child a real console with no visible window. With the identical
# Ctrl-C helper, the same zebrad then shut down in 377 ms.
#
# So every console child of SWARM Node is launched through this script: no window
# is ever shown, and the child can still be stopped the only way zebrad supports.
#
# Output goes to files because a hidden-console child cannot also hand its stdout
# back through a pipe; the app tails those files for its log view.
#
# The whole request arrives as ONE base64 parameter holding JSON. That keeps
# Windows command-line quoting out of the picture entirely: base64 is letters,
# digits, "+", "/" and "=", so nothing in a path or an argument can be re-parsed
# by PowerShell, and no shell string is ever assembled.
#
# Prints one line of JSON: {"pid":1234}

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9+/=]+$')]
    [string]$RequestB64
)

$ErrorActionPreference = 'Stop'

# Ctrl-C processing is a per-process flag that children INHERIT at creation.
# A parent that called SetConsoleCtrlHandler(NULL, TRUE) — some terminals and
# job runners do — passes "ignore Ctrl-C" all the way down, and zebrad then
# cannot be stopped gracefully by anyone. Measured here on 2026-09-21: the same
# code stopped 0/3 nodes gracefully when launched from an MSYS2 bash and 3/3
# from a normal console. Re-enabling it explicitly makes the child's behaviour
# independent of whatever started SWARM Node.
Add-Type -Namespace SwarmWin -Name Start -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);
'@
# Add = FALSE with a NULL routine removes the "ignore Ctrl-C" entry, so the
# child inherits normal Ctrl-C handling.
[void][SwarmWin.Start]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)

$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestB64))
$req = $json | ConvertFrom-Json

if (-not $req.bin) { throw 'request has no bin' }
if (-not (Test-Path -LiteralPath $req.bin -PathType Leaf)) { throw "binary not found: $($req.bin)" }
if (-not (Test-Path -LiteralPath $req.cwd -PathType Container)) { throw "working directory not found: $($req.cwd)" }

$startArgs = @{
    FilePath               = $req.bin
    WorkingDirectory       = $req.cwd
    RedirectStandardOutput = $req.stdout
    RedirectStandardError  = $req.stderr
    WindowStyle            = 'Hidden'
    PassThru               = $true
}
# ArgumentList is an array, never a command line assembled by string building.
if ($req.args -and @($req.args).Count -gt 0) { $startArgs['ArgumentList'] = [string[]]@($req.args) }

$p = Start-Process @startArgs
if (-not $p) { throw 'Start-Process returned nothing' }

Write-Output ('{"pid":' + $p.Id + '}')
exit 0
