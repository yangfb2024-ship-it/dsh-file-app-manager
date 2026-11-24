# 文件与应用 · dsh-file-app-manager

DSH 插件（Cordis bundle）：在 DSH Web GUI 里用一个面板直观地管理本机文件和已安装应用。

- 侧栏「文件与应用」（order 25）→ 主栏页面，两个页签：**文件**、**应用**。
- 文件：常用位置 + 盘符（含占用条）、面包屑、Ctrl/Shift 多选、双击打开、右键菜单（打开 / 在资源管理器中定位 / 复制路径 / 重命名 / 删除进回收站 / 统计文件夹大小）、新建文件夹、按名搜索。
- 应用：读注册表 Uninstall 键（HKLM 64/32 位 + HKCU），显示版本、发布者、安装日期、体积、范围，支持启动 / 打开安装位置 / 卸载（调原厂卸载器）。

## 从 GitHub 安装

仓库：<https://github.com/yangfb2024-ship-it/dsh-file-app-manager>

```powershell
# 1. 克隆到任意目录
git clone https://github.com/yangfb2024-ship-it/dsh-file-app-manager.git C:\plugins\dsh-file-app-manager

# 2. 链接进 profile 的 node_modules
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-file-app-manager" "C:\plugins\dsh-file-app-manager"
```

再按下面「安装（桌面版 profile）」第 2 步，把包名加进 profile 的 `dependencies` 与 `dsh.profile.bundles` 即可。宿主半端会热加载，刷新页面就能看到侧栏面板。

## 结构

| 路径 | 作用 |
| --- | --- |
| `package.json` | 插件清单；`dsh.bundle.patch` 指向 patch 文件，`dsh.client` 声明浏览器半端 |
| `cordis.patch.yml` | `- insert:` 一条 loader entry（id 与包名一致） |
| `lib/index.js` | 宿主半端：`inject: ['webServer']`，注册单条 RPC 路由 |
| `lib/client.js` | 客户端半端：`window.__ModuleLoader__.load({ id, factory })`，注册两个 slot |
| `icon.svg` | 面板/商城图标 |
| `test/host-smoke.mjs` | 假 ctx + 真 HTTP server，逐个 op 冒烟 |
| `.test/client-render.test.mjs` | react-test-renderer 离线渲染客户端半端 |

## 通信

浏览器 → 宿主只有一个入口：

```
POST api/dsh-file-app-manager/rpc      (document-relative，兼容 <base href="./">)
{ "op": "<op>", ...payload }
→ { "ok": true, "data": ... } | { "ok": false, "error": "..." }
```

宿主只接受**本机回环请求**（socket 为 127/8 或 ::1、无 `cf-connecting-ip` / `x-forwarded-for`、Host 为回环、`sec-fetch-site` 非 cross-site、Origin 与 Host 同源），否则 403。

op：`drives` `places` `list` `tree` `open` `reveal` `mkdir` `rename` `remove` `search` `size` `apps` `appLaunch` `appLocation` `appUninstall` `health`。

## 实现要点

- **PowerShell 桥**：文件与应用的大多数操作交给 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass`。脚本把结果放进 `$__result`，统一 `ConvertTo-Json -Compress` 写到 `%TEMP%\dsh-fam-<uuid>.out.json` 再由 Node 读回 —— **刻意不读 stdout**，因为控制台代码页会破坏中文文件名/应用名。入参经 `%TEMP%\*.in.json` 传入，避免引号转义。
- **删除进回收站**：`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile/DeleteDirectory(..., 'OnlyErrorDialogs', 'SendToRecycleBin')`，批量逐项返回 `{ ok, error }`。
- **应用清单**：扫 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`（64 位视图）、`HKLM\SOFTWARE\WOW6432Node\...`（32 位视图）、`HKCU\...`；过滤无 DisplayName、`SystemComponent=1`、`ParentKeyName` 非空、update/hotfix/servicepack 类 ReleaseType，按 name+version 去重。缓存 60s（盘符 15s）。
- **样式**：一段 CSS 注入 `document.head`（`data-dsh-file-app-manager`），只用 `--dsw-alias-*` 主题变量，浅深色跟随宿主；effect dispose 时移除。
- **无构建步骤**：纯 ESM/JS，手写 loader 包装，只 `require('react')`。

## 安装（桌面版 profile）

本机没有暴露 `dsh` CLI，所以用「junction + profile 清单」注册：

1. 链接进 profile 的 `node_modules`：
   ```powershell
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-file-app-manager" "C:\应用安装\dsh\dsh_workspace\dsh-file-app-manager"
   ```
2. `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   - `dependencies` 加 `"dsh-file-app-manager": "link:C:\\应用安装\\dsh\\dsh_workspace\\dsh-file-app-manager"`
   - `dsh.profile.bundles` 末尾加 `"dsh-file-app-manager"`
3. 宿主半端热加载，无需重启；`POST /api/dsh-file-app-manager/rpc {"op":"health"}` 返回 `{"ok":true,...}` 即生效。

卸载：移除 `bundles` 里的条目与依赖链接，删除 junction 即可（或不删 junction，只移除 bundles 条目来临时禁用）。

## 开发与自检

```powershell
node --check lib/index.js
node --check lib/client.js
node test/host-smoke.mjs           # 宿主半端各个 op
node .test/client-render.test.mjs  # 客户端半端渲染（29 项断言）
```

客户端半端的真实加载状态可以这样确认（宿主 `/plugins` 路由不需要 GUI 认证）：

```powershell
# SSE 图里应出现 entry id = dsh-file-app-manager，且 url 里的 rev 能取回 bundle
curl -N -H "accept: text/event-stream" http://127.0.0.1:51082/plugins/events
```

`.test/node_modules` 只是测试用的 react 依赖，不参与插件运行。

## 已知边界

- 搜索是 BFS，8 秒 / 6000 目录 / 500 条上限，超时返回 `truncated`。
- 文件夹大小统计 4 秒上限，结果为下限。
- 卸载执行的是注册表里的原厂卸载命令（quiet 优先）；卸载器自身的窗口由它自己负责。
- 只支持 Windows（依赖注册表与 PowerShell）。
