; 按系统 DPI 绘制向导，避免 Windows 放大低分辨率的图标和文字。
!macro customHeader
  ManifestDPIAware true
!macroend

; electron-builder 在覆盖安装时可能保留现有快捷方式。同步现有链接的 AUMID，
; 让开始菜单、桌面、任务栏和通知都识别同一个应用。
!macro customInstall
  ${If} ${FileExists} "$newStartMenuLink"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${EndIf}
  ${If} ${FileExists} "$newDesktopLink"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
!macroend

; 卸载时清掉运行时写入的开机自启项。NSIS 卸载器只认安装期创建的文件与注册表项，
; 而自启是应用跑起来之后自己写进 HKCU Run 的（见 desktop/src/autostart.ts 的 setAutostart，
; 调用的是 Electron 的 app.setLoginItemSettings）；不在这里删就会留下一个指向已删除 exe 的
; 死条目，每次登录都白白尝试启动一次。
;
; 删两个值名，因为它们对应两套不同代码路径写入的、值名各不相同的条目：
;
; 1) "com.rockbenben.repo-radar" —— 旧 AUMID，也是 autostart.ts 显式传给
;    app.setLoginItemSettings 的 Windows 注册表值名。任务栏迁移后继续用该值名。
;
; 2) "repo-radar" —— 旧 SEA（Node.js Single Executable Application）版遗留的值名，
;    见 autostart.ts 里 cleanupLegacyEntries() 对同名条目的清理逻辑（那是非 Electron 时代
;    手写的自启注册，硬编码了这个值名）。理论上应用启动时的 cleanupLegacyEntries() 已经会
;    清掉它，但那一步依赖 `reg export` 命令可用；如果用户机器上这一步曾经静默失败
;    （见 autostart.ts 里 regReadValue 的注释：reg 不在 PATH 等情况会返回 null 从而保守跳过），
;    这个旧值就可能残留到卸载时刻。多删一个值名成本为零，删两个更保险。
;
; DeleteRegValue 对不存在的值是无害的空操作，不会报错，两条都可以放心执行。
;
; 但不能无条件执行：electron-builder 的 NSIS 在原地升级（用户直接装新版覆盖旧版）时，
; 会先以静默模式调用旧版的卸载器来清掉旧版文件，走的正是这同一个 customUnInstall 宏——
; 卸载和"升级时的隐式卸载"是同一段代码。如果不加区分，用户每次升级都会触发这里，
; 把刚才还生效的开机自启删掉；而新安装器不会重建它（自启只由运行时的
; app.setLoginItemSettings 写入，安装器本身从不写这两个注册表值），于是应用悄悄
; 不再随登录启动，用户往往要等到下次重启后发现托盘图标不见了才会注意到，且没有任何提示。
;
; electron-builder 在卸载流程里提供了 ${isUpdated}（NSIS 里其它内置逻辑，如清 userData 的
; --delete-app-data 分支，就是用它区分同样的两种场景，见
; node_modules/app-builder-lib/templates/nsis/uninstaller.nsh 第 224 行的
; `${ifNot} ${isUpdated}` 用法）：原地升级时为 true，用户主动执行"卸载"时为 false。
; 只在真正卸载（不是升级）时才清理这两个值，让升级路径保持自启不受影响。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.rockbenben.repo-radar"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "repo-radar"
  ${endIf}
!macroend
