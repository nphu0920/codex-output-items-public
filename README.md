# Codex 产出项

面向 Windows Codex Desktop 的本地优先产出索引。它从本机 Codex 历史和后续会话中发现真实文件产出，按根任务归组，保留版本、状态、大小与活动记录，并在隔离的 Codex 伴生窗口中提供“产出项”侧栏入口。

本项目不是 OpenAI 官方插件，也不修改 Codex 安装目录或 `app.asar`。扫描器依赖 Codex 当前未公开的本地数据库、会话事件和 DOM 结构，Codex 更新后可能需要同步适配。

## 功能

- 首次历史回填与后续增量扫描；subagent 产出归入根用户任务。
- 扩展自身安装记录只在一次性登记环境提供合法任务 UUID 时归入该任务；没有真实上下文时明确归入 `local-install` 未知来源组，不生成不存在的任务会话。长驻 HTTP、伴生程序及受管 ChatGPT 不继承这项一次性任务上下文。
- 同一任务下的正常产出在前、已删除产出沉底；全部产出均删除的任务组不显示。
- 持久化精确文件大小、层级文件树、版本、优先级和人工标记。
- 文件树默认收起并逐层展开；每一级都稳定地先显示文件夹、再显示普通文件。
- Codex 任务会话重命名后会轻量同步最新任务组名称，不制造新版本或改变产出排序。
- 对已登记文本和图片进行有界、惰性、安全预览。
- “打开位置”精确匹配目标目录的 Explorer 窗口并复核前置结果；Windows 拒绝前置时明确报错。
- 经二次确认后将可信产出移入 Windows 回收站，保留索引与历史。
- 可选通过用户自己的 GitHub CLI 发布；活动登录与只读 API 身份必须一致，界面按“先预检、再勾选确认”两阶段放行，不读取或保存 token。
- 深色、浅色和跟随系统外观与 Codex 实时同步，首帧即应用主题且不改变三栏布局。
- 使用独立 Codex profile 和私有调试管道提供伴生入口，不影响普通 Codex 窗口；首次启动伴生窗口需要单独登录一次。

## 系统要求

- Windows 10 或 Windows 11；完整验证使用 Windows 11 和 Windows PowerShell 5.1。
- 已安装并至少启动过一次 Microsoft Store 版 Codex Desktop。
- 可执行的 Codex CLI，供安装器管理用户级 `output_items` MCP 注册。
- 支持 `node:sqlite` 的 Node.js。安装器会依次检查 `OUTPUT_ITEMS_NODE`、PATH、Codex 缓存运行时和 Microsoft Store Codex 包内运行时，并做能力探测；推荐 Node.js 22.13+，完整验证使用 Node.js 24。
- 当前用户可写 `%USERPROFILE%`、`%LOCALAPPDATA%` 和自己的 `.codex` 配置；不需要管理员权限。

可选 GitHub 发布另需 Git、[GitHub CLI](https://cli.github.com/) 和用户自行完成的 `gh auth login`。

## 下载与校验

1. 从仓库 **Releases** 下载 `codex-output-items-windows-1.0.0.zip` 和同名 `.sha256` 文件。不要使用 GitHub 自动生成的 “Source code.zip”。
2. 在 PowerShell 中校验：

   ```powershell
   Get-FileHash .\codex-output-items-windows-1.0.0.zip -Algorithm SHA256
   Get-Content .\codex-output-items-windows-1.0.0.zip.sha256
   ```

3. 将 ZIP **完整解压**到普通本地目录。不要直接在压缩包浏览窗口内运行文件。
4. 双击 `安装产出项扩展.bat`。安装器会先校验内部逐文件清单和自检结果，再修改现有安装。

Windows SmartScreen 可能提示未知发布者。确认下载来源和 SHA-256 一致后再继续；不要从聊天附件、网盘镜像或重新打包的 ZIP 安装。

## 首次启动

安装完成后双击 `启动 Codex 产出项.bat`，或使用安装器创建的桌面快捷方式。伴生 Codex 使用独立 profile，首次打开时可能需要再次登录；这是隔离设计的一部分。

安装位置和数据位置固定为：

- 程序：`%USERPROFILE%\CodexLocalExtensions\output-items`
- 索引与扫描游标：`%LOCALAPPDATA%\CodexOutputItems\data`
- 日志和运行状态：`%LOCALAPPDATA%\CodexOutputItems\logs`、`run`
- 独立 Codex profile：`%LOCALAPPDATA%\CodexOutputItems\companion\codex-profile`

扩展只绑定 `127.0.0.1` 动态端口。自动扫描不会执行、移动、重命名或删除发现的文件。

## 升级与回滚

1. 双击旧版目录中的 `停止 Codex 产出项.bat`，确认伴生窗口已关闭。
2. 下载、校验并完整解压新的 Release ZIP。
3. 双击新包中的 `安装产出项扩展.bat`。

安装器会在同一磁盘先建立完整暂存目录，校验暂存自检，并在 `%LOCALAPPDATA%\CodexOutputItems\backups` 保存升级前的索引、扫描游标、事件日志和安装状态。旧安装目录仅在预检全部成功后才会被换出；注册、自检或启动失败时会恢复旧目录、数据和 MCP 注册。成功安装后数据备份仍保留，其位置写入 `install-state.json`。

不要在安装进行时结束 PowerShell 或手工移动安装目录。如果回滚报告失败，保留控制台信息和 `backups` 目录，再提交安全报告。

## 启用、停用、停止和卸载

- `停止 Codex 产出项.bat`：关闭伴生窗口与本地 HTTP 服务，保留 MCP 注册、程序和数据。
- `停用产出项扩展.bat`：关闭服务并移除 MCP 注册，保留程序和数据。
- `启用产出项扩展.bat`：重新注册 MCP 并启动伴生入口。
- `卸载产出项扩展.bat`：移除安装目录、MCP 注册、受管快捷方式、运行状态和独立 profile；保留产出索引和所有真实产出文件。

若需要彻底清理历史数据，请先备份并确认目标确实是 `%LOCALAPPDATA%\CodexOutputItems`。卸载器默认不会删除该数据根，避免误删记录。

## 隐私与安全边界

扫描器只读访问当前用户 `.codex` 下的任务数据库、会话记录、生成图片和可视化目录。扩展自身只写隔离数据目录、用户级 MCP 注册和用户明确要求的桌面快捷方式。

文件删除必须来自可信自动扫描证据、严格位于授权根内并经过明确确认；系统目录、用户根、工作区根、网络共享、可移动磁盘、链接和目录联接都会被拒绝。生产删除只进入 Windows 回收站。

GitHub 上传先用 `gh auth status` 与只读 `gh api user` 交叉确认当前账号，再复制到隔离暂存目录并检查 secret、链接、文件大小、源变化和 SHA-256；只有用户确认与预检完全一致时才会调用写入命令。凭据失效、账号不一致、受保护源路径、Public 仓库风险、默认分支直写和保护失败都会明确提示。

## 兼容性与排障

v1.0.0 的完整验证基线为 Windows 11、Codex Desktop 26.810.7004.0、Codex CLI 0.148.0-alpha.9 和 Node.js 24.19.0。其他组合需要重新执行 Release 自检；Codex 私有结构变化不属于稳定 API 保证。

安装器支持以下定位覆盖：

- `OUTPUT_ITEMS_NODE`：指定兼容 Node 可执行文件。
- `CODEX_CLI_PATH`：指定 Codex CLI。
- `OUTPUT_ITEMS_CODEX_EXE`：指定官方 Codex `ChatGPT.exe`。

常见问题：

- “未找到支持 node:sqlite”：升级 Node，或启动一次官方 Codex 后重试。
- “未找到 Codex CLI”：确认 Store 版 Codex 已启动过，或设置 `CODEX_CLI_PATH`。
- 独立窗口要求登录：在该伴生窗口完成一次登录；不会复用普通 Codex profile。
- GitHub 功能未就绪：分别执行 `git --version`、`gh --version` 和 `gh auth status`。
- Codex 更新后入口消失：先停止扩展并查看最新兼容性公告；真实产出文件不受影响。

## 从源码构建

```powershell
npm ci --prefix web
npm run check
npm run test:web
npm run build:release
```

构建会生成白名单 staging、脱敏扫描、`release-manifest.json`、SPDX SBOM、确定性 ZIP 和外部 SHA-256，并把 ZIP 解压到全新临时目录再次校验和自检。详细流程见 [docs/releasing.md](docs/releasing.md)。

## 许可证

项目采用 MIT License。第三方组件、版本与归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 Release 内的 `SBOM.spdx.json`。
