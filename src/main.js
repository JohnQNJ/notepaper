(function () {
  "use strict";

  const tauri = window.__TAURI__ || {};
  const invoke = tauri.core && tauri.core.invoke;
  const appWindow = tauri.window && tauri.window.getCurrentWindow ? tauri.window.getCurrentWindow() : null;

  // 图片通过 Rust 注册的 notepaper:// 协议按绝对路径读取，目录可以放在任意磁盘。
  const IMAGE_ORIGIN = /Windows/i.test(navigator.userAgent)
    ? "http://notepaper.localhost/"
    : "notepaper://localhost/";

  function toImageUrl(path) {
    return IMAGE_ORIGIN + encodeURIComponent(String(path).replace(/\\/g, "/"));
  }

  function isRelativeRef(value) {
    const url = String(value || "").trim();
    if (!url) return false;
    if (/^(https?:|data:|asset:|notepaper:|file:)/i.test(url)) return false;
    if (url.startsWith("//") || url.startsWith("\\\\") || url.startsWith("/")) return false;
    if (/^[a-zA-Z]:[\\/]/.test(url)) return false;
    return true;
  }

  function joinDataPath(relative) {
    const base = String(state.settings.dataDir || "").replace(/[\\/]+$/, "");
    const rest = String(relative || "").replace(/^[\\/]+/, "");
    if (!base) return rest;
    return base + "/" + rest;
  }

  /** 把历史版本保存的 asset/notepaper/file URL 还原成本地绝对路径。 */
  function decodeStoredPath(value) {
    let url = String(value || "").trim().replace(/^<|>$/g, "");
    try {
      url = decodeURIComponent(url);
    } catch (error) {
      // 保持原样
    }
    if (/^file:\/\//i.test(url)) {
      return url.replace(/^file:\/\//i, "").replace(/^\//, "").replace(/\//g, "\\");
    }
    const prefix = /^https?:\/\/(?:asset|notepaper)\.localhost\/|^notepaper:\/\/localhost\//i;
    if (prefix.test(url)) {
      return url.replace(prefix, "").replace(/\//g, "\\");
    }
    if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("\\\\")) return url;
    return null;
  }

  function relativeToDataDir(absolutePath) {
    const dataDir = String(state.settings.dataDir || "");
    if (!dataDir) return null;
    const normalize = (path) => String(path).replace(/\//g, "\\").replace(/\\+$/, "");
    const base = normalize(dataDir).toLowerCase();
    const full = normalize(absolutePath);
    if (!full.toLowerCase().startsWith(base + "\\")) return null;
    return full.slice(base.length + 1).replace(/\\/g, "/");
  }

  const $ = (selector) => document.querySelector(selector);

  const els = {
    tabs: document.querySelectorAll(".tab"),
    notePane: $("#notePane"),
    todoPane: $("#todoPane"),
    settingsPane: $("#settingsPane"),
    settingsMsg: $("#settingsMsg"),
    dataDirText: $("#dataDirText"),
    imagesDirText: $("#imagesDirText"),
    alwaysOnTopToggle: $("#alwaysOnTopToggle"),
    noteTitle: $("#noteTitle"),
    preview: $("#preview"),
    editor: $("#editor"),
    updatedAt: $("#updatedAt"),
    hint: $("#hint"),
    charCount: $("#charCount"),
    noteList: $("#noteList"),
    todoList: $("#todoList"),
    todoInput: $("#todoInput"),
    todoForm: $("#todoForm"),
    todoProgress: $("#todoProgress"),
    todoLeft: $("#todoLeft"),
  };

  const WELCOME = [
    "支持截图粘贴、Markdown 语法，**粗体**、~~删除线~~、*斜体*，还有 `行内代码`、引用与表格。",
    "",
    "# 标题",
    "",
    "```js",
    'System.out.print("hello world");',
    "```",
    "",
    "> 引用文本",
    "",
    "| 表格1 | 表格2 |",
    "| --- | --- |",
    "| 支持 | 编辑 |",
    "",
    "双击正文即可编辑，Ctrl+V 直接粘贴截图。",
  ].join("\n");

  const state = {
    notes: [],
    todos: [],
    activeNote: "",
    themes: [],
    settings: {
      dataDir: "",
      imagesDir: "",
      alwaysOnTop: false,
      theme: "sakura",
    },
  };

  let editing = false;
  let pinned = false;
  let saveTimer = 0;
  let hintTimer = 0;
  let activeTab = "note";

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => Date.now();

  function two(n) {
    return String(n).padStart(2, "0");
  }

  function formatTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return (
      d.getFullYear() +
      "-" +
      two(d.getMonth() + 1) +
      "-" +
      two(d.getDate()) +
      " " +
      two(d.getHours()) +
      ":" +
      two(d.getMinutes()) +
      ":" +
      two(d.getSeconds())
    );
  }

  function activeNote() {
    return state.notes.find((note) => note.id === state.activeNote) || null;
  }

  function newNote() {
    const note = { id: uid(), title: "", content: "", updatedAt: now() };
    state.notes.unshift(note);
    state.activeNote = note.id;
    scheduleSave();
    return note;
  }

  function ensureNotes() {
    if (!state.notes.length) {
      state.notes.push({
        id: uid(),
        title: "未命名笔记",
        content: WELCOME,
        updatedAt: now(),
      });
      state.activeNote = state.notes[0].id;
      pending = true;
      saveNow();
      return;
    }
    if (!state.notes.some((note) => note.id === state.activeNote)) {
      state.activeNote = state.notes[0].id;
    }
  }

  /* ---------------- Markdown ---------------- */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  /* ---------------- 代码高亮 ---------------- */

  const CODE_LANG_LABEL = {
    js: "JavaScript",
    javascript: "JavaScript",
    jsx: "JSX",
    ts: "TypeScript",
    typescript: "TypeScript",
    tsx: "TSX",
    json: "JSON",
    html: "HTML",
    xml: "XML",
    svg: "SVG",
    vue: "Vue",
    css: "CSS",
    scss: "SCSS",
    less: "Less",
    rs: "Rust",
    rust: "Rust",
    py: "Python",
    python: "Python",
    java: "Java",
    kt: "Kotlin",
    kotlin: "Kotlin",
    swift: "Swift",
    go: "Go",
    c: "C",
    h: "C",
    cpp: "C++",
    "c++": "C++",
    cc: "C++",
    cs: "C#",
    csharp: "C#",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    shell: "Shell",
    powershell: "PowerShell",
    ps1: "PowerShell",
    sql: "SQL",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    md: "Markdown",
    markdown: "Markdown",
    php: "PHP",
    rb: "Ruby",
    ruby: "Ruby",
    dart: "Dart",
    lua: "Lua",
    ini: "INI",
  };

  const CODE_KEYWORDS = new Set(
    (
      "function fn func def class struct impl interface extends implements import from export default " +
      "return if else elif for foreach while do switch case break continue new const let var static " +
      "public private protected async await yield try catch except finally throw throws raise with " +
      "in of as is not and or typeof instanceof void int long float double string bool boolean char " +
      "byte short self this super use mod mut pub crate where trait enum type package namespace " +
      "echo then fi done esac local set typedef sizeof delete virtual override abstract final sealed " +
      "readonly get set constructor lambda val object when match loop until"
    ).split(/\s+/)
  );

  const HASH_COMMENT_LANGS = new Set([
    "py",
    "python",
    "sh",
    "bash",
    "zsh",
    "shell",
    "powershell",
    "ps1",
    "yaml",
    "yml",
    "toml",
    "ini",
    "rb",
    "ruby",
    "r",
  ]);

  function normalizeLang(lang) {
    return String(lang || "")
      .trim()
      .toLowerCase()
      .replace(/^\./, "");
  }

  function highlightAttrs(source) {
    const re = /([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
    let out = "";
    let last = 0;
    let match;
    while ((match = re.exec(source))) {
      out += escapeHtml(source.slice(last, match.index));
      out += '<span class="tok-attr">' + escapeHtml(match[1]) + "</span>";
      out += escapeHtml(match[2]);
      out += '<span class="tok-string">' + escapeHtml(match[3]) + "</span>";
      last = re.lastIndex;
    }
    out += escapeHtml(source.slice(last));
    return out;
  }

  function highlightMarkup(code) {
    const re = /(<!--[\s\S]*?-->)|(<\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?>)/g;
    let out = "";
    let last = 0;
    let match;
    while ((match = re.exec(code))) {
      out += escapeHtml(code.slice(last, match.index));
      if (match[1]) {
        out += '<span class="tok-comment">' + escapeHtml(match[1]) + "</span>";
      } else {
        out += escapeHtml(match[2]);
        out += '<span class="tok-tag">' + escapeHtml(match[3]) + "</span>";
        out += highlightAttrs(match[4]);
        out += escapeHtml(match[5]);
      }
      last = re.lastIndex;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function highlightCss(code) {
    const re =
      /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([\w-]+)(?=\s*:)|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vw|vh|s|ms|deg)?\b)/g;
    let out = "";
    let last = 0;
    let match;
    while ((match = re.exec(code))) {
      out += escapeHtml(code.slice(last, match.index));
      if (match[1]) {
        out += '<span class="tok-comment">' + escapeHtml(match[1]) + "</span>";
      } else if (match[2]) {
        out += '<span class="tok-string">' + escapeHtml(match[2]) + "</span>";
      } else if (match[3]) {
        out += '<span class="tok-attr">' + escapeHtml(match[3]) + "</span>";
      } else {
        out += '<span class="tok-number">' + escapeHtml(match[4]) + "</span>";
      }
      last = re.lastIndex;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function highlightGeneric(code, lang) {
    const comment = HASH_COMMENT_LANGS.has(lang)
      ? "#[^\\n]*"
      : lang === "sql"
        ? "--[^\\n]*"
        : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
    const re = new RegExp(
      "(" +
        comment +
        ")|(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)" +
        "|(\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b)" +
        "|(\\b(?:true|false|null|True|False|None|undefined|nil)\\b)" +
        "|([A-Za-z_$][\\w$]*)(?=\\s*\\()" +
        "|([A-Za-z_$][\\w$]*\\b)",
      "g"
    );
    let out = "";
    let last = 0;
    let match;
    while ((match = re.exec(code))) {
      out += escapeHtml(code.slice(last, match.index));
      if (match[1]) {
        out += '<span class="tok-comment">' + escapeHtml(match[1]) + "</span>";
      } else if (match[2]) {
        out += '<span class="tok-string">' + escapeHtml(match[2]) + "</span>";
      } else if (match[3]) {
        out += '<span class="tok-number">' + escapeHtml(match[3]) + "</span>";
      } else if (match[4]) {
        out += '<span class="tok-bool">' + escapeHtml(match[4]) + "</span>";
      } else if (match[5]) {
        out += CODE_KEYWORDS.has(match[5])
          ? '<span class="tok-keyword">' + escapeHtml(match[5]) + "</span>"
          : '<span class="tok-fn">' + escapeHtml(match[5]) + "</span>";
      } else if (CODE_KEYWORDS.has(match[6])) {
        out += '<span class="tok-keyword">' + escapeHtml(match[6]) + "</span>";
      } else {
        out += escapeHtml(match[6]);
      }
      last = re.lastIndex;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function highlightCode(code, lang) {
    if (!code) return "";
    if (lang === "html" || lang === "xml" || lang === "svg" || lang === "vue") {
      return highlightMarkup(code);
    }
    if (lang === "css" || lang === "scss" || lang === "less") {
      return highlightCss(code);
    }
    if (!lang) return escapeHtml(code);
    return highlightGeneric(code, lang);
  }

  function renderCodeBlock(code, lang) {
    const key = normalizeLang(lang);
    const label = CODE_LANG_LABEL[key] || (key ? key.toUpperCase() : "代码");
    return (
      '<div class="code-block">' +
      '<div class="code-head"><span class="code-lang">' +
      escapeHtml(label) +
      "</span>" +
      '<button type="button" class="code-copy" data-copy>复制</button></div>' +
      "<pre><code class=\"language-" +
      escapeHtml(key || "text") +
      '">' +
      highlightCode(code, key) +
      "</code></pre></div>"
    );
  }

  function copyCode(button) {
    const block = button.closest(".code-block");
    const codeEl = block ? block.querySelector("pre code") : null;
    if (!codeEl) return;

    const done = () => {
      button.textContent = "已复制";
      button.classList.add("done");
      clearTimeout(button._copyTimer);
      button._copyTimer = setTimeout(() => {
        button.textContent = "复制";
        button.classList.remove("done");
      }, 1300);
    };

    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = codeEl.textContent;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
        done();
      } catch (error) {
        flashHint("复制失败");
      }
      area.remove();
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(codeEl.textContent).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function imageSrc(url) {
    const raw = String(url || "").trim().replace(/^<|>$/g, "");
    if (/^(https?:|data:|asset:|notepaper:)/i.test(raw)) return raw;
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("file:")) {
      return toImageUrl(raw.replace(/^file:\/*/i, ""));
    }
    if (isRelativeRef(raw)) {
      if (!state.settings.dataDir) return raw;
      return toImageUrl(joinDataPath(raw));
    }
    return raw;
  }

  function renderInline(source) {
    if (!source) return "";
    const codes = [];
    let text = String(source).replace(/`([^`]+)`/g, (_m, code) => {
      codes.push("<code>" + escapeHtml(code) + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    });

    text = escapeHtml(text);

    text = text.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt, url) => {
      return '<img alt="' + alt + '" src="' + imageSrc(url) + '" />';
    });
    text = text.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, label, url) => {
      return '<a href="' + url.trim().replace(/^<|>$/g, "") + '">' + label + "</a>";
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    return text.replace(/\u0000(\d+)\u0000/g, (_m, index) => codes[Number(index)]);
  }

  const RE_UL = /^\s*[-*+]\s+(.*)$/;
  const RE_OL = /^\s*\d+[.)]\s+(.*)$/;
  const RE_QUOTE = /^\s*>\s?/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function isBlockStart(line) {
    return (
      /^\s*```/.test(line) ||
      /^#{1,6}\s+/.test(line) ||
      RE_QUOTE.test(line) ||
      RE_UL.test(line) ||
      RE_OL.test(line)
    );
  }

  function mdToHtml(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    let html = "";
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const buffer = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        html += renderCodeBlock(buffer.join("\n"), fence[1]);
        continue;
      }

      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html += "<h" + level + ">" + renderInline(heading[2].trim()) + "</h" + level + ">";
        i += 1;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        html += "<hr/>";
        i += 1;
        continue;
      }

      if (line.indexOf("|") !== -1 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        html += "<table><thead><tr>";
        headers.forEach((cell) => {
          html += "<th>" + renderInline(cell) + "</th>";
        });
        html += "</tr></thead><tbody>";
        rows.forEach((row) => {
          html += "<tr>";
          headers.forEach((_cell, index) => {
            html += "<td>" + renderInline(row[index] || "") + "</td>";
          });
          html += "</tr>";
        });
        html += "</tbody></table>";
        continue;
      }

      if (RE_QUOTE.test(line)) {
        const buffer = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          buffer.push(lines[i].replace(RE_QUOTE, ""));
          i += 1;
        }
        html += "<blockquote>" + mdToHtml(buffer.join("\n")) + "</blockquote>";
        continue;
      }

      if (RE_UL.test(line) || RE_OL.test(line)) {
        const ordered = RE_OL.test(line);
        const pattern = ordered ? RE_OL : RE_UL;
        let items = "";
        while (i < lines.length && pattern.test(lines[i])) {
          const raw = lines[i].match(pattern)[1];
          const task = raw.match(/^\[( |x|X)\]\s+(.*)$/);
          if (task) {
            items +=
              '<li class="task"><span class="task-box' +
              (task[1].toLowerCase() === "x" ? " done" : "") +
              '"></span><span>' +
              renderInline(task[2]) +
              "</span></li>";
          } else {
            items += "<li>" + renderInline(raw) + "</li>";
          }
          i += 1;
        }
        html += ordered ? "<ol>" + items + "</ol>" : "<ul>" + items + "</ul>";
        continue;
      }

      const buffer = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !isBlockStart(lines[i]) &&
        !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]))
      ) {
        buffer.push(lines[i]);
        i += 1;
      }
      html += "<p>" + renderInline(buffer.join("\n")).replace(/\n/g, "<br/>") + "</p>";
    }

    return html;
  }

  /* ---------------- 渲染 ---------------- */

  function defaultHint() {
    return editing ? "Esc 退出编辑 · Ctrl+S 立即保存" : "双击正文开始编辑 · Ctrl+V 粘贴截图";
  }

  function flashHint(text) {
    els.hint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      els.hint.textContent = defaultHint();
    }, 1800);
  }

  function refreshMeta(note) {
    els.updatedAt.textContent = "修改于：" + formatTime(note ? note.updatedAt : 0);
    els.charCount.textContent = (note ? note.content.length : 0) + " 字";
  }

  function renderNote() {
    const note = activeNote();
    if (!note) {
      els.noteTitle.value = "";
      els.preview.innerHTML = '<p class="empty">还没有笔记，点击右上角 ＋ 新建一条。</p>';
      els.editor.value = "";
      refreshMeta(null);
      return;
    }
    if (document.activeElement !== els.noteTitle || els.noteTitle.value !== note.title) {
      els.noteTitle.value = note.title;
    }
    els.editor.value = note.content;
    els.preview.innerHTML = note.content.trim()
      ? mdToHtml(note.content)
      : '<p class="empty">还没有内容，双击这里开始写。</p>';
    els.preview.scrollTop = 0;
    refreshMeta(note);
    els.preview.classList.toggle("hidden", editing);
    els.editor.classList.toggle("hidden", !editing);
    $("#editBtn").classList.toggle("on", editing);
    els.hint.textContent = defaultHint();
  }

  function renderNoteList() {
    els.noteList.innerHTML = "";
    const fragment = document.createDocumentFragment();

    state.notes.forEach((note) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-item" + (note.id === state.activeNote ? " active" : "");
      button.dataset.id = note.id;

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = note.title.trim() || "未命名笔记";

      const time = document.createElement("span");
      time.className = "time";
      time.textContent = formatTime(note.updatedAt).slice(5, 16);

      button.append(name, time);
      fragment.append(button);
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = "note-add";
    add.dataset.action = "new";
    add.textContent = "＋ 新建笔记";
    fragment.append(add);

    els.noteList.append(fragment);
  }

  function renderTodos() {
    els.todoList.innerHTML = "";
    if (!state.todos.length) {
      const empty = document.createElement("p");
      empty.className = "todo-empty";
      empty.textContent = "还没有待办，先写下第一件小事吧。";
      els.todoList.append(empty);
    } else {
      const fragment = document.createDocumentFragment();
      state.todos.forEach((todo) => {
        const row = document.createElement("div");
        row.className = "todo-item" + (todo.done ? " done" : "");
        row.dataset.id = todo.id;

        const check = document.createElement("button");
        check.type = "button";
        check.className = "todo-check";
        check.dataset.action = "toggle";
        check.title = todo.done ? "标记为未完成" : "标记为完成";
        check.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

        const text = document.createElement("span");
        text.className = "todo-text";
        text.textContent = todo.text;

        const del = document.createElement("button");
        del.type = "button";
        del.className = "todo-del";
        del.dataset.action = "delete";
        del.title = "删除";
        del.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>';

        row.append(check, text, del);
        fragment.append(row);
      });
      els.todoList.append(fragment);
    }

    const done = state.todos.filter((todo) => todo.done).length;
    els.todoProgress.textContent = done + " / " + state.todos.length;
    els.todoLeft.textContent = state.todos.length
      ? "还剩 " + (state.todos.length - done) + " 条"
      : "共 0 条";
  }

  function setEditing(next, focus) {
    if (editing === next) {
      if (next && focus) els.editor.focus();
      return;
    }
    if (!next) {
      const note = activeNote();
      if (note) {
        note.content = els.editor.value;
      }
    }
    editing = next;
    els.preview.classList.toggle("hidden", editing);
    els.editor.classList.toggle("hidden", !editing);
    $("#editBtn").classList.toggle("on", editing);
    els.hint.textContent = defaultHint();
    if (editing) {
      if (focus) {
        els.editor.focus();
        const end = els.editor.value.length;
        els.editor.setSelectionRange(end, end);
      }
    } else {
      renderNote();
    }
  }

  function setTab(tab) {
    closeSettings();
    activeTab = tab;
    els.tabs.forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    els.notePane.classList.toggle("hidden", tab !== "note");
    els.todoPane.classList.toggle("hidden", tab !== "todo");
    if (tab === "note") {
      renderNote();
    }
  }

  /* ---------------- 持久化 ---------------- */

  let pending = false;

  function scheduleSave() {
    clearTimeout(saveTimer);
    pending = true;
    saveTimer = setTimeout(saveNow, 450);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!invoke || !pending) return;
    pending = false;
    try {
      await invoke("save_store", { store: state });
    } catch (error) {
      console.error("保存失败", error);
    }
  }

  function touchNote() {
    const note = activeNote();
    if (!note) return;
    note.updatedAt = now();
    refreshMeta(note);
    scheduleSave();
  }

  /* ---------------- 图片路径迁移 ---------------- */

  /** 把旧版本里的 asset/notepaper 绝对图片链接改写成相对数据目录的路径。 */
  function migrateImageRefs() {
    if (!state.settings.dataDir) return false;
    let changed = false;
    state.notes.forEach((note) => {
      const next = String(note.content || "").replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (match, alt, raw) => {
          const absolute = decodeStoredPath(raw);
          if (!absolute) return match;
          const relative = relativeToDataDir(absolute);
          if (!relative) return match;
          changed = true;
          return "![" + alt + "](" + relative + ")";
        }
      );
      if (next !== note.content) note.content = next;
    });
    return changed;
  }

  /* ---------------- 粘贴与拖拽 ---------------- */

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function insertAtCursor(text) {
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    if (typeof start === "number" && typeof end === "number") {
      els.editor.setRangeText(text, start, end, "end");
    } else {
      els.editor.value += text;
    }
  }

  function ensureEditing() {
    if (editing) return;
    setEditing(true, false);
    const end = els.editor.value.length;
    els.editor.setSelectionRange(end, end);
  }

  function applyInsertedText(text, hint) {
    const note = activeNote();
    if (!note) return;
    insertAtCursor(text);
    note.content = els.editor.value;
    note.updatedAt = now();
    refreshMeta(note);
    scheduleSave();
    if (hint) flashHint(hint);
  }

  /** HTML → Markdown 的轻量转换，用于从浏览器/Office 复制内容后粘贴。 */
  const HTML_SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "head",
    "meta",
    "link",
    "input",
    "button",
    "select",
    "textarea",
    "svg",
    "canvas",
    "iframe",
  ]);

  function tidyBlock(text) {
    return String(text)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function tidyInline(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  function wrapInline(text, marker) {
    const value = tidyInline(text);
    return value ? marker + value + marker : "";
  }

  function renderHtmlChildren(node, options) {
    let output = "";
    node.childNodes.forEach((child) => {
      output += renderHtmlNode(child, options);
    });
    return output;
  }

  function renderHtmlChildrenExcept(node, excluded) {
    let output = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 1 && excluded.includes(child.tagName.toLowerCase())) return;
      output += renderHtmlNode(child, {});
    });
    return output;
  }

  function renderHtmlList(list, ordered) {
    const lines = [];
    let index = 1;
    Array.from(list.children).forEach((child) => {
      if (child.tagName.toLowerCase() !== "li") return;
      const marker = ordered ? index++ + ". " : "- ";
      const content = tidyInline(renderHtmlChildrenExcept(child, ["ul", "ol"]));
      lines.push(marker + content);
      Array.from(child.children).forEach((nested) => {
        const tag = nested.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          renderHtmlList(nested, tag === "ol")
            .split("\n")
            .filter(Boolean)
            .forEach((line) => lines.push("  " + line));
        }
      });
    });
    return lines.join("\n");
  }

  function renderHtmlTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((row) =>
        Array.from(row.children)
          .filter((cell) => ["td", "th"].includes(cell.tagName.toLowerCase()))
          .map((cell) => tidyInline(renderHtmlChildren(cell, {})).replace(/\|/g, "\\|"))
      )
      .filter((cells) => cells.length);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row) => row.concat(Array(width - row.length).fill(""));
    const lines = [
      "| " + pad(rows[0]).join(" | ") + " |",
      "| " + Array(width).fill("---").join(" | ") + " |",
    ];
    rows.slice(1).forEach((row) => lines.push("| " + pad(row).join(" | ") + " |"));
    return lines.join("\n");
  }

  function renderHtmlNode(node, options) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (HTML_SKIP_TAGS.has(tag)) return "";

    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      return (
        "\n\n" +
        "#".repeat(Number(heading[1])) +
        " " +
        tidyInline(renderHtmlChildren(node, options)) +
        "\n\n"
      );
    }

    switch (tag) {
      case "p":
        return "\n\n" + tidyInline(renderHtmlChildren(node, options)) + "\n\n";
      case "br":
        return "  \n";
      case "hr":
        return "\n\n---\n\n";
      case "div":
      case "section":
      case "article":
      case "header":
      case "footer":
      case "main":
      case "aside":
      case "figure":
        return "\n" + renderHtmlChildren(node, options) + "\n";
      case "strong":
      case "b":
        return wrapInline(renderHtmlChildren(node, options), "**");
      case "em":
      case "i":
        return wrapInline(renderHtmlChildren(node, options), "*");
      case "del":
      case "s":
      case "strike":
        return wrapInline(renderHtmlChildren(node, options), "~~");
      case "code":
        return "`" + node.textContent.replace(/`/g, "'") + "`";
      case "pre": {
        const code = node.textContent.replace(/\n$/, "");
        return "\n\n```\n" + code + "\n```\n\n";
      }
      case "a": {
        const label = tidyInline(renderHtmlChildren(node, options));
        const href = node.getAttribute("href") || "";
        if (!href || /^javascript:/i.test(href)) return label;
        return "[" + (label || href) + "](" + href + ")";
      }
      case "img": {
        const src = node.getAttribute("src") || "";
        if (!src) return "";
        return "![" + (node.getAttribute("alt") || "") + "](" + src + ")";
      }
      case "blockquote": {
        const inner = tidyBlock(renderHtmlChildren(node, options));
        return (
          "\n\n" +
          inner
            .split("\n")
            .map((line) => (line ? "> " + line : ">"))
            .join("\n") +
          "\n\n"
        );
      }
      case "ul":
        return "\n" + renderHtmlList(node, false) + "\n";
      case "ol":
        return "\n" + renderHtmlList(node, true) + "\n";
      case "table":
        return "\n\n" + renderHtmlTable(node) + "\n\n";
      case "span":
      case "font":
      case "small":
      case "mark":
      case "sup":
      case "sub": {
        let inner = renderHtmlChildren(node, options);
        const style = (node.getAttribute("style") || "").toLowerCase();
        if (/font-weight\s*:\s*(bold|[6-9]00)/.test(style)) inner = wrapInline(inner, "**");
        if (/font-style\s*:\s*italic/.test(style)) inner = wrapInline(inner, "*");
        if (/line-through/.test(style)) inner = wrapInline(inner, "~~");
        return inner;
      }
      default:
        return renderHtmlChildren(node, options);
    }
  }

  function htmlToMarkdown(html) {
    if (!html || !html.trim()) return "";
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    if (!doc.body) return "";
    return tidyBlock(renderHtmlChildren(doc.body, {}));
  }

  async function handlePaste(event) {
    if (activeTab !== "note" || settingsOpen) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const note = activeNote();
    if (!note) return;

    const items = Array.from(clipboard.items || []);
    const imageItem = items.find((entry) => entry.type && entry.type.indexOf("image/") === 0);

    if (imageItem) {
      event.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;

      ensureEditing();
      flashHint("正在保存截图…");

      let source = "";
      try {
        const base64 = await fileToBase64(file);
        if (invoke) {
          const saved = await invoke("save_image", { data: base64 });
          source = saved && saved.relative ? saved.relative : saved && saved.path ? saved.path : "";
        } else {
          source = "data:" + file.type + ";base64," + base64;
        }
      } catch (error) {
        console.error("截图保存失败", error);
        flashHint("截图保存失败");
        return;
      }

      applyInsertedText("\n![](" + source + ")\n", "截图已插入");
      return;
    }

    const html = clipboard.getData("text/html");
    if (!html || !html.trim()) return;

    let markdown = "";
    try {
      markdown = htmlToMarkdown(html);
    } catch (error) {
      console.error("HTML 转换失败", error);
    }
    if (!markdown) return;

    event.preventDefault();
    ensureEditing();
    applyInsertedText("\n" + markdown + "\n", "已把 HTML 转换为 Markdown");
  }

  /* ---------------- 文件拖拽 ---------------- */

  const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

  function insertDroppedFiles(paths) {
    if (activeTab !== "note" || settingsOpen) return;
    const note = activeNote();
    if (!note) return;
    ensureEditing();
    const snippet = paths
      .map((file) => (IMAGE_FILE_RE.test(file) ? "![](" + file + ")" : file))
      .join("\n");
    applyInsertedText("\n" + snippet + "\n", "已插入 " + paths.length + " 个文件路径");
  }

  function bindDragDrop() {
    const webview =
      tauri.webview && tauri.webview.getCurrentWebview
        ? tauri.webview.getCurrentWebview()
        : null;
    if (!webview || !webview.onDragDropEvent) return;

    webview
      .onDragDropEvent((event) => {
        const payload = (event && event.payload) || {};
        if (payload.type === "enter" || payload.type === "over") {
          if (activeTab === "note" && !settingsOpen) document.body.classList.add("dragging");
        } else if (payload.type === "leave") {
          document.body.classList.remove("dragging");
        } else if (payload.type === "drop") {
          document.body.classList.remove("dragging");
          if (Array.isArray(payload.paths) && payload.paths.length) {
            insertDroppedFiles(payload.paths);
          }
        }
      })
      .catch((error) => console.error("拖拽监听失败", error));
  }

  /* ---------------- 设置 ---------------- */

  let settingsOpen = false;

  const THEME_VARIABLES = [
    "--plum",
    "--plum-2",
    "--ink",
    "--ink-soft",
    "--line",
    "--card",
    "--stroke",
    "--app-bg",
    "--accent-bar",
    "--surface",
    "--surface-strong",
    "--popover-bg",
    "--shadow",
    "--tint",
    "--tint-strong",
    "--switch-off",
    "--scroll-thumb",
    "--scroll-thumb-hover",
    "--on-ink",
    "--danger",
    "--ui-font",
    "--preview-font",
    "--mono-font",
    "--code-bg",
    "--code-head",
    "--code-text",
    "--token-keyword",
    "--token-string",
    "--token-number",
    "--token-comment",
    "--token-fn",
    "--token-tag",
    "--token-attr",
    "--token-bool",
  ];

  const FALLBACK_THEMES = [
    { id: "sakura", name: "粉樱", colorScheme: "light", variables: {}, builtin: true },
    { id: "midnight", name: "暗夜", colorScheme: "dark", variables: {}, builtin: true },
    { id: "mint", name: "薄荷", colorScheme: "light", variables: {}, builtin: true },
    { id: "paper", name: "素纸", colorScheme: "light", variables: {}, builtin: true },
  ];

  function availableThemes() {
    return state.themes.length ? state.themes : FALLBACK_THEMES;
  }

  function applyTheme(theme) {
    const themes = availableThemes();
    const selected =
      themes.find((item) => item.id === theme) ||
      themes.find((item) => item.id === "sakura") ||
      FALLBACK_THEMES[0];
    const root = document.documentElement;
    THEME_VARIABLES.forEach((name) => root.style.removeProperty(name));
    Object.entries(selected.variables || {}).forEach(([name, value]) => {
      if (THEME_VARIABLES.includes(name)) root.style.setProperty(name, value);
    });
    root.dataset.theme = selected.id;
    root.style.colorScheme = selected.colorScheme || "light";
  }

  async function loadThemes() {
    if (invoke) {
      try {
        state.themes = await invoke("list_themes");
      } catch (error) {
        console.error("读取主题失败", error);
        state.themes = [];
        if (settingsOpen) {
          els.settingsMsg.textContent =
            "主题读取失败：" + (error && error.message ? error.message : String(error));
        }
      }
    }
    if (!availableThemes().some((theme) => theme.id === state.settings.theme)) {
      state.settings.theme = "sakura";
    }
    applyTheme(state.settings.theme);
    renderSettings();
  }

  function renderThemeOptions() {
    const list = $("#themeList");
    list.innerHTML = "";
    const fragment = document.createDocumentFragment();
    availableThemes().forEach((theme) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-item" + (theme.id === state.settings.theme ? " active" : "");
      button.dataset.theme = theme.id;
      button.title = "themes/" + theme.id + ".json";

      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      const background = theme.variables && theme.variables["--app-bg"];
      if (background) swatch.style.background = background;

      const name = document.createElement("span");
      name.className = "theme-name";
      name.textContent = theme.name;
      button.append(swatch, name);
      fragment.append(button);
    });
    list.append(fragment);
  }

  function renderSettings() {
    els.dataDirText.textContent = state.settings.dataDir || "—";
    els.imagesDirText.textContent = state.settings.imagesDir || "—";
    els.alwaysOnTopToggle.setAttribute(
      "aria-checked",
      String(!!state.settings.alwaysOnTop)
    );
    renderThemeOptions();
  }

  function openSettings() {
    settingsOpen = true;
    closeNoteList();
    els.settingsMsg.textContent = "";
    renderSettings();
    els.settingsPane.classList.remove("hidden");
    loadThemes();
  }

  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    els.settingsPane.classList.add("hidden");
  }

  async function updateSettings(patch) {
    const next = {
      dataDir: patch.dataDir !== undefined ? patch.dataDir : state.settings.dataDir,
      imagesDir: patch.imagesDir !== undefined ? patch.imagesDir : state.settings.imagesDir,
      alwaysOnTop:
        patch.alwaysOnTop !== undefined ? patch.alwaysOnTop : state.settings.alwaysOnTop,
      theme: patch.theme !== undefined ? patch.theme : state.settings.theme,
    };

    if (!invoke) {
      state.settings = next;
      applyTheme(state.settings.theme);
      renderSettings();
      return true;
    }

    try {
      const resolved = await invoke("update_settings", { settings: next });
      state.settings = resolved;
      pinned = !!resolved.alwaysOnTop;
      $("#pinBtn").classList.toggle("on", pinned);
      $("#pinBtn").title = pinned ? "取消置顶" : "窗口置顶";
      if (patch.dataDir !== undefined) {
        await loadThemes();
      } else {
        renderSettings();
      }
      return true;
    } catch (error) {
      console.error("保存设置失败", error);
      els.settingsMsg.textContent =
        "保存失败：" + (error && error.message ? error.message : String(error));
      renderSettings();
      return false;
    }
  }

  async function applyAlwaysOnTop(value) {
    pinned = value;
    state.settings.alwaysOnTop = value;
    $("#pinBtn").classList.toggle("on", value);
    $("#pinBtn").title = value ? "取消置顶" : "窗口置顶";
    renderSettings();
    if (appWindow) {
      try {
        await appWindow.setAlwaysOnTop(value);
      } catch (error) {
        console.error("设置置顶失败", error);
      }
    }
  }

  async function pickFolder(kind) {
    if (!invoke) {
      els.settingsMsg.textContent = "浏览器预览模式下无法选择目录。";
      return;
    }
    els.settingsMsg.textContent = "正在打开目录选择器…";
    try {
      const path = await invoke("pick_folder");
      if (!path) {
        els.settingsMsg.textContent = "";
        return;
      }
      const patch = kind === "data" ? { dataDir: path } : { imagesDir: path };
      if (!(await updateSettings(patch))) return;
      // 切换数据目录后立即把内存中的最新内容写到新位置。
      pending = true;
      await saveNow();
      els.settingsMsg.textContent =
        kind === "data"
          ? "数据目录已切换，当前笔记已写入新位置。"
          : "图片目录已切换，新截图将保存到该目录。";
    } catch (error) {
      console.error("选择目录失败", error);
      els.settingsMsg.textContent =
        "选择目录失败：" + (error && error.message ? error.message : String(error));
    }
  }

  async function openFolder(kind) {
    const path = kind === "data" ? state.settings.dataDir : state.settings.imagesDir;
    if (!invoke || !path) return;
    try {
      await invoke("open_folder", { path });
    } catch (error) {
      els.settingsMsg.textContent =
        "打开目录失败：" + (error && error.message ? error.message : String(error));
    }
  }

  async function reloadStoreFromDisk() {
    if (!invoke) return;
    const store = await invoke("load_store");
    state.notes = Array.isArray(store.notes) ? store.notes : [];
    state.todos = Array.isArray(store.todos) ? store.todos : [];
    state.activeNote = store.activeNote || "";
    editing = false;
    migrateImageRefs();
    ensureNotes();
    renderNote();
    renderTodos();
    pending = true;
    await saveNow();
    await loadThemes();
  }

  function backupName() {
    const d = new Date();
    return (
      "notepaper-backup-" +
      d.getFullYear() +
      "-" +
      two(d.getMonth() + 1) +
      "-" +
      two(d.getDate()) +
      ".zip"
    );
  }

  async function exportBackup() {
    if (!invoke) {
      els.settingsMsg.textContent = "浏览器预览模式下无法导出备份。";
      return;
    }
    try {
      const target = await invoke("pick_backup_target", { defaultName: backupName() });
      if (!target) return;
      els.settingsMsg.textContent = "正在导出备份…";
      const saved = await invoke("export_backup", { target });
      els.settingsMsg.textContent = "备份已导出：" + saved;
    } catch (error) {
      console.error("导出备份失败", error);
      els.settingsMsg.textContent =
        "导出失败：" + (error && error.message ? error.message : String(error));
    }
  }

  async function importBackup() {
    if (!invoke) {
      els.settingsMsg.textContent = "浏览器预览模式下无法导入备份。";
      return;
    }
    try {
      const source = await invoke("pick_backup_file");
      if (!source) return;
      if (!confirm("导入会覆盖当前笔记与图片，确定继续吗？")) return;
      els.settingsMsg.textContent = "正在导入备份…";
      const count = await invoke("import_backup", { source });
      await reloadStoreFromDisk();
      els.settingsMsg.textContent =
        "已导入 " + count + " 个文件，笔记已刷新；原数据保留为 data.json.bak。";
    } catch (error) {
      console.error("导入备份失败", error);
      els.settingsMsg.textContent =
        "导入失败：" + (error && error.message ? error.message : String(error));
    }
  }

  async function exportCurrentTheme() {
    if (!invoke) {
      els.settingsMsg.textContent = "浏览器预览模式下无法导出主题。";
      return;
    }
    try {
      const id = state.settings.theme;
      const target = await invoke("pick_theme_target", { defaultName: id + ".json" });
      if (!target) return;
      const saved = await invoke("export_theme", { id, target });
      els.settingsMsg.textContent = "主题已导出：" + saved;
    } catch (error) {
      console.error("导出主题失败", error);
      els.settingsMsg.textContent =
        "导出主题失败：" + (error && error.message ? error.message : String(error));
    }
  }

  async function importTheme() {
    if (!invoke) {
      els.settingsMsg.textContent = "浏览器预览模式下无法导入主题。";
      return;
    }
    try {
      const source = await invoke("pick_theme_file");
      if (!source) return;
      const theme = await invoke("import_theme", { source });
      await loadThemes();
      if (await updateSettings({ theme: theme.id })) {
        applyTheme(theme.id);
        els.settingsMsg.textContent = "已导入并切换到「" + theme.name + "」主题。";
      }
    } catch (error) {
      console.error("导入主题失败", error);
      els.settingsMsg.textContent =
        "导入主题失败：" + (error && error.message ? error.message : String(error));
    }
  }

  function bindSettingsEvents() {
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#settingsClose").addEventListener("click", closeSettings);
    $("#dataDirPick").addEventListener("click", () => pickFolder("data"));
    $("#imagesDirPick").addEventListener("click", () => pickFolder("images"));
    $("#dataDirOpen").addEventListener("click", () => openFolder("data"));
    $("#imagesDirOpen").addEventListener("click", () => openFolder("images"));
    $("#exportBackup").addEventListener("click", exportBackup);
    $("#importBackup").addEventListener("click", importBackup);
    $("#exportTheme").addEventListener("click", exportCurrentTheme);
    $("#importTheme").addEventListener("click", importTheme);

    $("#themeList").addEventListener("click", async (event) => {
      const item = event.target.closest(".theme-item");
      if (!item) return;
      const theme = item.dataset.theme;
      if (theme === state.settings.theme) return;
      state.settings.theme = theme;
      applyTheme(theme);
      renderSettings();
      if (await updateSettings({ theme: theme })) {
        const selected = availableThemes().find((entry) => entry.id === theme);
        els.settingsMsg.textContent =
          "已切换到「" + (selected ? selected.name : theme) + "」主题。";
      }
    });

    els.alwaysOnTopToggle.addEventListener("click", async () => {
      const next = !state.settings.alwaysOnTop;
      await applyAlwaysOnTop(next);
      const ok = await updateSettings({ alwaysOnTop: next });
      if (ok) els.settingsMsg.textContent = next ? "已开启启动置顶。" : "已关闭启动置顶。";
    });

    $("#resetDirs").addEventListener("click", async () => {
      if (!(await updateSettings({ dataDir: "", imagesDir: "" }))) return;
      pending = true;
      await saveNow();
      els.settingsMsg.textContent = "已恢复默认路径，当前笔记已写入默认目录。";
    });
  }

  /* ---------------- 事件 ---------------- */

  function bindWindowButtons() {
    $("#closeBtn").addEventListener("click", () => {
      if (appWindow) appWindow.close();
    });

    $("#minBtn").addEventListener("click", () => {
      if (appWindow) appWindow.minimize();
    });

    $("#pinBtn").addEventListener("click", async () => {
      if (!appWindow) return;
      const next = !pinned;
      await applyAlwaysOnTop(next);
      const ok = await updateSettings({ alwaysOnTop: next });
      if (ok) flashHint(next ? "窗口已置顶" : "已取消置顶");
    });

    document.addEventListener("paste", handlePaste);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && settingsOpen) {
        closeSettings();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        pending = true;
        saveNow().then(() => flashHint("已保存"));
      }
    });

    window.addEventListener("beforeunload", () => {
      if (invoke) invoke("save_store", { store: state }).catch(() => {});
    });
  }

  function bindNoteEvents() {
    els.tabs.forEach((button) => {
      button.addEventListener("click", () => setTab(button.dataset.tab));
    });

    $("#editBtn").addEventListener("click", () => setEditing(!editing, true));
    els.preview.addEventListener("dblclick", (event) => {
      if (event.target.closest("[data-copy]")) return;
      setEditing(true, true);
    });

    els.preview.addEventListener("click", (event) => {
      const copy = event.target.closest("[data-copy]");
      if (copy) {
        event.preventDefault();
        event.stopPropagation();
        copyCode(copy);
        return;
      }
      if (event.target.closest("a")) {
        event.preventDefault();
        flashHint("编辑模式下可修改链接");
      }
    });

    els.editor.addEventListener("input", () => {
      const note = activeNote();
      if (!note) return;
      note.content = els.editor.value;
      note.updatedAt = now();
      refreshMeta(note);
      scheduleSave();
    });

    els.editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setEditing(false, false);
      }
    });

    els.noteTitle.addEventListener("input", () => {
      const note = activeNote();
      if (!note) return;
      note.title = els.noteTitle.value;
      note.updatedAt = now();
      refreshMeta(note);
      scheduleSave();
      if (!els.noteList.classList.contains("hidden")) renderNoteList();
    });

    els.noteTitle.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        setEditing(true, true);
      }
    });

    $("#listBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      if (els.noteList.classList.contains("hidden")) {
        renderNoteList();
        els.noteList.classList.remove("hidden");
        $("#listBtn").classList.add("on");
      } else {
        closeNoteList();
      }
    });

    els.noteList.addEventListener("click", (event) => {
      const item = event.target.closest(".note-item");
      if (item) {
        state.activeNote = item.dataset.id;
        closeNoteList();
        renderNote();
        scheduleSave();
        return;
      }
      const add = event.target.closest("[data-action='new']");
      if (add) {
        newNote();
        closeNoteList();
        renderNote();
        els.noteTitle.value = "";
        els.noteTitle.focus();
        scheduleSave();
      }
    });

    document.addEventListener("click", (event) => {
      if (
        !els.noteList.classList.contains("hidden") &&
        !els.noteList.contains(event.target) &&
        !$("#listBtn").contains(event.target)
      ) {
        closeNoteList();
      }
    });

    $("#deleteBtn").addEventListener("click", () => {
      const note = activeNote();
      if (!note) return;
      const index = state.notes.indexOf(note);
      if (state.notes.length === 1) {
        if (!confirm("清空这条笔记？")) return;
        note.title = "";
        note.content = "";
        note.updatedAt = now();
        els.noteTitle.value = "";
        els.editor.value = "";
        refreshMeta(note);
        renderNote();
        scheduleSave();
        return;
      }
      if (!confirm("删除「" + (note.title.trim() || "未命名笔记") + "」？")) return;
      state.notes.splice(index, 1);
      const next = state.notes[Math.min(index, state.notes.length - 1)];
      state.activeNote = next.id;
      renderNote();
      scheduleSave();
      flashHint("已删除");
    });
  }

  function closeNoteList() {
    els.noteList.classList.add("hidden");
    $("#listBtn").classList.remove("on");
  }

  function bindTodoEvents() {
    els.todoForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = els.todoInput.value.trim();
      if (!text) {
        els.todoInput.focus();
        return;
      }
      state.todos.unshift({ id: uid(), text: text, done: false, createdAt: now() });
      els.todoInput.value = "";
      els.todoInput.focus();
      renderTodos();
      scheduleSave();
    });

    els.todoList.addEventListener("click", (event) => {
      const row = event.target.closest(".todo-item");
      if (!row) return;
      const todo = state.todos.find((entry) => entry.id === row.dataset.id);
      if (!todo) return;
      const action = event.target.closest("[data-action]");
      if (!action) return;

      if (action.dataset.action === "toggle") {
        todo.done = !todo.done;
        renderTodos();
        scheduleSave();
      } else if (action.dataset.action === "delete") {
        state.todos = state.todos.filter((entry) => entry.id !== todo.id);
        renderTodos();
        scheduleSave();
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    bindWindowButtons();
    bindNoteEvents();
    bindTodoEvents();
    bindSettingsEvents();
    bindDragDrop();

    if (invoke) {
      const [store, settings] = await Promise.all([
        invoke("load_store").catch((error) => {
          console.error("读取数据失败", error);
          return null;
        }),
        invoke("get_settings").catch((error) => {
          console.error("读取设置失败", error);
          return null;
        }),
      ]);

      if (store) {
        state.notes = Array.isArray(store.notes) ? store.notes : [];
        state.todos = Array.isArray(store.todos) ? store.todos : [];
        state.activeNote = store.activeNote || "";
      }
      if (settings) {
        state.settings = settings;
        pinned = !!settings.alwaysOnTop;
      }
    } else {
      state.settings.dataDir = "预览模式（未连接 Tauri）";
      state.settings.imagesDir = "预览模式（未连接 Tauri）";
    }

    await loadThemes();
    $("#pinBtn").classList.toggle("on", pinned);
    $("#pinBtn").title = pinned ? "取消置顶" : "窗口置顶";

    if (migrateImageRefs()) {
      pending = true;
      saveNow();
    }
    ensureNotes();

    renderNote();
    renderTodos();
  }

  boot();
})();
