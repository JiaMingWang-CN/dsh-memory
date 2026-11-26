# Memloom Desktop（Windows 独立桌面客户端）指南

`memloom`（原 `dsh-memory`）在共享记忆内核（`src/core/`）与既有管理界面组件（`src/client/`）的基础上，在 `src/desktop/` 与隔离打包工程 `desktop/` 提供 **Memloom Desktop**——面向本地长期记忆库的可视化桌面管理客户端，支持同机管理 DSH、Antigravity（AGY）与自定义目录记忆库。

> [!NOTE]
> **开发状态说明**：`memloom` 当前仍处于 **0.x 开发版本**（`0.1.3`），尚未发布稳定版。当前桌面端仅完成 Windows `win-x64` 安装程序（NSIS `.exe`）构建与验证，macOS / Linux 目标仅在配置中预留扩展段。

---

## 核心能力（已实现）

- **多客户端自动发现与管理**：
  - 自动发现本机 DSH 默认库（`$DSH_HOME/storages/memory.json` 或 `~/.dsh/storages/memory.json`）、DSH 各 profile 库（`profiles/*/storages/memory.json`）及 AGY 默认/环境变量库（`MEMLOOM_STORE_PATH`、`MEMLOOM_DATA_DIR`、`PLUGIN_DATA` 或 `~/.gemini/config/plugin-data/memloom/memory.json`），同时兼容检测遗留旧路径。
  - 支持通过原生文件选择器添加、重命名或移除自定义 `memory.json` 库（新建仅限自定义库或尚未初始化的 AGY 库）。
- **双外层存储格式保真与损坏保护**：
  - 自动识别并无损往返序列化 DSH `dsh-unit`（`{ unit, global, tables }`，完整保留 `unit` 与 `global` 元数据）与 AGY `agy-flat` 两种封装格式。
  - 写入 DSH 库前执行磁盘 SHA-256 外部变更检测（若被外部修改则立即中止并返回 `desktop/external-change`），并在每次逻辑写批前于同目录 `backups/memory-desktop-before-write-*.json` 创建自动快照备份（最多保留 20 份同类桌面自动备份）。
  - 读写 AGY 库时复用跨进程文件锁（`.memory.lock`）与原子替换，避免与常驻 MCP Server / Hooks 冲突。
- **DSH 并发写保护状态机**：
  - 自动检测本机运行中的 DSH 进程（查询异常时按 fail-closed 降级保护）。
  - 检测到 DSH 正在运行时，所有 DSH 客户端自动进入 `readonly-dsh-running` 只读保护态：使用 `openReadOnly()` 打开，严禁触发 `recover()` 或任何磁盘写入，同时提供刷新检测与显式风险确认后的临时强制解锁（`force-unlocked`）。
- **全客户端只读聚合检索**：
  - 跨全部已启用客户端执行管理态 BM25 聚合检索与工作区列表聚合；单个客户端处于 `missing` / `corrupted` / `unreadable` 状态时自动隔离并记录在 `skippedClients` 中，不影响其余健康库检索。
- **双栏桌面布局与单库管理**：
  - 采用生产级双栏工作台布局：**左侧边栏**展示全部客户端总览、已发现或自定义的平台记忆库（按 DSH / AGY / 自定义图标区分）及语言/主题/跨库迁移工具；**右侧主工作区**上方固定展示当前平台标题与**横栏分类**（单平台 5 类功能标签页 / 全客户端聚合记忆类型分类），下方为单一独立滚动的记忆内容区，配有自定义圆角滚动条。
  - 单个客户端支持 5 个功能标签页：**记忆**（检索、新建、编辑、软遗忘、恢复）、**待审阅**（对比与批准/拒绝提案）、**整理与审计**（`DreamRun` 历史、按批撤销与 `AuditRecord` 时间线）、**导入与导出**（JSON 导入导出与跨库迁移入口）与**配置**（编辑运行配置；DSH profile 的 `cordis.patch.yml` 保持只读不越权修改）。
  - 支持单条/多选直接迁移（仅 `merge`）及跨库迁移向导（支持 `merge` 与带完整工作区映射及风险确认门禁的 `replace`）。
- **安全基线、生产窗口与外观**：
  - Electron 窗口启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，移除顶部原生菜单栏及默认 DevTools 调试入口（仅在显式设置 `MEMLOOM_DESKTOP_DEVTOOLS=1` 时开放调试快捷键）；所有 IPC 通道经 `zod` 校验，文件路径操作严格受原生对话框授权登记簿约束。
  - 内置亮色 / 暗色 / 跟随系统主题与中文 / 英文界面切换，桌面自身状态持久化在 Electron `userData` 目录下的 `desktop-state.json`，不污染任何 `memory.json`。

---

## 本地构建与 Windows 打包

### 环境要求

- **源码构建与打包**：Node.js `>= 24.9.0`、`pnpm`（Windows `win-x64` 构建安装程序 `.exe` 需在 `desktop/` 目录安装 `electron` 与 `electron-builder`）。
- 根目录 `package.json` 的生产依赖、DSH bundle 清单（`pnpm pack:check`）与 AGY 插件产物（`pnpm pack:agy:check`）均与桌面打包工程严格隔离。

### 构建、校验与生成 `.exe`

```bash
# 1. 构建主进程、Preload、Renderer 与 256x256 .ico 图标至 dist/desktop-app/
pnpm run build:desktop

# 2. 校验 dist/desktop-app/ 产物完整性与隔离边界
pnpm run pack:desktop:check

# 3. 在隔离的 desktop/ 子目录安装 Electron 依赖并打包 Windows NSIS 安装程序 .exe
pnpm --dir desktop install
pnpm --dir desktop run pack:win
```

打包完成后将在 `dist/desktop-release/` 下生成向导式 Windows 安装程序（支持自定义安装路径、创建桌面与开始菜单快捷方式，卸载时保留 `%APPDATA%/memloom-desktop/` 用户数据）：

```text
dist/desktop-release/memloom-desktop-0.1.3-win-x64-setup.exe
```

> [!TIP]
> **Windows 11 智能应用控制（Smart App Control）提示**：本地构建的安装程序 `.exe` 及 Electron 上游预编译 `electron.exe` 均未附带商业 Authenticode 代码签名，在开启 Windows 11 智能应用控制的主机上会被拦截。无需关闭智能应用控制，可直接运行以下命令通过全已签名运行时（官方签名的 `node.exe` 本地受鉴权桥接 + Microsoft 签名的 `msedge.exe --app` 无地址栏独立应用窗口）启动桌面端，并与 Electron 模式共享同一份 `desktop-state.json` 配置（服务保持常驻，关闭应用窗口或按 `Ctrl+C` 后退出）：
>
> ```bash
> pnpm run start:desktop
> ```
>
> 对外公开发布已签名的 Windows 安装程序请使用下文的 SignPath Foundation 自动化签名发布流水线。

### SignPath Foundation 免费开源代码签名（GitHub Actions）

本仓库已在 [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) 集成 **SignPath Foundation** 两阶段签名流程（先对 `Memloom Desktop.exe` 主程序签名，再封装为 NSIS 安装程序并对 `memloom-desktop-<version>-win-x64-setup.exe` 签名）。审批通过后在 GitHub 仓库配置以下条目即可触发自动签名与 Release 附件上传：

- **Repository Secrets**：`SIGNPATH_API_TOKEN`、`SIGNPATH_ORGANIZATION_ID`
- **Repository Variables（可选，若与默认不一致）**：`SIGNPATH_PROJECT_SLUG`（默认 `memloom`）、`SIGNPATH_SIGNING_POLICY`（默认 `release-signing`）
- **签名政策与致谢**：Free code signing provided by SignPath.io, certificate by SignPath Foundation. 详见 [`docs/code-signing-policy.md`](code-signing-policy.md)。

`dist/desktop-app/` 产物结构：

```text
dist/desktop-app/
├── package.json            # name: "memloom-desktop", main: "./main.cjs", private: true
├── main.cjs                # Electron Main 进程单文件 CJS 产物
├── preload.cjs             # Sandboxed Preload 桥接产物
├── local-launcher.mjs      # 已签名 Node + Edge `--app` 本地启动入口
├── assets/
│   └── icon.ico            # 256x256 PNG-in-ICO 应用图标
└── renderer/
    ├── index.html          # 含严格 CSP 的桌面渲染页入口
    ├── index.js            # 捆绑 React 19 与桌面界面的浏览器 IIFE 产物
    ├── local-bridge.js     # 本地受鉴权 HTTP/RPC 浏览器桥接产物
    └── theme.css           # --dsw-* 亮/暗双主题 token 与桌面壳布局样式
```

---

## 已知限制

- **暂仅验证 Windows `win-x64` 安装程序**：macOS 与 Linux 构建目标仅在 `desktop/electron-builder.yml` 中预留注释配置，尚未实机打包验证。
- **不内置外部 LLM 客户端**：桌面端不托管模型 API Key 或直接调用外部模型执行 Dream；聚焦记忆浏览、人工审阅、Dream 历史撤销、备份与跨库迁移。
- **不修改 DSH Profile 配置文件**：`~/.dsh/profiles/*/cordis.patch.yml` 在桌面端仅作提示参考，避免破坏 DSH 多 profile 一致性。
