# 调试与验证手册

本文记录本项目在 Windows + Tauri 2 下验证 WebView、Rust IPC、DWM 材质、透明窗口、阴影圆角和持久化的实用方法。

## 1. 基本原则

1. **分层定位**：先确认前端 DOM/CSS，再确认 IPC 设置，最后确认 Win32/DWM 原生状态。只检查其中一层，容易把“属性写成功”误判为“画面正确”。
2. **真实截图优先**：WebView 的 `Page.captureScreenshot` 不包含 DWM 系统背景，透明区域可能呈黑色。材质、圆角和阴影必须使用 Windows 屏幕截图验收。
3. **先备份个人数据**：自动切换设置前备份 `settings.json`，测试结束后恢复，不要让调试脚本污染真实配置。
4. **保留修改前后证据**：同一窗口位置、尺寸和材质下各截一张图，比较圆角、阴影、文字对比度和内容重叠。
5. **测试脚本放临时目录**：一次性 CDP、截图和原生属性脚本放在 `$env:TEMP`，不要混入发布代码。

## 2. 静态检查与运行检查

在项目根目录执行：

```powershell
node --check src/main.js
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

- `node --check` 只检查 JavaScript 语法，不代表 DOM 行为正确。
- `cargo check` 用于快速发现类型、函数参数和平台条件编译问题；修改 Rust 后应先于长时间打包执行。
- `cargo fmt --check` 不修改文件；需要自动格式化时去掉 `-- --check`，执行 `cargo fmt --manifest-path src-tauri/Cargo.toml`。
- `git diff --check` 检查冲突标记和空白错误；Windows 的 LF/CRLF 提示与空白错误不同。

开发运行：

```powershell
npm run dev
```

如果重编译期间调试端口暂时消失，先确认编译是否仍在进行，不要立即重复启动多个实例：

```powershell
Get-Process notepaper,rustc,node -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in @('notepaper.exe','rustc.exe','cargo.exe') } |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine
```

## 3. WebView2 CDP 调试

### 3.1 开启远程调试

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
npm run dev
```

查看可调试页面：

```powershell
(Invoke-WebRequest 'http://127.0.0.1:9222/json/list' -UseBasicParsing).Content
```

从结果中按 `title = 小便签` 和 `type = page` 找到目标，不要假定内部页面端口固定。可以在 Edge 打开 `edge://inspect`，或通过 `webSocketDebuggerUrl` 使用 CDP 的 `Runtime.evaluate`。

### 3.2 检查 IPC 与保存后的设置

在 `Runtime.evaluate` 中执行：

```js
(async () => {
  const settings = await window.__TAURI__.core.invoke("get_settings");
  return settings;
})()
```

使用 `awaitPromise = true` 和 `returnByValue = true`，可直接得到 JSON 值。修改设置后，同时检查：

- 下拉框或主题按钮的前端状态；
- `get_settings` 的 IPC 返回值；
- `%APPDATA%\com.notepaper.sticky\settings.json` 的磁盘内容；
- 重启后的恢复值。

快速连续操作可能暴露异步保存竞态。自动化测试应等待目标设置写入，再进行下一步，并在结束后额外读取一次磁盘文件。

### 3.3 检查透明层与主题状态

```js
(() => {
  const background = (selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return {
      color: style.backgroundColor,
      image: style.backgroundImage,
      visibility: style.visibility
    };
  };
  return {
    theme: document.documentElement.dataset.theme,
    material: document.documentElement.dataset.windowMaterial,
    colorScheme: document.documentElement.style.colorScheme,
    html: background("html"),
    body: background("body"),
    app: background(".app"),
    settings: background("#settingsPane")
  };
})()
```

材质非 `none` 时，全窗容器应为 `rgba(0, 0, 0, 0)` 且无背景图片；`none` 时 `.app` 和设置页应恢复主题渐变。局部卡片、按钮和代码块不要求透明。

## 4. DWM 原生状态验证

### 4.1 读取材质、明暗和圆角属性

将以下内容保存到临时 `.ps1` 后运行，或在 PowerShell 中执行：

```powershell
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NotepaperDwmDebug {
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(
    IntPtr hwnd, int attribute, out int value, int size);
}
'@

$hwnd = (Get-Process notepaper |
  Where-Object MainWindowHandle -NE 0 |
  Select-Object -First 1).MainWindowHandle

$backdrop = -1; $dark = -1; $corner = -1
$r1 = [NotepaperDwmDebug]::DwmGetWindowAttribute($hwnd, 38, [ref]$backdrop, 4)
$r2 = [NotepaperDwmDebug]::DwmGetWindowAttribute($hwnd, 20, [ref]$dark, 4)
$r3 = [NotepaperDwmDebug]::DwmGetWindowAttribute($hwnd, 33, [ref]$corner, 4)
[PSCustomObject]@{
  backdrop = $backdrop; backdropHresult = $r1
  dark = $dark; darkHresult = $r2
  corner = $corner; cornerHresult = $r3
}
```

当前实现的期望值：

| 检查项 | 属性 | 期望值 |
| --- | --- | --- |
| Auto / None / Mica / Acrylic / Mica Alt | 38 | `0 / 1 / 2 / 3 / 4` |
| 浅色 / 深色主题 | 20 | `0 / 1` |
| Windows 11 原生圆角 | 33 | `2`（`DWMWCP_ROUND`） |

HRESULT 应为 `0`。数值正确仍需继续检查真实画面：不透明 WebView、错误明暗或内容重叠都可能让正确属性看起来异常。

### 4.2 截取包含阴影的真实窗口

下面的 PowerShell 示例按窗口矩形截图，并向外扩展 64 像素以保留原生阴影：

```powershell
param([string]$Path = "$env:TEMP\notepaper-window.png", [int]$Margin = 64)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NotepaperCaptureDebug {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][NotepaperCaptureDebug]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$hwnd = (Get-Process notepaper | Where-Object MainWindowHandle -NE 0 | Select-Object -First 1).MainWindowHandle
$rect = New-Object NotepaperCaptureDebug+RECT
[void][NotepaperCaptureDebug]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left + 2 * $Margin
$h = $rect.Bottom - $rect.Top + 2 * $Margin
$bitmap = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left - $Margin, $rect.Top - $Margin, 0, 0, $bitmap.Size)
$bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
```

先把目标窗口置于前台，避免被其他窗口遮挡。高 DPI 下应保留 DPI Awareness 设置，否则窗口坐标和截图尺寸可能不一致。

## 5. 窗口状态与数据安全

### 5.1 读取窗口位置和尺寸

通过 CDP 执行：

```js
(async () => {
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const position = await appWindow.outerPosition();
  const size = await appWindow.innerSize();
  return {
    x: position.x, y: position.y,
    width: size.width, height: size.height,
    dpr: window.devicePixelRatio
  };
})()
```

正常关闭后读取 `%APPDATA%\com.notepaper.sticky\window.json`，重启再执行同一段代码。启用无边框阴影后，Win32 窗口矩形可能包含隐藏偏移，不能只凭截图像素判断恢复是否一致，应比较 Tauri 的位置和内层尺寸。

### 5.2 备份与恢复设置

```powershell
$settings = "$env:APPDATA\com.notepaper.sticky\settings.json"
$backup = "$env:TEMP\notepaper-settings-before-debug.json"
Copy-Item $settings $backup -Force
# 调试结束后，在应用关闭时恢复：
Copy-Item $backup $settings -Force
```

窗口状态、笔记数据和主题分别位于 `window.json`、`data.json`、`themes/**`。导入备份会覆盖数据，不能只备份设置文件。

## 6. 常见现象与定位方向

| 现象 | 优先检查 | 说明 |
| --- | --- | --- |
| CDP 截图背景全黑 | 改用 Windows 屏幕截图 | WebView 截图不包含 DWM 层 |
| DWM 值正确但看不到材质 | `html/body/.app/.settings-pane` 计算背景 | 全窗渐变、蒙层或图片会遮住系统背景 |
| 浅色主题叠在暗色 Mica 上 | 属性 20 与主题 `colorScheme` | CSS 不会自动同步原生窗口明暗 |
| 设置内容与笔记重叠 | 设置打开时底层 `.pane` 是否隐藏 | 设置页透明后不能再依赖不透明背景遮住旧内容 |
| Auto 直接透出后方窗口 | 属性 38 是否为 `0` | Auto 不保证无边框窗口获得整窗 Mica |
| 圆角内仍有矩形材质角 | 属性 33 与 CSS 半径 | CSS 圆角不能单独裁剪 DWM 系统背景 |
| 窗口外看不到 CSS 阴影 | Tauri `shadow` 配置 | 铺满 WebView 的元素阴影会被边缘裁掉，应使用原生阴影 |
| 独立 debug 页面显示 `127.0.0.1` | 完整 `npm run dev` 是否仍运行 | 不要只启动依赖开发资源的应用进程 |
| 重启后材质或位置变化 | 磁盘 JSON、IPC 值和 DWM/窗口指标 | 区分未保存、异步竞态与原生恢复问题 |

## 7. 发布版验证

```powershell
npm run build
```

产物位于：

```text
src-tauri/target/release/notepaper.exe
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

发布版也应至少验证一次启动、当前材质、圆角属性、真实阴影和窗口状态恢复。若需要在自动化 Shell 中保持 GUI 进程运行，可使用：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
$process = Start-Process -FilePath '.\src-tauri\target\release\notepaper.exe' -PassThru
Wait-Process -Id $process.Id
```

调试结束后正常关闭窗口，使 `CloseRequested` 保存窗口状态；再关闭终端、删除临时截图与脚本，并恢复测试前设置。

## 8. 材质窗口最小验收清单

- 五种材质的属性 38 分别为 `0/1/2/3/4`，且 `none` 恢复主题渐变。
- 浅色与深色主题切换后，属性 20 和真实画面同步。
- Windows 11 属性 33 为 `2`，四角无矩形系统背景残留。
- 笔记页和设置页均无内容重叠，文字与图标对比度足够。
- 使用扩展区域的 Windows 截图确认阴影，而非只看 WebView 截图。
- 重启后材质、主题、窗口位置和大小与关闭前一致。
- `node --check`、`cargo fmt --check`、`cargo check`、`git diff --check` 和 `npm run build` 全部通过。
