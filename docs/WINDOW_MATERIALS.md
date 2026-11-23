# Tauri 2 Windows 窗口材质实现指南

## 结论

Tauri 2 可以通过 `Window/WebviewWindow.set_effects()` 间接调用 `window-vibrancy`，也可以在 Windows 上直接调用 DWM API。对于需要精确提供 **自动、无、Mica、Acrylic、Mica Alt** 五个选项的无边框应用，推荐采用以下组合：

1. Windows 11 支持 `DWMWA_SYSTEMBACKDROP_TYPE` 时，直接写入 `0–4`，避免高级 API 缺少 `Auto` 选项。
2. 旧系统使用 Tauri 的 `Effect` 作为兼容回退，不把回退结果误认为完全相同的材质。
3. 原生材质显示期间，`html`、`body` 和覆盖整个窗口的应用容器必须保持透明；不能用 CSS 渐变、蒙层或背景图片再盖一层。
4. 使用应用自带明暗主题时，还要同步 `DWMWA_USE_IMMERSIVE_DARK_MODE`；DWM 不会读取 WebView 的 CSS `color-scheme`，否则浅色页面可能叠在暗色 Mica 上。
5. `DwmGetWindowAttribute()` 返回正确数值只证明属性写入成功，不能证明 WebView 没有遮挡材质，仍须检查实际截图。

## 1. 系统材质的真实含义

`DWM_SYSTEMBACKDROP_TYPE` 是 DWM 为窗口绘制系统背景的枚举。材质由系统绘制在窗口后方，不是一张可以由前端任意设置透明度的图片。[cite:5]

| 应用选项 | DWM 枚举 | 数值 | Windows 11 对应效果 | 重要限制 |
| --- | --- | ---: | --- | --- |
| 自动 | `DWMSBT_AUTO` | 0 | 由 DWM 决定 | 只保证默认 Win32 标题栏后的背景；DWM 可以不绘制任何材质，不适合作为无边框窗口的整窗 Mica 开关 |
| 无 | `DWMSBT_NONE` | 1 | 不绘制系统背景 | 应恢复应用自己的 CSS 背景 |
| Mica | `DWMSBT_MAINWINDOW` | 2 | 默认 Mica | 面向长期存在的主窗口，绘制在整个窗口范围 |
| Acrylic | `DWMSBT_TRANSIENTWINDOW` | 3 | 最亮变体的 Desktop Acrylic / Background Acrylic | 面向临时窗口；并非普通 Web 页面里的半透明 CSS 背景 |
| Mica Alt | `DWMSBT_TABBEDWINDOW` | 4 | Mica Alt | 面向带选项卡标题栏的窗口，色调比 Mica 更强 |

`Auto` 的语义尤其容易被误解。微软文档明确说明它用于保持兼容性，可能只在默认标题栏后绘制，甚至可能不绘制。因此，无边框 Tauri 应用若需要明确的整窗材质，应选择 `MAINWINDOW`、`TRANSIENTWINDOW` 或 `TABBEDWINDOW`，不要把 `Auto` 当作 Mica。[cite:5]

Mica 是**不透明**动态材质，采样桌面壁纸并融合系统主题；它不是实时透出其他窗口的玻璃。Acrylic 才是具有半透明质感的材质，其中 Background Acrylic 会显示桌面及后方窗口。关闭系统“透明效果”、节电模式、窗口失活等情况下，Acrylic 也可能变成实色，不能仅凭某一次截图判断代码失效。[cite:8][cite:9]

## 2. Tauri 提供的两条实现路径

### 2.1 高级 API：`set_effects`

Rust 侧可使用 `Effect` 与 `EffectsBuilder`：

```rust
use tauri::window::{Effect, EffectsBuilder};

window
    .set_effects(EffectsBuilder::new().effect(Effect::Mica).build())
    .map_err(|error| error.to_string())?;

window.set_effects(None).map_err(|error| error.to_string())?;
```

Tauri 2.12.7 的 Windows 相关变体包括：[cite:1][cite:2]

| Tauri `Effect` | 用途 |
| --- | --- |
| `Mica` | 跟随系统明暗偏好的 Mica |
| `MicaLight` / `MicaDark` | 明确指定亮色或暗色 Mica |
| `Tabbed` | 跟随系统明暗偏好的 Mica Alt |
| `TabbedLight` / `TabbedDark` | 明确指定亮色或暗色 Mica Alt |
| `Acrylic` | Windows 10/11 Acrylic |
| `Blur` | 旧系统 Blur 回退 |

高级 API 没有 `DWMSBT_AUTO` 对应的 `Effect::Auto`。Tauri 内部把上述效果交给 `window-vibrancy`，后者再按系统版本选择 DWM 或兼容 API。[cite:2][cite:3][cite:4]

当前 Tauri 源码中的 `set_effects()` 会通过 `run_on_main_thread` 调度到主线程。若在同一个切换流程里混用 `set_effects(None)` 和直接 DWM 调用，必须考虑排队顺序；否则后排队的清除或应用操作可能覆盖先执行的直接调用。[cite:10]

### 2.2 直接 DWM API

`DwmSetWindowAttribute()` 的原型接收窗口句柄、属性编号、值指针和值大小；成功返回 `S_OK`。[cite:6]

```rust
#[cfg(windows)]
fn set_system_backdrop(
    window: &tauri::WebviewWindow,
    backdrop: u32,
) -> Result<(), String> {
    use std::ffi::c_void;

    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            &backdrop as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };

    if result == 0 {
        Ok(())
    } else {
        Err(format!("DwmSetWindowAttribute 失败：HRESULT 0x{result:08X}"))
    }
}
```

调用时只传入已经校验的 `0–4`。不要把任意前端整数直接交给 FFI，也不要忽略 HRESULT。

## 3. 系统版本与回退策略

这里存在一个有意义的文档差异：微软公开文档把 `DWMWA_SYSTEMBACKDROP_TYPE` 和该枚举的最低客户端写为 **Windows 11 Build 22621**；Tauri 当前使用的 `window-vibrancy` 实现则从 **Build 22523** 开始使用属性 38。这与 22523 最初进入预览通道的历史相符，但若只支持正式公开文档基线，可以把阈值设为 22621。[cite:4][cite:5][cite:7]

为了与当前 Tauri 2.12.7 的实际行为一致，可采用下表：

| 系统构建号 | 可用路径 | 建议行为 |
| --- | --- | --- |
| `>= 22523` | `DWMWA_SYSTEMBACKDROP_TYPE = 38` | 直接写入 `0–4`，五种选项走同一路径，避免与排队的高级 API 混用 |
| `>= 22000` 且 `< 22523` | `DWMWA_MICA_EFFECT = 1029`（非公开稳定契约） | Mica 可用；Mica Alt 回退为 Mica；Acrylic 使用兼容 API |
| `>= 17763` 且 `< 22000` | `SetWindowCompositionAttribute`（非公开稳定契约） | Acrylic 可用；Mica/Mica Alt 回退为 Acrylic；`Auto` 也只能采用应用定义的回退 |
| `< 17763` | Blur 或无材质 | 根据可读性选择 Blur 或恢复 CSS 背景 |

`window-vibrancy` 对 Acrylic 的处理也是版本相关的：新系统使用 `DWMSBT_TRANSIENTWINDOW`，旧系统回退到 `SetWindowCompositionAttribute`；Mica 在新系统使用 `DWMSBT_MAINWINDOW`，旧 Windows 11 使用属性 1029。[cite:4]

回退选项应在产品文案中保持诚实：旧系统上的“自动”并不等于新系统的 `DWMSBT_AUTO`，旧系统上的 Mica Alt 也不具备真正的 Mica Alt 视觉效果。

## 4. 让材质真正可见的前端条件

Tauri 官方和 `window-vibrancy` 示例都要求窗口开启透明，并明确提示 `html, body { background: transparent; }`。[cite:1][cite:3]

```jsonc
{
  "app": {
    "windows": [{
      "label": "main",
      "transparent": true,
      "decorations": false
    }]
  }
}
```

```css
html,
body {
  background: transparent;
}

/* 无系统材质时，保留应用原有主题。 */
.app {
  background: var(--app-bg);
}

/* 有系统材质时，整窗容器不能再覆盖背景。 */
:root[data-window-material]:not([data-window-material="none"]) .app {
  background: transparent;
}
```

以下结构都会让“DWM 数值正确但视觉不对”：

- `html` 或 `body` 使用不透明背景。
- `.app` 等全尺寸容器继续使用主题渐变。
- 在原生材质之上再铺一层高不透明度的全窗蒙层。
- 使用全屏背景图或装饰图覆盖窗口。
- 在透明窗口配置未生效时直接调用材质 API。

这并不意味着所有控件都必须透明。标题按钮、设置卡片、代码块等局部表面仍可保留主题色和适当的半透明背景；需要移除的是**覆盖整个窗口的底层**。同时应保持文字对比度，避免为了显示材质而牺牲可读性。

### 4.1 同步原生窗口明暗

CSS 的 `color-scheme` 只影响 Web 内容，不会把应用主题的明暗传给 DWM。如果应用允许独立选择浅色或深色主题，应在支持该属性的系统上同时设置 `DWMWA_USE_IMMERSIVE_DARK_MODE = 20`：浅色主题为 `0`，深色主题为 `1`，再设置系统背景类型。[cite:7]

```text
读取当前主题 colorScheme
  ├─ light → DWMWA_USE_IMMERSIVE_DARK_MODE = 0
  └─ dark  → DWMWA_USE_IMMERSIVE_DARK_MODE = 1

随后写入 DWMWA_SYSTEMBACKDROP_TYPE
```

启动、切换材质和切换主题时都要保持这两个原生属性与前端主题一致。否则即使属性 38 和透明 DOM 都正确，也可能出现“暗色 Mica + 浅色主题的深色文字”这种数值正确但实际不可用的情况。

### 4.2 原生阴影与圆角

无边框透明窗口不能只依赖 `.app { box-shadow: ... }`：元素铺满 WebView 时，阴影会被窗口边缘裁掉。应启用 Tauri 的 `shadow: true`，由 DWM 在窗口外绘制阴影。

Windows 11 还应设置 `DWMWA_WINDOW_CORNER_PREFERENCE = 33` 为 `DWMWCP_ROUND = 2`，让 DWM 材质、窗口边框和阴影共用原生圆角边界。[cite:7] WebView 内容再使用与系统圆角匹配的 `8px` CSS 半径裁剪局部内容。只设置 CSS 圆角时，透明角落后的 DWM 系统背景仍可能呈矩形，无法单独解决材质窗口的圆角问题。

## 5. 推荐的切换流程

### 新系统：统一直接调用 DWM

```text
读取并校验材质 ID
  ├─ none    → 写 1，前端恢复 --app-bg
  ├─ auto    → 写 0，前端整窗透明
  ├─ mica    → 写 2，前端整窗透明
  ├─ acrylic → 写 3，前端整窗透明
  └─ micaAlt → 写 4，前端整窗透明
```

新系统不再先调用一次 `set_effects(None)`，也不为 Mica/Acrylic/Mica Alt 再调用 `set_effects()`。这样五个选项只有一条同步 DWM 写入路径，避免直接 FFI 与主线程队列交错。

### 旧系统：统一使用高级 API

旧系统的每次切换只使用 `set_effects()`：`None` 表示清除，其他选项映射到可用的 `Effect`。不要在同一次切换中再直接写属性 38 或 1029。

### 启动与设置保存

1. 启动时读取并规范化保存的材质 ID，读取当前主题的 `colorScheme`，同步原生明暗后应用材质。
2. 前端启动完成后根据同一设置写入 `data-window-material`，确保 CSS 与原生状态一致。
3. 修改材质或主题时先应用原生状态，成功后再持久化并更新前端状态；失败时保留旧设置并显示错误。
4. 只有材质或主题实际变化时才调用原生 API；目录、笔记等无关设置不应重复切换材质。

## 6. 验证方法

### 6.1 验证 DWM 属性

通过 `DwmGetWindowAttribute(hwnd, 38, ...)` 读取四字节整数，应分别得到 `0、1、2、3、4`。属性读取失败时必须记录 HRESULT，不能把默认值 0 当成 `Auto` 已成功。[cite:5][cite:6]

### 6.2 验证真实视觉

- 检查计算样式：材质非 `none` 时，`html`、`body`、`.app` 的背景都应为透明。
- 分别截取笔记页和设置页，确认没有全屏图片或蒙层遮挡。
- Mica 与 Mica Alt 应是系统色调的不透明材质，不应期待实时看到后方窗口。
- Acrylic 应在窗口激活且系统允许透明效果时检查，并同时测试失活状态。
- 在亮色、暗色和不同桌面壁纸下检查文字对比度。
- 重启应用后同时核对 DWM 属性、持久化设置和 CSS 状态。
- 在 Windows 10、初版 Windows 11 和当前 Windows 11 上分别验证回退；单一新系统不能证明旧系统路径正确。

## 7. 当前项目应采用的最小修正

1. 删除窗口背景图选择、透明度及其图片层，不再用图片模拟或覆盖系统材质。
2. 新系统把五种材质统一为直接 DWM 属性写入；旧系统保留 Tauri `Effect` 回退。
3. 材质非 `none` 时，把 `.app` 的全窗背景改为 `transparent`，删除整窗 `--material-veil` 蒙层。
4. `none` 时恢复原有主题渐变，保持未启用材质用户的外观不变。
5. 保留主题、卡片和代码块等局部样式，不额外引入材质透明度滑块；Mica/Acrylic 的最终透明表现交由系统控制。
6. 启动、切换材质和切换主题时，根据主题的 `colorScheme` 同步属性 20，避免系统暗色与应用浅色主题冲突。
7. 启用 DWM 原生阴影，并在 Windows 11 设置属性 33 为圆角；CSS 只负责匹配的内容裁剪，不再承担整窗阴影。

## Sources

- <a id="cite-1"></a>[cite:1] [Tauri Window JavaScript API：Effect 与 setEffects](https://tauri.app/reference/javascript/api/namespacewindow/)
- <a id="cite-2"></a>[cite:2] [Tauri 2.12.7 Rust API：Effect](https://docs.rs/tauri/2.12.7/tauri/window/enum.Effect.html)
- <a id="cite-3"></a>[cite:3] [tauri-apps/window-vibrancy：README、Tauri 透明窗口要求与平台说明](https://github.com/tauri-apps/window-vibrancy)
- <a id="cite-4"></a>[cite:4] [window-vibrancy：Windows 实现源码](https://raw.githubusercontent.com/tauri-apps/window-vibrancy/dev/src/windows.rs)
- <a id="cite-5"></a>[cite:5] [Microsoft Learn：DWM_SYSTEMBACKDROP_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type)
- <a id="cite-6"></a>[cite:6] [Microsoft Learn：DwmSetWindowAttribute](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmsetwindowattribute)
- <a id="cite-7"></a>[cite:7] [Microsoft Learn：DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)
- <a id="cite-8"></a>[cite:8] [Microsoft Learn：Mica material](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
- <a id="cite-9"></a>[cite:9] [Microsoft Learn：Acrylic material](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
- <a id="cite-10"></a>[cite:10] [Tauri 2.12.7：Window 实现源码](https://docs.rs/tauri/2.12.7/src/tauri/window/mod.rs.html)
