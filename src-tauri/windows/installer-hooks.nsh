; DBTerm — NSIS 安装/卸载钩子（Tauri v2）
;
; 作用：卸载时单独询问是否一并删除本机用户数据
;       （连接配置 / 密码 / 已信任主机 known_hosts）。
; 数据目录：%APPDATA%\com.dbterm.client —— 与 tauri.conf.json 的 identifier 一致，
;          $APPDATA 在 NSIS 中即 Roaming 目录。
;
; 四个钩子宏全部定义（未用的留空），避免模板插入未定义宏导致编译报错。

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 默认（静默卸载时）选「否」=保留数据，避免误删用户连接。
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 DBTerm 保存的本机数据？$\n$\n包含：连接配置、密码、已信任主机(known_hosts)。$\n$\n是 = 彻底删除（不可恢复）；否 = 保留，方便重装后继续使用。" /SD IDNO IDNO dbterm_keep_data
  RMDir /r "$APPDATA\com.dbterm.client"
  dbterm_keep_data:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
