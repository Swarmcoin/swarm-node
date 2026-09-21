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
