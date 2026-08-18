# 架构

```text
独立目录/server.mjs
  ├─ 默认模式：stdio MCP JSON-RPC
  │    ├─ global MCP 应用入口元数据
  │    ├─ ui://output-items/dashboard.html
  │    └─ 扫描、登记、读取、预览、检测、人工标记、定位、删除、优先级与批量工具
  ├─ --http 模式：127.0.0.1:动态端口
  │    ├─ ui/ 静态界面
  │    ├─ GET /api/items
  │    ├─ GET /api/scan-status
  │    ├─ POST /api/scan
  │    ├─ POST /api/items/:id/detect
  │    ├─ POST /api/items/:id/mark
  │    ├─ POST /api/items/:id/open-location|preview|delete-file|delete-project|priority
  │    ├─ POST /api/items/batch/detect|delete|priority
  │    └─ GET /health
  ├─ 主动扫描器（只读 Codex 数据）
  │    ├─ ~/.codex/state_*.sqlite：任务、任务树与根任务
  │    ├─ ~/.codex/sessions + archived_sessions：产出证据与增量记录
  │    ├─ ~/.codex/generated_images：生成图片组
  │    └─ ~/.codex/visualizations：可视化产出组
  └─ %LOCALAPPDATA%/CodexOutputItems
       ├─ data/items.json
       ├─ data/scanner.json
       ├─ logs/events.ndjson
       └─ run/server.json
```

扩展描述文件是自定义的 `extension.json`，不是 `.codex-plugin/plugin.json`。安装器先验证 Release 清单与隔离自检，在同盘 staging 完整准备后才换入独立安装目录，并用 `codex mcp add` 管理用户级 MCP 注册；升级前备份数据与旧安装，后续步骤失败时回滚。宿主安装文件保持不变。

`open_output_items` 的 `_meta` 使用当前客户端识别的三组信息：

- `ui.resourceUri = ui://output-items/dashboard.html`
- `ui.visibility` 包含 `app`
- `openai/ui.entrypoints = [{ type: global }]`

这些元数据可以被 MCP 宿主读取，但 Codex Desktop 是否把本地 `global` 入口放入“自定义”还受未公开的灰度开关控制。扩展不修改宿主文件，也不尝试强制打开该开关。

界面构建产物在 `ui/`。MCP 读取资源时会把 CSS 与 JavaScript 内联为一个 `text/html;profile=mcp-app` 资源；独立模式则从同一目录按静态文件提供。主题桥在 React 渲染前设置 `documentElement.dataset.theme`：MCP 优先读取 `window.openai.theme` 并监听 `openai:set_globals`，伴生模式由宿主注入层传递首帧快照及后续变更，独立模式回退到 `prefers-color-scheme`。深浅色仅替换语义色彩 token，不改变尺寸、网格和响应式断点。启动器读取 `run/server.json` 复用健康实例，否则启动新实例。服务只绑定环回地址并使用动态端口，不开放 CORS；写操作校验 Host、Origin、Fetch Metadata、JSON 类型和 64 KiB 请求体上限。

## 主动扫描与归并

扫描由“产出项”服务自身发起，不依赖会话或 agent 在任务结束时调用登记工具。首次运行流式处理历史会话完成回填，后续通过 `data/scanner.json` 保存的文件位置、大小和更新时间做增量读取；自动扫描与界面的“立即扫描”走同一条带互斥保护的扫描通道。

`state_*.sqlite` 只用于读取任务元数据和父子关系。扫描器沿任务树把 subagent 产出归并到最上层用户任务；没有正常父任务的 guardian、系统维护任务不会作为产出来源。会话证据用于确认实际写入、更新、生成或最终交付的路径，而不是把对话中随意出现的路径都当作产出。

路径分组先识别项目标记和 `outputs` 子项目：单个文档、图片等保持为文件项，多文件程序与文件组显示为文件夹项，生成图片和可视化按任务成组。扫描排除 `Temp`、缓存、依赖目录和 Codex 内部运行文件。

同一根任务、目标路径与产出组会合并为一个产出项；新任务轮次的修改追加版本记录。扫描不会因为文件当前缺失而删除索引，而是保留历史并将状态更新为已删除。用户人工状态独立保存，自动检测不会覆盖人工标记。

每个产出项同时返回稳定的 `taskGroup`：根任务 ID、任务标题、项目、项目类型、工作区和主机信息。前端以根任务 ID 为上级分组键，同一根任务的多个文件或程序显示在同一任务组中；subagent 仍保留生产者信息，但“打开任务”指向根任务。扩展自身登记只接受运行时真实 UUID：内部路径严格按合法 `CODEX_THREAD_ID`、合法请求 `threadId`、合法显式 `OUTPUT_ITEMS_SOURCE_THREAD_ID` 的顺序选择；没有真实任务上下文时归入 `local-install`/`unknown` 组且 `rootThreadId=null`，不会用 manifest 或常量伪造任务。公开 `register_output_item` 工具仍强制要求合法 `threadId`，无来源自登记仅通过未公开的内部 JSON-RPC 路径执行。安装器只让一次性 `register-self` 继承当前任务上下文；启动长驻 HTTP、companion 及其管理的 ChatGPT 前会临时清空两个任务环境变量，并在创建子进程后精确恢复父进程环境。

每次扫描还会执行一次轻量任务目录元数据对账，与是否读到新的会话产出证据无关。标题优先采用 `session_index.jsonl` 中按 `updated_at` 选出的最新非空名称，同时间戳以靠后的记录为准；索引没有有效名称时才回退到最新 `state_*.sqlite`，并通过 `PRAGMA table_info(threads)` 兼容探测列，存在 `name` 时优先于旧 `title`，不会硬查询不存在的列。对账沿任务树读取根用户任务标题，因此 subagent 产出与同任务的多个产出项会一起更新。纯重命名只写 `taskGroup.title` 和 `taskGroup.titleSyncedAt`，不新增版本、不修改产出项 `updatedAt`、优先级、活动或历史版本来源；标题未变化时不重写 `items.json`。已经删除而在界面隐藏的整组记录仍参与对账，索引缺失或未知来源则保留最后已知标题。

## 文件操作与排序

文件资源管理器定位、单文件删除、整项目删除、优先级和批量操作都通过同一个本地服务完成。项目清单递归记录子目录内的当前文件（跳过依赖、版本控制目录与链接），因此嵌套文件也可单独定位或删除。每条文件记录保存 `sizeBytes`；文件夹用一次后序遍历聚合后代文件大小，并以 `aggregationComplete` 标明统计是否完整。旧数据首次加载时在数据锁内补齐并持久化，后续列表读取不会重复全量扫描。目标必须来自当前产出项已经登记的根路径或文件清单；相对路径越界、符号链接越界、网络共享、驱动器根目录、用户目录、工作区根目录、Codex 数据目录和扩展自身目录都会被拒绝。

“打开位置”在上述登记路径、canonical containment 与链接检查全部通过后才启动 Explorer：目录直接打开，文件使用参数化 `/select,`。随后独立 PowerShell helper 轮询 `Shell.Application.Windows()`，只把 `Document.Folder.Self.Path` 规范化后与目标目录完全相等的窗口 HWND 作为候选；不会按窗口标题、前缀或模糊文本匹配。helper 对该 HWND 执行 Show/Restore/Foreground，并以 `GetForegroundWindow` 复核。子进程全部使用 `shell:false` 与参数数组；返回值分别报告 `launched`、`foreground` 和 `error`，所以 Explorer 已打开但未能前置不会被伪装为完整成功。

前端保持后端扁平 `relativePath` 契约，在内存中构建层级树。每一级都使用稳定分桶把文件夹放在普通文件之前，文件夹之间与文件之间继续保持原始顺序。文件夹初始为收起状态；只有用户展开的节点及其直接子项进入可见列表，下一层仍保持收起，从而避免一次渲染全部深层文件。

文件预览复用同一套已登记路径解析：调用方只能提交 `item.id` 与 `relativePath`，相对路径必须精确存在于当前 `item.files`，服务随后验证普通文件、canonical containment 以及从根到目标没有符号链接或目录联接。MCP 工具 `preview_output_item_file` 仅对应用 UI 可见；HTTP 使用 `POST /api/items/:id/preview`，沿用 Host、Origin、opaque iframe token、JSON 类型和请求体上限保护。响应不含绝对路径或 `file://` URL，内容不写日志。

图片仅接受 PNG、JPEG、WebP、GIF 与 BMP，扩展名和 magic 必须一致；单文件最多 12 MiB、单边最多 16384 像素、总像素最多 4000 万。文本最多读取前 512 KiB并最多返回 5000 行，仅接受 UTF-8 或带 BOM 的 UTF-16LE/BE。HTML、SVG、Shell、PowerShell、批处理和 JavaScript 等即使允许查看，也统一返回 `text/plain`、`renderMode: plain-text` 与 `inert: true`，客户端不得用 `innerHTML`、`srcdoc`、`object`、`embed` 或可执行 iframe 渲染。

删除权限只来自自动扫描版本中的可信来源范围：工作区产出必须严格位于来源 `cwd` 内，Codex 管理产出仅允许 `generated_images` 与 `visualizations` 的子项；外部路径或单纯 MCP 手工登记默认不可删除。服务使用 canonical realpath 做授权和保护比较，并从盘符根到目标检查目录联接/符号链接。生产环境的删除只使用本地固定磁盘上的 Windows 回收站，PowerShell 辅助进程会再次验证允许根、受保护目录和重解析点；单项与批量删除都要求 `confirm:true`。删除不会移除索引，而会更新系统状态并追加活动记录。

产出项优先级保存为 `critical`、`high`、`normal`、`low` 或 `none`。服务端和前端先把正常项与已删除项分桶，正常项始终在前、已删除项始终沉底；优先级降序和最近更新时间降序只在同一删除状态桶内生效。批量接口逐项返回成功或失败，父子项目同时删除时只回收最上层目标。

批量选择属于显式模式：普通浏览时不渲染选择框，用户点击“批量操作”后才显示多选与批量工具；单次最多处理 50 项。筛选条件变化会清除隐藏选择，破坏性确认会列出真实项目名称和路径。

## 写入边界与兼容性

扫描器只读访问 Codex 的 `state_*.sqlite`、`sessions`、`archived_sessions`、`generated_images` 和 `visualizations`。索引过程只写扩展自身的 `data/scanner.json`、`data/items.json` 与 `logs/events.ndjson`；HTTP 服务、伴生程序和安装器另在同一个隔离数据根目录维护运行状态与独立 profile，并只管理明确列出的 MCP 注册和可选快捷方式。

该扫描器是针对本机当前 Codex 私有数据结构的兼容实现，而不是官方稳定扩展接口。Codex 升级如果改变数据库表或会话事件格式，解析器可能需要随版本适配；任何适配都应继续保持对 Codex 数据只读。

## GitHub 上传边界

`scripts/github-publisher.mjs` 将 GitHub 环境读取、预检和异步任务封装在独立适配层中。HTTP 与 MCP 使用同一契约：`context`、`preflight`、`start`、`job status`、`cancel`。真实适配器在同一进程环境中依次执行 `gh auth status --json hosts` 和只读 `gh api user`；只有活动登录状态成功、API 调用成功且两者账号一致时才返回 `ready=true`，否则只返回经过遮蔽的 `authError`。所有外部写入都要求未过期且与当前配置摘要一致的预检 ID，以及 `confirm:true`；服务在任务开始前再次扫描源文件，防止用户在预检后切换配置。

真实适配器只以 `shell:false` 和参数数组调用官方 `gh` 与 Git。owner、repo、branch、产出项 ID 和相对路径均有白名单或边界验证；只允许当前 `gh` 登录账号拥有且具有 `ADMIN` 权限的个人仓库。新仓库不会传入 team/collaborator 参数；已有仓库不会修改现有访问权限。源路径先解析 realpath，再与系统、程序安装、扩展数据和用户根目录比较，防止通过祖先 junction 绕过保护。

预检为每个文件记录大小、修改时间与 SHA-256；任务启动时要求文件集合摘要不变。异步任务首先在纯本地进程隔离暂存区复制并复检，任何源变化、新 secret 或大小变化都会在调用 `createRepository`/push 前阻断。只有本地复检成功后才克隆/创建远端仓库并把 payload 合并到仓库暂存副本。已有仓库默认使用 `codex-output-items/<item-id>` 子目录；显式根目录写入会预警，实际覆盖路径在结果中返回。

暂存根采用 `process-<pid>-<nonce>` 隔离并含 owner 标记。正常退出只删除身份匹配的本进程目录；启动恢复只删除 PID 已失效的合法子目录，活跃进程目录保持不动。命令输出、错误和事件日志在入库前会遮蔽 GitHub token、Authorization 值与 URL 凭据。

预检按文件名、目录、文件类型、大小和文本内容扫描敏感信息。文本采用分块流式扫描；二进制无法使用文本规则时明确 warning 并继续做名称、大小和 SHA-256 校验。已知敏感文件与依赖目录直接排除；疑似凭据、私钥、超过 GitHub 100 MiB 的单文件或超过扩展安全总量的选择形成不可绕过的 blocker。Public、直接写默认分支、未保护主分支、无许可证和 50 MiB 以上文件形成 warning。可选分支保护失败会作为任务结果 warning 返回，不会伪装成功配置。

实现依据以官方资料为准：[gh auth status](https://cli.github.com/manual/gh_auth_status)、[gh api](https://cli.github.com/manual/gh_api)、[gh repo create](https://cli.github.com/manual/gh_repo_create)、[gh repo list](https://cli.github.com/manual/gh_repo_list)、[gh pr create](https://cli.github.com/manual/gh_pr_create)、[GitHub 普通 Git 文件大小限制](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)及[个人仓库访问权限](https://docs.github.com/en/get-started/learning-about-github/access-permissions-on-github)。

## 公开仓库与 Release 边界

公开仓库按 `extension/`、`web/`、`installer/`、`tests/`、`build/` 和 `docs/` 分离源代码。`web/src` 是界面事实来源，`web/dist` 和仓库根 `dist` 都是可重建产物，不手工编辑、不提交依赖目录。运行时 Release 布局继续保持 `server.mjs`、`scripts/`、`companion/` 与 `ui/`，从而不改变服务端相对导入和双击启动器契约。

`build/release-files.json` 是运行时白名单。构建器只复制精确列出的文件，并只收集生成 HTML 实际引用的 JS/CSS；真实截图、工作目录、用户数据、依赖缓存和其他仓库内容不会进入 staging。随后生成 SPDX SBOM 和不自引用的逐文件哈希清单，使用固定 ZIP 时间戳打包，并在全新临时目录解压后重新校验清单、隐私规则、UI 引用和隔离自检。
