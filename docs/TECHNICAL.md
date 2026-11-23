# 小便签 · 技术设计文档

本文档描述 `notepaper` 的实现细节：进程与模块划分、数据模型、存储路径策略、IPC 命令、自定义图片协议、前端渲染与打包流程。面向需要继续维护或二次开发的开发者。

## 1. 概览

- 应用类型：Tauri 2 桌面应用，单窗口，Windows 为首要目标平台
- 后端：Rust，负责文件存储、设置与主题解析、目录选择、打开目录、图片本地协议
- 前端：原生 HTML/CSS/JavaScript，由 Tauri 直接加载 `src/` 目录，无前端构建步骤
- 通信：`window.__TAURI__.core.invoke`（`app.withGlobalTauri = true`）
- 持久化：本地 JSON 文件，原子写入（临时文件 + rename）
- 网络：运行期无任何网络请求

### 版本基线

| 组件 | 版本 |
| --- | --- |
| Tauri / tauri-build | 2.x（构建时实际为 2.12.7 / 2.7.6） |
| Rust | 1.92 |
| WebView2 | 跟随系统 |
| 前端依赖 | 无（仅 `@tauri-apps/cli` 作为开发依赖） |
| Rust 依赖 | `tauri`、`serde`、`serde_json`、`base64`、`percent-encoding`、`rfd` |

## 2. 目录结构

```
notepaper/
├─ src/                         前端静态资源（frontendDist）
│  ├─ index.html                页面结构：标题栏 / Tab / 笔记 / 待办 / 设置面板
│  ├─ styles.css                全部样式（无预处理器）
│  └─ main.js                   应用全部前端逻辑
├─ src-tauri/
│  ├─ src/main.rs               入口，调用 notepaper_lib::run()
│  ├─ src/lib.rs                命令、设置、主题、存储、图片协议
│  ├─ src/themes/*.json         内置主题源，首次启动写入数据目录
│  ├─ capabilities/default.json 窗口权限
│  ├─ icons/                    由 `tauri icon` 生成的各平台图标
│  ├─ Cargo.toml
│  ├─ build.rs
│  └─ tauri.conf.json           窗口、打包、asset 协议配置
├─ docs/TECHNICAL.md
├─ docs/THEMES.md               自定义主题格式与变量说明
├─ package.json                 仅封装 tauri CLI 命令
└─ README.md
```

## 3. 进程与数据流

```
┌────────────────────────────── WebView2 ──────────────────────────────┐
│ index.html + styles.css + main.js                                    │
│   ├─ state { notes, todos, activeNote, settings, themes }            │
│   ├─ Markdown 解析 / 预览渲染                                        │
│   ├─ 输入事件 ─► 防抖 450ms ─► invoke("save_store")                   │
│   └─ 设置面板 ─► invoke("update_settings" / "pick_folder" ...)        │
└───────────────▲──────────────────────────────┬───────────────────────┘
                │ invoke / 自定义协议响应        │
┌───────────────┴──────────────────────────────▼───────────────────────┐
│ Rust (Tauri Core)                                                    │
│   ├─ 读取/写入 settings.json、data.json                               │
│   ├─ rfd 原生目录选择、explorer 打开目录                              │
│   └─ notepaper:// 协议：按绝对路径读取图片并返回字节                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 截图粘贴完整链路

1. 用户在编辑区按 `Ctrl+V`，`paste` 事件中从 `clipboardData.items` 找到 `image/*`
2. `FileReader` 将图片转为 base64（去掉 data URL 前缀）
3. `invoke("save_image", { data })`：Rust 解码并写入图片目录，返回 `{ path, relative }`
4. 图片在数据目录内时，前端把 `relative`（如 `images/img_1.png`）写入 Markdown；否则退化为绝对路径
5. 渲染时 `imageSrc()` 把相对路径拼到当前数据目录，生成 `http://notepaper.localhost/<encodeURIComponent(绝对路径)>`
6. `<img>` 请求该地址，Rust 协议处理器百分号解码路径、读取文件、按扩展名设置 Content-Type 返回

### 其他输入方式

- **拖拽文件**：监听 `getCurrentWebview().onDragDropEvent()`；`drop` 时图片扩展名插入 `![](绝对路径)`，其他文件插入绝对路径文本
- **粘贴 HTML**：`paste` 事件中若剪贴板带 `text/html`，用 `DOMParser` 解析后转换为 Markdown（标题、段落、加粗/斜体/删除线、链接、图片、引用、列表、表格、代码块），再插入编辑器
- **数据备份**：设置页导出 zip（`data.json` + `manifest.json` + `themes/**` + `images/**` + 笔记引用的相对图片），导入时解压回数据目录

## 4. 数据模型

位置：`<数据目录>/data.json`。字段统一使用 camelCase（Rust 端 `#[serde(rename_all = "camelCase")]`）。

```jsonc
{
  "notes": [
    {
      "id": "mwth4ibgyil5j",          // 时间戳36进制 + 随机串
      "title": "未命名笔记",
      "content": "Markdown 源码",
      "updatedAt": 1795450927804      // Unix 毫秒
    }
  ],
  "todos": [
    {
      "id": "mwth4j2xabcde",
      "text": "买牛奶",
      "done": false,
      "createdAt": 1795450927804
    }
  ],
  "activeNote": "mwth4ibgyil5j"       // 上次打开的笔记 id
}
```

设置文件：`%APPDATA%\com.notepaper.sticky\settings.json`

```jsonc
{
  "dataDir": "",        // 空字符串 = 使用默认应用数据目录
  "imagesDir": "",      // 空字符串 = <数据目录>/images
  "alwaysOnTop": false,
  "theme": "sakura"     // 当前主题 ID；空值按 sakura 处理
}
```

默认数据目录由 Tauri `app_data_dir()` 解析，Windows 下为 `%APPDATA%\<identifier>`，即 `%APPDATA%\com.notepaper.sticky`。

## 5. 存储路径策略

解析规则（`resolve_settings`）：

```text
data_dir   = settings.dataDir 为空 ? app_data_dir() : PathBuf(settings.dataDir)
images_dir = settings.imagesDir 为空 ? data_dir/images : PathBuf(settings.imagesDir)
theme      = settings.theme 为空 ? "sakura" : settings.theme.trim()
```

- **默认值语义**：设置中保存空字符串表示"跟随默认"，因此数据目录变化时，默认图片目录会自动跟随
- **切换数据目录**：
  1. 创建新目录并写入探针文件 `.notepaper-write-test` 验证可写，失败则整体回滚（不写 settings.json）
  2. 若旧目录存在 `data.json` 且新目录没有，则复制过去（不覆盖）
  3. 复制旧目录 `themes/*.json`，不覆盖新目录已有主题，并补齐缺失内置主题
  4. 写入 `settings.json`
  5. 前端收到成功后，把内存中的最新状态 `save_store` 写入新目录，并重新加载主题
- **切换图片目录**：只影响后续新截图。笔记中已存的图片使用绝对 URL，旧图不受影响
- **恢复默认路径**：前端发送空目录，Rust 解析回默认位置；随后前端把当前内容写入默认目录

## 6. IPC 命令

全部命令在 `src-tauri/src/lib.rs` 中定义，通过 `tauri::generate_handler!` 注册。

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `get_settings` | — | `ResolvedSettings` | 读取设置并返回解析后的绝对路径，同时确保目录存在 |
| `update_settings` | `settings: Settings` | `ResolvedSettings` | 校验目录可写、迁移 data.json 与主题、写 settings.json |
| `list_themes` | — | `ThemeDefinition[]` | 确保内置主题存在，读取并校验数据目录 `themes/*.json` |
| `export_theme` | `id: string, target: string` | `string` | 将当前数据目录中的指定主题导出为 JSON |
| `import_theme` | `source: string` | `ThemeDefinition` | 校验并导入 JSON 到 `themes/<id>.json` |
| `pick_theme_target` | `defaultName: string` | `string \| null` | 主题 JSON 保存对话框 |
| `pick_theme_file` | — | `string \| null` | 主题 JSON 打开对话框 |
| `pick_folder` | — | `string \| null` | 调用 rfd 原生目录选择框 |
| `open_folder` | `path: string` | `void` | Windows 用 explorer，macOS 用 open，Linux 用 xdg-open |
| `load_store` | — | `Store` | 从当前数据目录读取 data.json；不存在时返回空 Store |
| `save_store` | `store: Store` | `void` | 原子写入 `<数据目录>/data.json` |
| `save_image` | `data: string`（base64） | `SavedImage` | 写入图片目录，返回 `{ path, relative }`；`relative` 为相对数据目录的路径 |
| `export_backup` | `target: string` | `string` | 打包 data.json、manifest、themes、images 及引用的相对图片为 zip |
| `import_backup` | `source: string` | `number` | 校验 data.json 后解压回数据目录，返回文件数；原数据保留为 `data.json.bak` |
| `pick_backup_target` | `defaultName: string` | `string \| null` | 保存对话框（zip） |
| `pick_backup_file` | — | `string \| null` | 打开对话框（zip） |

补丁：`save_image` 的返回由字符串改为 `SavedImage`：

```ts
interface SavedImage {
  path: string;          // 绝对路径
  relative: string | null; // 相对数据目录的路径；不在数据目录内时为 null
}
```

`ResolvedSettings` 是只读视图：

```ts
interface ResolvedSettings {
  dataDir: string;
  imagesDir: string;
  alwaysOnTop: boolean;
  theme: string;   // 当前主题 ID，内置或自定义
}
```

前端以 `invoke("update_settings", { settings: {...} })` 调用；参数与 Rust 结构体字段同名，Tauri 会自动做反序列化。

## 7. 窗口与权限

`tauri.conf.json` 关键配置：

```jsonc
{
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "label": "main",
      "width": 380, "height": 620,
      "minWidth": 320, "minHeight": 460,
      "decorations": false,
      "transparent": true,
      "shadow": false,
      "resizable": true,
      "center": true
    }],
    "security": {
      "csp": null,
      "assetProtocol": { "enable": true, "scope": ["$APPDATA/**"] }
    }
  }
}
```

`capabilities/default.json` 授予主窗口：

- `core:default`
- `core:window:allow-start-dragging`（标题栏 `data-tauri-drag-region` 拖动）
- `core:window:allow-close`
- `core:window:allow-minimize`
- `core:window:allow-set-always-on-top`

圆角与透明：窗口本身是矩形透明区域，视觉圆角由 `.app { border-radius: 18px; overflow: hidden; }` 完成。

## 8. 自定义图片协议

`lib.rs` 中注册：

```rust
.register_uri_scheme_protocol("notepaper", |_ctx, request| serve_local_file(request))
```

- 地址形式：Windows 为 `http://notepaper.localhost/<encoded-absolute-path>`；macOS/Linux 为 `notepaper://localhost/<encoded-absolute-path>`
- Markdown 中的相对图片路径（如 `images/img_1.png`）由前端拼上当前数据目录后再编码请求；绝对路径（拖拽插入）直接编码
- 前端 `toImageUrl()` 根据 `navigator.userAgent` 选择协议头，并用 `encodeURIComponent` 编码把 `\` 换成 `/` 的路径
- Rust 侧 `percent_decode_str` 解码 → `fs::read` → 按扩展名返回 `Content-Type`，附加 `Access-Control-Allow-Origin: *`、`Cache-Control: no-cache`
- 读取失败返回 404

**为什么不用 asset 协议**：asset 协议的 scope 只能限定在固定路径变量下，用户把图片目录设置到任意磁盘（如 `D:\Notes\img`）时会被拦截。自定义协议直接按绝对路径读文件，支持任意目录。`tauri.conf.json` 中仍保留 asset 协议（scope 仅 `$APPDATA/**`），用于兼容早期版本已写入的 `asset.localhost` 图片链接。

**安全说明**：自定义协议不做路径白名单，理论上 WebView 内任何脚本都能读取本机可读文件。当前应用不加载远程内容、Markdown 渲染会先转义 HTML、不使用 `innerHTML` 渲染用户输入以外的内容，风险面较小；若未来支持外部 Markdown 导入或远程内容，应增加目录白名单。

## 9. 前端实现

### 9.1 状态与渲染

单一内存状态对象：

```js
state = { notes, todos, activeNote, settings }
```

渲染入口：

- `renderNote()`：当前笔记的标题、Markdown 预览、编辑器内容、更新时间、字数
- `renderNoteList()`：笔记切换抽屉
- `renderTodos()`：待办列表与进度
- `renderSettings()`：设置面板路径、置顶开关与主题选中态

所有列表型 DOM 均通过 `createElement` + `textContent` 构建，避免把用户输入拼进 HTML；只有 Markdown 渲染结果使用 `innerHTML`。

### 9.2 Markdown 解析器

位于 `main.js`，无第三方依赖，分两层：

1. **块级解析** `mdToHtml()`：按行扫描，依次识别
   - 围栏代码块 ` ```lang `：交给 `renderCodeBlock()` 输出语言标签、复制按钮与高亮后的代码
   - `#` ~ `######` 标题
   - `---` / `***` / `___` 分隔线
   - 表格（表头 + 分隔行 + 数据行）
   - `>` 引用（递归解析内部内容）
   - 无序 / 有序列表、任务列表 `- [ ]` / `- [x]`
   - 其余连续行为段落（换行渲染为 `<br/>`）
2. **行内解析** `renderInline()`：
   - 先抽出 `` `行内代码` `` 为占位符，避免其中内容被后续规则改写
   - 对全文 HTML 转义
   - 依次处理图片、链接、`**粗体**` / `__粗体__`、`*斜体*`、`~~删除线~~`
   - 最后回填代码占位符

不支持的语法（嵌套列表、HTML 内嵌、脚注等）按普通文本处理。

### 9.3 编辑与预览

- 默认显示预览，双击正文或点铅笔按钮进入编辑
- 编辑态与预览态通过 `.hidden` 互斥，共用同一 `note.content`
- 退出编辑时重新渲染预览；`Esc` 退出
- 预览中的链接点击被拦截，避免 WebView 跳离应用

### 9.4 自动保存

- 任何内容变更调用 `scheduleSave()`：清除旧定时器，450ms 后执行
- `pending` 标记是否有未落盘修改；`saveNow()` 只在 `pending` 时调用 `save_store`
- `beforeunload` 再强制提交一次
- 切换数据目录后，前端主动把当前内存状态写入新位置，避免"只迁移了旧文件"的丢失

### 9.5 设置面板

- 标题栏齿轮打开，覆盖在 Tab 下方内容区（`.settings-pane` 绝对定位）
- 目录选择：`pick_folder` → `update_settings` → 若成功则 `saveNow()` 并提示
- 打开目录：`open_folder({ path })`
- 置顶开关与标题栏图钉共用 `applyAlwaysOnTop()`，并持久化 `alwaysOnTop`
- 主题项点击后立即调用 `applyTheme()` 并 `updateSettings({ theme })` 持久化，选中态由 `renderSettings()` 维护
- 启动时 Rust `setup` 读取 settings，若 `alwaysOnTop` 为真则直接置顶；前端启动后再同步按钮状态

### 9.6 相对路径与旧数据迁移

- `save_image` 返回的 `relative` 只在该图片位于数据目录内时存在
- 渲染前 `imageSrc()`：相对路径 → `数据目录 + "/" + 相对路径` → 自定义协议 URL
- 启动时 `migrateImageRefs()` 扫描笔记内容中的 `![](url)`，把 `asset.localhost` / `notepaper.localhost` / `file://` 指向数据目录内的图片改写为相对路径，并静默保存
- 图片目录设在数据目录外时保存绝对路径，这类图片不进入备份

### 9.7 备份格式

```
notepaper-backup-YYYY-MM-DD.zip
├─ manifest.json        # app / version / exportedAt
├─ data.json            # 完整 Store
└─ images/xxx.png       # 数据目录内图片及笔记引用的相对图片
```

- 导出前读取 `data.json` 并解析为 `Store`，扫描所有 `](...)` 引用，收集相对图片
- 导入分两遍：先读取并校验 `data.json` 可反序列化为 `Store`，通过后再解压所有条目；解压前把旧 `data.json` 复制为 `data.json.bak`
- 使用 `zip::ZipArchive::enclosed_name()` 防止路径穿越，总解压体积上限 1GB
- 导入完成后前端调用 `load_store` 重新加载内存状态并渲染

### 9.8 HTML 与拖拽细节

- HTML 转换是自研的 `htmlToMarkdown()`：块级元素映射为段落/标题/列表/引用/表格，`span` 的 `font-weight`、`font-style`、`line-through` 样式映射为粗体/斜体/删除线
- 拖拽通过 Tauri 原生 `onDragDropEvent` 实现，HTML5 `drop` 事件被 WebView2 拦截，因此不使用 `dataTransfer.files`
- 图片扩展名正则 `\.(png|jpe?g|gif|webp|bmp|svg)$` 判定是否包成 Markdown 图片

### 9.9 主题系统

主题由数据目录 JSON 与白名单 CSS 变量驱动，不引入图标字体或远程资源：

- 内置 JSON 通过 `include_str!` 编译进程序；`get_settings()` / `list_themes()` 调用 `ensure_builtin_themes()`，仅在 `<数据目录>/themes/<id>.json` 缺失时写入，因此不会覆盖用户修改
- `list_themes()` 校验所有主题，要求文件名与 ID 一致，并标记 `builtin`；内置主题优先，其余按名称排序
- `validate_theme()` 限制 ID、名称、`colorScheme`、文件大小、变量名和变量值；前后端各有一份 `THEME_VARIABLES` 白名单。变量值拒绝外部 URL、脚本、CSS 声明分隔符等内容
- `loadThemes()` 通过 IPC 获取主题；读取失败时回退到 `FALLBACK_THEMES`，即 `styles.css` 中的四套 CSS 主题
- `applyTheme()` 先移除根元素上的旧内联变量，再用 `style.setProperty()` 写入当前 JSON 变量，同时设置 `documentElement.dataset.theme` 与 `style.colorScheme`。未覆盖的自定义变量继承 `:root` 粉樱默认值，CSS 同名主题则作为读取失败时的回退
- 变量分三类：界面配色、字体（`--ui-font` / `--preview-font` / `--mono-font`）、代码块与 `--token-*` 高亮色
- 设置页用 `createElement` / `textContent` 动态生成主题按钮，并在 `#themeList` 上使用点击事件委托；选择后 `updateSettings({ theme })` 只持久化主题 ID 到 `settings.json`
- `export_theme` / `import_theme` 支持单文件迁移；数据备份包含整个 `themes/**`。切换数据目录、导入备份和重新打开设置页时都会重新加载主题
- 完整 JSON 格式与可编辑变量见 `docs/THEMES.md`

### 9.10 代码块渲染与高亮

围栏代码块不再直接输出 `<pre><code>`，而是输出：

```html
<div class="code-block">
  <div class="code-head"><span class="code-lang">JavaScript</span><button class="code-copy" data-copy>复制</button></div>
  <pre><code class="language-js">…高亮后的 HTML…</code></pre>
</div>
```

- 语言标识经 `CODE_LANG_LABEL` 映射为展示名；未知语言回退为大写标识
- 高亮为自研轻量分词器，按语言分派：
  - `html` / `xml` / `svg` / `vue`：注释、标签名、属性名、属性值
  - `css` / `scss` / `less`：注释、字符串、属性名、数值与颜色
  - 其余：注释（`//`、`/* */`，Python/Shell 等用 `#`，SQL 用 `--`）、字符串、数字、布尔/空值、函数调用、关键字
- 分词时未命中的片段先 `escapeHtml()`，再包 `<span class="tok-*">`，因此不会把用户代码当作 HTML 执行
- 复制按钮通过 `#preview` 的事件委托处理：优先 `navigator.clipboard.writeText()`，失败时回退到临时 `textarea` + `document.execCommand("copy")`，成功后按钮短暂显示“已复制”
- 双击预览进入编辑的监听会忽略复制按钮，避免误触

## 10. 构建与打包

```powershell
npm install      # 安装 @tauri-apps/cli
npm run dev      # tauri dev
npm run build    # tauri build
```

- `frontendDist` 指向 `../src`，因此没有 `devUrl`，Tauri 直接加载静态文件
- `bundle.targets = "all"`，Windows 下生成 NSIS（`.exe`）与 MSI；首次打包会下载 WiX / NSIS 工具链
- release profile 配置：`strip = true`、`lto = true`、`codegen-units = 1`
- 图标：`npx tauri icon <源图>` 生成 `src-tauri/icons/` 全套尺寸（含移动端，桌面打包仅使用 png/ico/icns）

产物：

```
src-tauri/target/release/bundle/nsis/notepaper_0.1.0_x64-setup.exe
src-tauri/target/release/bundle/msi/notepaper_0.1.0_x64_en-US.msi
src-tauri/target/release/notepaper.exe
```

## 11. 已知限制与后续方向

- 单窗口；如需多窗口需为每个窗口维护独立的 activeNote 与权限
- 未实现全文搜索、导出、云同步、自动更新
- 截图走 base64 IPC；大图（>10MB）会有明显序列化开销，可改为传临时文件路径
- 自定义协议无目录白名单（见第 8 节）
- 图片目录位于数据目录外时，图片为绝对路径且不进入备份包
- 备份为整包覆盖式导入，不做增量合并；导入前仅自动保留 `data.json.bak`
- Markdown 为自研子集，不支持 HTML 内嵌与复杂嵌套
- 无自动化测试；改动存储或解析逻辑后建议手动覆盖：新建/删除笔记、切换笔记、切换目录、粘贴截图、重启读取
