; 卸载时清掉运行时写入的开机自启项。NSIS 卸载器只认安装期创建的文件与注册表项，
; 而自启是应用跑起来之后自己写进 HKCU Run 的（见 desktop/src/autostart.ts 的 setAutostart，
; 调用的是 Electron 的 app.setLoginItemSettings）；不在这里删就会留下一个指向已删除 exe 的
; 死条目，每次登录都白白尝试启动一次。
;
; 删两个值名，因为它们对应两套不同代码路径写入的、值名各不相同的条目：
;
; 1) "com.rockbenben.repo-radar" —— 当前 Electron 版实际写入的值名。
;    确认依据：没有读实机注册表（不能真的往用户机器写自启项去验证），而是直接读了
;    Electron 43.1.1（本项目锁定版本）的 C++ 源码：
;    https://github.com/electron/electron/blob/v43.1.1/shell/browser/browser_win.cc
;    Browser::SetLoginItemSettings 里：
;      PCWSTR key_name = !settings.name.empty() ? settings.name.c_str() : GetAppUserModelID();
;    autostart.ts 里调用 app.setLoginItemSettings({ openAtLogin, args, openAsHidden }) 没有传
;    settings.name，所以落到 GetAppUserModelID()——即 desktop/src/main.ts 里
;    app.setAppUserModelId("com.rockbenben.repo-radar") 设的那个值（与 electron-builder.yml
;    的 appId 逐字相同，二者本来就要求同步修改）。app.setName("repo-radar") 只影响
;    Electron 内部用的应用名（如未打包时的 userData 目录名），不影响这个值名。
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
