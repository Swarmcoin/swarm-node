; SWARM Node installs into its OWN directory.
;
; The owner's earlier AI-compute app is also called "SWARM Node", so the
; default path electron-builder derives from productName would land on top of
; it. A different appId already keeps the two uninstall entries and user-data
; folders apart; this keeps their files apart too, so installing this app can
; never overwrite or convert that one.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\SWARM Node (SWARM testnet)"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\SWARM Node (SWARM testnet)"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\SWARM Node (SWARM testnet)"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\SWARM Node (SWARM testnet)"
!macroend

; STOP THE OLD VERSION, AND ITS DAEMON, BEFORE REPLACING ANY FILES.
;
; N-8, 2026-09-22. The owner installed 0.2.0-testnet.3 over 0.2.0-testnet.2.
; The old version's window was gone, but its zebrad.exe had been running since
; 12:36 and nothing stopped it. It still held the chain database, so the new
; version's daemon died on start with "Database likely already open" and the
; app waited for a node that could never come up.
;
; The daemon is deliberately started detached, so that a real Ctrl-C can be
; delivered to it; that is also why it outlives an app that is closed any way
; other than through its own shutdown. An installer must therefore stop BOTH,
; and must do it before it replaces the files underneath them.
;
; Only this product's own programs are named here. The names are specific on
; purpose: a user's unrelated node must never be caught by an installer.
!macro customInit
  DetailPrint "Stopping any running SWARM Node..."
  ; ONLY PROGRAMS RUNNING FROM THE FOLDER BEING REPLACED.
  ;
  ; `taskkill /IM zebrad.exe` was the obvious thing to write and it is wrong:
  ; this machine also runs a zebrad.exe the owner started by hand, on other
  ; ports, and an installer that kills a user's own node is worse than the
  ; problem it solves. Matching on the executable's PATH catches the old
  ; version - which installs to this same directory - and nothing else.
  nsExec::Exec 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\") } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 1500
!macroend

; The same on the way out: uninstalling must not leave a miner running.
!macro customUnInit
  DetailPrint "Stopping any running SWARM Node..."
  nsExec::Exec 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\") } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 1000
!macroend
