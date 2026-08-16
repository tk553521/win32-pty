# @dsh-desktop/win32-pty

**DSH 极简模式（minimal agent preset）的 Windows 支持插件。**

让极简模式的持久化 PTY bash 工具在 Windows 上可用——注入 win32 进程检查器、
解包沙箱 runner、修正 Git Bash 路径、SIGINT 改 Ctrl+C 注入。纯插件实现，不动
node_modules，符合 DSH 万物皆插件的设计哲学。

## 背景

极简模式（`minimal` agent preset）的 bash 工具是持久化 PTY 会话
（`dsh-tool-bash-persistent` → `dsh-terminal-bash` → `ctx.subprocess.spawnTerminal`）。
在 Windows 上原本有三道坎，逐一报错：

1. `subprocess-local: terminal inspection is unsupported on platform win32`
   —— `@deepseek-ai/dsh-subprocess-local` 的终端进程检查器只实现了 Linux / macOS
2. `bash: *** fatal error - CreateFileMapping ... Win32 error 5`
   —— MSYS2 运行时与 windows-acl 受限令牌沙箱的根本冲突
3. `File not found: `（空后缀）—— node-pty 对默认 shellPath `/bin/bash`
   （相对路径）按 PATH 查找失败

本插件把三道坎全部解决。

## 插件做了什么

1. **注入 win32 进程检查器**：利用 `LocalSubprocessRuntime.terminalInspector`
   预留注入点（`spawnTerminal` 里 `this.terminalInspector ?? createProcessInspector()`），
   塞入自实现检查器：
   - 进程表：PowerShell CIM（pid/ppid/创建时间），500ms TTL 缓存
   - `foregroundPgid` 返回 shell 自身；`isStdinWaiting` 恒 false
   - `processTree` / `isAlive` 基于进程表；`signalProcess` / `signalGroup` 用
     `taskkill /T /F` 树级终止
2. **解包 windows-acl 沙箱 runner**：MSYS2 运行时（msys-2.0.dll）启动时创建/打开
   以用户 SID 命名的共享内存映射（`CreateFileMapping`），而沙箱的受限令牌
   （WRITE_RESTRICTED）删除了 Authenticated Users / INTERACTIVE / LOCAL 组，
   必然 ACCESS_DENIED——bash 直接 fatal error 退出。这是 MSYS 与受限令牌的
   根本冲突，PTY 交互会话只能绕过文件沙箱（等同 danger-full-access 的文件
   语义；标准模式一次性命令的沙箱不受影响，那条路径不经 `spawnTerminal`）。
3. **修正 shell 路径**：node-pty 的 ConPTY 后端对相对路径（含 POSIX 风格
   `/bin/bash`）按 PATH 查找，找不到报 `File not found: `（空后缀）。只要
   argv[0] 不是 Windows 绝对路径就替换成探测到的 Git Bash——这样即使运行
   环境（如 DSH Desktop 自带 runtime）里的 dsh-terminal-bash 没有 shellPath
   探测补丁，PTY 也能正确启动。
4. **SIGINT 改为 Ctrl+C 字节注入**：实测发现 Git Bash 是 `bin\bash.exe` 包装器 +
   `usr\bin\bash.exe` 双层结构，且 MSYS fork 子进程的 ppid 链在 Windows 进程表里
   是断的，taskkill 无法精确定位命令（会误杀 shell）。ConPTY 下向 PTY 写 `\x03`
   由 MSYS 翻译成 SIGINT：命令被杀、shell 存活。做法是包装
   `ctx.subprocess.spawnTerminal`，覆盖返回 handle 的 `signalForeground`
   （只调公开的 `handle.write`，不碰内部字段）。

> ⚠️ 修改插件代码后仍需要**重启 DSH**（或重新安装/同步 node_modules）才生效：
> Cordis HMR 只热重应用 `cordis.patch.yml` 的 patch 列表，不会重载 node_modules
> 里已加载模块的代码。插件自身已注册 `ctx.effect` 清理，所以面板里的热禁用/启用
> 不需要重启；但直接改 `lib/index.js` 后仍要重启/重装。

## 已知现象：可稳定复现的 "we need" 思维链

使用本插件让极简模式在 Windows 上跑通后，可以**稳定复现** deepseek-v4-pro
模型的一个思维链特征：

- **现象**：极简模式（固定 system prompt：`You are a helpful software engineer assistant.`）
  下，deepseek-v4-pro 收到「帮我审核代码」等请求时，**推理（reasoning）内容稳定以
  "We need ..." 开头**。
- **复现步骤**：
  1. DSH 会话选极简模式（或「极简模式（Windows Git Bash）」），模型选 deepseek-v4-pro
  2. 发送「帮我审核代码」
  3. 打开思维链视图——reasoning 第一句即为 `We need ...`
- **日志证据**：两个独立会话（`session-392b013e`、`session-58cac438`）的 reasoning
  首句几乎逐字相同：

  ```
  We need respond to user asking "帮我审核代码" (help me review code). ...
  We need inspect repo. ...
  We need likely review a code repository. ...
  ```

- **说明**：这是模型行为特征（固定 system prompt 下的稳定产物），与本插件逻辑
  无关；但插件是它在 Windows 上被观察到的前提——极简模式跑不通时根本看不到。

## 组成

```
win32-pty/
├── package.json          # 插件包（通过 cordis.patch.yml insert 注册）
└── lib/index.js          # cordis 插件（inject subprocess，win32 生效）
```

配套的自定义 agent 预设（随 DSH 重启被扫描发现）：

```
~/.dsh/.agent-presets/win32-minimal/
├── agent.cordis.yml      # 复制 minimal + terminal-bash.shellPath 指向 Git Bash
└── preset.yml            # 显示名「极简模式（Windows Git Bash）」
```
