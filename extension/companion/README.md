# 产出项 Windows Codex 伴生注入层

此目录是一个无第三方依赖的实验性 Windows 伴生层。它启动 Microsoft Store 官方 Codex 的独立 `ChatGPT.exe` 实例，通过私有 `--remote-debugging-pipe` 注入“产出项”侧栏入口，并把已有 loopback UI 嵌入 Codex 主工作区。启动器打开页面后还会调用 `focus-managed-codex.ps1`：先校验伴生 PID、`ChatGPT.exe` 路径与独立 profile，再只在该 PID 的进程树内寻找顶级窗口，将隐藏或最小化窗口恢复到桌面并验证其已成为 Windows 前台窗口。

桌面启动事务由按 Windows 用户 SID 与 run-file 派生的 `Global\` 命名互斥锁串行化，因此同一用户的控制台与 RDP session 也不能并发冷启动同一独立 profile。启动器在创建 resident 前原子写入 `starting` 状态；resident 以随机 instance nonce 接管该状态。即使启动 PowerShell 在 resident 写入完整状态前异常退出，后续启动器也会等待接管或有界清理，不会立即创建第二个实例。窗口激活使用贯穿 CDP 扫描、注入、窗口恢复和原生聚焦的 30 秒绝对 deadline；Node 控制客户端从进程身份校验到管道响应共用 45 秒 deadline，PowerShell 控制器等待 50 秒，不会在 handler 仍可继续聚焦时提前报告超时。

它不会编辑 Codex 安装目录、`app.asar` 或正常 Codex profile。注入只存在于由伴生进程启动的独立 Codex 实例中；停止伴生进程时会先移除 DOM 与 document-start 注册，再关闭该独立实例。

## 命令行

```powershell
node .\companion\codex-companion.mjs `
  --url http://127.0.0.1:4173/ `
  --profile "$env:LOCALAPPDATA\CodexOutputItems\companion\codex-profile" `
  --run-file "$env:LOCALAPPDATA\CodexOutputItems\run\companion.json" `
  --log "$env:LOCALAPPDATA\CodexOutputItems\logs\companion.log" `
  --open
```

可用参数：

- `--url` / `--ui-url`：必需，只接受 `127.0.0.1`、`localhost` 或 `::1` 的 HTTP(S) URL。若 URL 尚未包含嵌入参数，伴生层会追加 `embedded=1&host=codex-companion`；传入服务状态中的完整 `companionUrl` 时不会重复追加。
- `--profile`：独立 Codex profile；默认 `%LOCALAPPDATA%\CodexOutputItems\companion\codex-profile`。
- `--run-file`：单实例状态文件；默认 `%LOCALAPPDATA%\CodexOutputItems\companion\companion.json`。
- `--log`：可选日志文件。
- `--codex-exe`：可选官方 `ChatGPT.exe` 路径；省略时通过 `Get-AppxPackage -Name OpenAI.Codex` 查找。
- `--instance-nonce`：启动器内部使用的 16-128 位 base64url 实例标识。它会进入 resident 的精确 argv 与原子运行状态，用于强制停止前防止 stale PID/进程重用误判；日常不需要手工传入。
- `--open`：首次注入后立即打开产出项，并恢复、聚焦经身份校验的伴生 Codex 原生窗口。相同 run-file 已有实例时，此命令通过命名管道复用并聚焦既有窗口后退出，不会启动第二个实例。
- `--activate`：只激活已有实例。
- `--ping`：通过带随机控制令牌的命名管道只读确认伴生实例健康；不启动、停止或激活窗口。
- `--stop`：通过命名管道请求已有实例优雅停止。
- `--self-test`：读取并校验随附的注入脚本，同时对子进程树/profile 参数识别和 Win32 helper 加载进行隔离测试；不会启动、停止或聚焦任何 Codex/用户窗口。

对应环境变量为 `CODEX_OUTPUT_ITEMS_UI_URL`、`CODEX_OUTPUT_ITEMS_PROFILE`、`CODEX_OUTPUT_ITEMS_RUN_FILE`、`CODEX_OUTPUT_ITEMS_LOG`、`CODEX_OUTPUT_ITEMS_CODEX_EXE` 和内部使用的 `CODEX_OUTPUT_ITEMS_INSTANCE_NONCE`。

非 GUI 安全回归可运行 `powershell.exe -NoProfile -File .\scripts\launcher-safety-self-test.ps1`。fixture 只使用系统临时目录和当前 PowerShell 测试进程，验证 Global mutex 可创建、`starting` 状态原子写入、过期等待有界，以及 stale run-file 停止不会等待或终止无关进程；不会启动、停止、安装或聚焦真实 Codex。

## 宿主协议

嵌入页可向父窗口发送：

```js
window.parent.postMessage({
  type: "output-items:open-thread",
  requestId: crypto.randomUUID(),
  threadId: "00000000-0000-4000-8000-000000000000",
}, "*");
```

注入层只接受来自当前 iframe 的消息，并要求 `threadId` 是 UUID。它优先点击 Codex 现有任务行；找不到时才请求 Codex 内部路由 `/local/<threadId>`。iframe 会收到明确结果：

```js
{
  type: "output-items:open-thread-result",
  requestId,
  threadId,
  ok: true | false,
  error?: string,
}
```

## 宿主标题栏处理

“产出项”激活时，注入层会暂时隐藏 Codex 主内容标题栏中会覆盖 iframe 的宿主控件，包括上下文操作区、居中的 home-mode 控件及其后的尾部操作插槽。定位以 `[data-app-shell-application-menu-bar]` 为作用域，并使用 Codex 自带的 `data-testid` / `data-test-id` 与结构顺序判断；不会隐藏整个标题栏、应用菜单或原生窗口控制区，因此窗口拖动和系统最小化、最大化、关闭仍由 Codex 正常处理。

这些节点只会在 `data-codex-output-items-open="true"` 时不可见。切换到任务、插件等原生页面或停止伴生层时，注入脚本会移除自己添加的属性并完整恢复宿主控件。

## 导航与挂载生命周期

每次显式打开“产出项”时，注入层会记录当时的 Codex 主内容 surface 与路由。激活中的 iframe 只属于这一次宿主上下文；任意非产出项宿主控件点击、路由变化、surface 断开或替换都会先关闭 iframe、恢复原生内容与导航选中态。`MutationObserver` 只负责刷新当前上下文，绝不会把激活中的 iframe 迁移到设置页或其他新 surface。

`lifecycle-fixture.html` 提供不连接真实 Codex 的最小宿主 DOM，覆盖设置入口位于主侧栏之外、程序化替换 surface、`data-testid` / `data-test-id` 两种标题栏插槽和原生窗口控制区保留等回归场景。`--self-test` 会同时验证该 fixture 与生命周期守卫仍然存在。

## 兼容性与安全边界

- 菜单定位依赖 Codex 当前 DOM 中的“插件 / Plugins”按钮及若干 `data-app-*` 标记；Codex 更新可能使注入失效。
- `Page.setBypassCSP` 只作用于独立 Codex renderer，但仍会削弱该实例的 CSP。仅应运行可信的本地 UI 与伴生代码。
- UI 服务必须允许被 iframe 嵌入；若响应包含 `X-Frame-Options: DENY`，浏览器仍可能拒绝显示。
- 私有 CDP pipe 不开放 TCP 调试端口，但伴生进程本身对这个独立 renderer 拥有完整 CDP 权限。
- 单实例控制管道要求运行状态文件中的随机令牌，并拒绝超过 4 KiB 的控制消息。
- stale run-file 如果不能通过精确 companion 脚本 argv、instance nonce 与进程启动时间校验，只会清理对应状态并直接返回；强制停止只对再次通过三项校验的 Node resident 执行。旧版无 nonce 状态仍可通过健康控制管道优雅停止，但不会进入强制终止路径。
- 停止、安装前停止和卸载前停止与冷启动共用同一个 Global mutex；如果用户在 `starting` 阶段发起停止/卸载，它会先等待启动事务稳定，再处理已确认的 resident，避免删除安装文件时仍有新实例生成。
- 原生窗口恢复不按标题搜索。helper 必须同时确认受管根 PID 是运行状态中记录的 `ChatGPT.exe`、命令行包含完全一致的独立 `--user-data-dir`，且目标顶级窗口属于该 PID 或其后代；身份不一致时明确失败，不会尝试操作普通 Codex 窗口。
