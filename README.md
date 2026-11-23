# 小便签 notepaper

一个使用 **Tauri 2 + Rust** 编写的桌面小便签。无边框粉色渐变窗口，支持待办清单、Markdown 笔记、截图粘贴、可自定义存储位置，数据完全保存在本地。

## 功能特性

- **待办 / 笔记双 Tab**：轻量待办清单与 Markdown 笔记共存
- **Markdown 实时预览**：粗体、斜体、删除线、标题、行内代码、代码块、引用、表格、列表、任务列表、链接、图片、分隔线
- **代码块渲染**：围栏代码块带语言标签、一键复制与轻量语法高亮（JS/TS、Python、Rust、Java、Go、C/C++、C#、HTML/XML、CSS、Shell、SQL、JSON 等）
- **可编辑主题**：粉樱、暗夜、薄荷、素纸四套主题保存在数据目录的 `themes/*.json`，支持自定义 CSS 变量及单独导入导出
- **截图粘贴**：在编辑区按 `Ctrl+V`，剪贴板截图自动落盘，并以**相对路径**（`images/xxx.png`）插入 Markdown
- **HTML 粘贴转 Markdown**：从浏览器/Office 复制富文本，粘贴时自动转换为标题、列表、加粗、链接、表格、引用等 Markdown 语法
- **文件拖拽**：把图片或任意文件拖进窗口，自动插入绝对路径（图片会直接以 Markdown 图片渲染）
- **数据备份**：设置中一键导出/导入 zip 备份，包含 `data.json`、主题与数据目录内的图片，可整体迁移到另一台电脑
- **多笔记管理**：新建、切换、删除，标题即笔记名
- **自动保存**：输入后 450ms 防抖写入本地 JSON，`Ctrl+S` 立即保存
- **存储位置可配置**：数据目录、图片目录均可在设置中更改，切换数据目录时自动迁移已有数据
- **窗口置顶**：标题栏一键置顶，可设置启动时自动置顶
- **窗口状态记忆**：正常关闭时记录窗口位置和大小，下次启动自动恢复
- **Windows 窗口材质**：支持自动、无、Mica、Acrylic、Mica Alt，旧系统自动回退，原生明暗随主题同步
- **无边框圆角窗口**：DWM 原生阴影 + Windows 11 原生圆角，拖动标题栏移动，支持缩放、最小化、关闭
- **完全离线**：无网络请求，无云同步，数据只在本机

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面容器 | Tauri 2.12 |
| 后端 | Rust 1.92（MSVC toolchain） |
| 渲染引擎 | WebView2（Windows 10/11 自带） |
| 前端 | 原生 HTML / CSS / JavaScript，无框架、无打包器 |
| Markdown | 手写轻量解析器（`src/main.js`） |
| 存储 | 本地 JSON 文件（原子写入） |

## 快速开始

环境要求：Rust（MSVC toolchain）、Node.js 18+、WebView2 运行时（Windows 11 自带）。

```powershell
npm install
npm run dev
```

## 打包安装程序

```powershell
npm run build
```

产物位于：

- `src-tauri/target/release/bundle/nsis/notepaper_0.2.0_x64-setup.exe`（NSIS 安装包，推荐）
- `src-tauri/target/release/bundle/msi/notepaper_0.2.0_x64_en-US.msi`（MSI 安装包）
- `src-tauri/target/release/notepaper.exe`（免安装可执行文件）

安装包未做代码签名，首次安装时 Windows SmartScreen 可能提示"未知发布者"，点"更多信息 → 仍要运行"即可。

## 数据与设置

| 内容 | 默认位置 |
| --- | --- |
| 应用设置 | `%APPDATA%\com.notepaper.sticky\settings.json` |
| 窗口位置与大小 | `%APPDATA%\com.notepaper.sticky\window.json` |
| 笔记与待办 | `%APPDATA%\com.notepaper.sticky\data.json` |
| 粘贴的截图 | `%APPDATA%\com.notepaper.sticky\images\` |
| 主题 | `%APPDATA%\com.notepaper.sticky\themes\*.json` |

在应用右上角齿轮进入设置：

- **主题**：粉樱（默认）、暗夜、薄荷、素纸。主题 JSON 可直接编辑，也可单独导入导出；变量同时控制整窗配色、控件样式、字体与 Markdown 预览，详见 [自定义主题](docs/THEMES.md)
- **窗口材质**：选择自动、无、Mica、Acrylic 或 Mica Alt；系统直接绘制原生背景，不使用背景图片，详见 [Windows 窗口材质](docs/WINDOW_MATERIALS.md)
- **数据存储位置**：选择任意可写目录。切换时会迁移已有 `data.json` 和主题文件（不覆盖目标已有文件），并把当前内容写入新位置
- **图片存储位置**：截图可以保存到任意磁盘目录；保存在数据目录内时，Markdown 中使用 `images/xxx.png` 这样的相对路径；目录在数据目录外时退化为绝对路径
- **数据备份**：导出 zip（`data.json` + `themes/**` + 数据目录内的图片 + `manifest.json`），导入时覆盖当前数据并自动保留 `data.json.bak`
- **启动时窗口置顶**：保存到 `settings.json`，下次启动自动应用
- **恢复默认路径**：清空自定义目录，回到应用数据目录

图片在 Markdown 中的写法：

```markdown
![](images/img_1795453005952.png)   <!-- 数据目录内的截图，相对路径，可随备份迁移 -->
![](D:\Pictures\shot.png)           <!-- 拖拽进来的外部图片，绝对路径 -->
```

旧版本保存的 `asset.localhost` 图片链接会在启动时自动改写为相对路径。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 保存 | `Ctrl+S` |
| 粘贴截图 | `Ctrl+V`（笔记页） |
| 粘贴富文本 | `Ctrl+V`（自动 HTML → Markdown） |
| 拖拽文件 | 拖入窗口（自动插入绝对路径） |
| 开始编辑 | 双击正文 / 点击铅笔按钮 |
| 退出编辑 | `Esc` |
| 标题进入正文编辑 | 标题输入框内 `Enter` |
| 添加待办 | 输入框内 `Enter` |

## Markdown 语法

| 语法 | 效果 |
| --- | --- |
| `**粗体**` | **粗体** |
| `*斜体*` | *斜体* |
| `~~删除线~~` | ~~删除线~~ |
| `# 标题` | 一级标题（支持 1–6 级） |
| `` `行内代码` `` | 行内代码 |
| ` ```js ... ``` ` | 代码块，按语言高亮并支持一键复制 |
| `> 引用` | 引用块 |
| `\| 表格 \|` | 表格 |
| `- 列表` / `1. 列表` | 无序 / 有序列表 |
| `- [x] 任务` | 任务列表 |
| `[文本](链接)` | 链接 |
| `![描述](路径)` | 图片 |
| `---` | 分隔线 |

## 目录结构

```
notepaper/
├─ src/                     # 前端（由 Tauri 直接加载，无构建步骤）
│  ├─ index.html
│  ├─ styles.css
│  └─ main.js               # 状态、Markdown 解析、设置、截图粘贴
├─ src-tauri/
│  ├─ src/lib.rs            # Rust 后端：存储、设置、主题、目录选择、图片协议
│  ├─ src/themes/           # 首次启动写入数据目录的内置主题 JSON
│  ├─ src/main.rs
│  ├─ capabilities/default.json
│  ├─ icons/
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ docs/TECHNICAL.md        # 技术设计文档
├─ docs/THEMES.md           # 自定义主题与可编辑变量说明
├─ docs/WINDOW_MATERIALS.md # Tauri Windows 材质调研与实现说明
├─ docs/DEBUGGING.md        # CDP、DWM、真实截图与持久化调试手册
├─ package.json
└─ README.md
```

## 已知限制

- 安装包未签名，未做自动更新
- 单窗口应用，暂不支持多窗口 / 多标签页
- 截图以 base64 字符串经 IPC 传给 Rust，超大图片会带来一定内存与延迟开销
- 图片目录设置在数据目录之外时，图片使用绝对路径，**不会**被打进备份包
- 自定义图片协议不做路径白名单，属于本地单机应用的取舍，详见 [技术设计文档](docs/TECHNICAL.md)
- 自定义协议地址在 Windows 上为 `http://notepaper.localhost/`，macOS/Linux 上为 `notepaper://localhost/`

## 更多文档

架构、数据模型、IPC 命令、构建细节等见 [docs/TECHNICAL.md](docs/TECHNICAL.md)；主题 JSON 格式与变量说明见 [docs/THEMES.md](docs/THEMES.md)；DWM 材质原理与版本回退见 [docs/WINDOW_MATERIALS.md](docs/WINDOW_MATERIALS.md)；CDP、DWM、真实截图和持久化排查方法见 [docs/DEBUGGING.md](docs/DEBUGGING.md)。
