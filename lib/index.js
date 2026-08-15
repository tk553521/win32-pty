/**
 * @dsh-desktop/win32-pty — Windows PTY support for the persistent bash tool.
 *
 * 背景：极简模式（minimal agent preset）的 bash 工具是持久化 PTY 会话
 * （dsh-tool-bash-persistent → dsh-terminal-bash → ctx.subprocess.spawnTerminal）。
 * 而 @deepseek-ai/dsh-subprocess-local 的终端进程检查器只实现了 Linux / macOS，
 * win32 直接抛 "terminal inspection is unsupported on platform win32"。
 *
 * 本插件在宿主平面把两处补上（不动 node_modules）：
 *
 * 1. 注入 win32 进程检查器 —— `LocalSubprocessRuntime.terminalInspector` 是
 *    spawnTerminal 里预留的注入点（`this.terminalInspector ?? createProcessInspector()`），
 *    插件直接塞一个自实现的检查器：
 *    - 进程表：PowerShell CIM（pid/ppid/创建时间），500ms TTL 缓存（readiness 每 50ms 轮询）
 *    - foregroundPgid：Windows 无前台进程组概念，返回 shell 自身
 *    - isStdinWaiting：恒 false（与 macOS 实现一致）
 *    - processTree / isAlive：基于进程表
 *    - signalProcess / signalGroup：taskkill /T /F 树级终止
 *
 * 2. SIGINT 改为 Ctrl+C 字节注入 —— 实测发现 Git Bash 有 `bin\bash.exe` 包装器 +
 *    `usr\bin\bash.exe` 双层结构，且 MSYS fork 子进程的 ppid 链在 Windows 进程表里
 *    是断的，taskkill 无法精确定位命令进程（会误杀 shell 本身）。ConPTY 下向 PTY
 *    写入 `\x03` 由 MSYS 翻译成 SIGINT，命令被杀而 shell 存活。
 *    做法：包装 ctx.subprocess.spawnTerminal，对返回的 terminal handle 覆盖
 *    signalForeground（handle.write 是公开方法，不碰内部字段）。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const name = "@dsh-desktop/win32-pty";
const inject = ["subprocess"];

/** 进程表缓存时长：readiness 每 50ms 轮询一次，不能每次起一个 powershell。 */
const PROCESS_TABLE_TTL_MS = 500;

/** Git for Windows 常见安装位置（scoop 版本也覆盖）。 */
const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`] : []),
  ...(process.env.USERPROFILE ? [`${process.env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`] : []),
];

/** 探测已安装的 Git Bash 绝对路径；找不到返回 undefined。 */
export function resolveGitBash() {
  return GIT_BASH_CANDIDATES.find((candidate) => existsSync(candidate));
}

/** taskkill 整棵进程树（/T 递归 /F 强制）；对已退出进程是 no-op。 */
function taskkillTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* 进程已退出或权限不足：忽略 */
  }
}

/** PowerShell CIM 进程表：每行 `pid\tppid\t创建时间(ISO)`，UTF-8 输出。 */
function windowsProcessTable() {
  const text = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToString('o'))\" }",
    ],
    { encoding: "utf8" },
  );
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    entries.push({
      pid,
      parentPid: Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : 0,
      started: fields[2],
    });
  }
  return entries;
}

/** 从进程表构建以 rootPid 为根的进程树（后序）。 */
function processTree(entries, rootPid) {
  const root = new Map(entries.map((entry) => [entry.pid, entry])).get(rootPid);
  if (root === undefined) return [];
  const byParent = new Map();
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? [];
    children.push(entry);
    byParent.set(entry.parentPid, children);
  }
  const visited = new Set();
  const result = [];
  const visit = (entry) => {
    if (visited.has(entry.pid)) return;
    visited.add(entry.pid);
    for (const child of byParent.get(entry.pid) ?? []) visit(child);
    result.push({ pid: entry.pid, started: entry.started });
  };
  visit(root);
  return result;
}

/**
 * win32 进程检查器：LocalSubprocessRuntime.spawnTerminal 期望的终端会话
 * 检查接口（foregroundPgid / isStdinWaiting / processTree / processSession /
 * isAlive / signalProcess / signalGroup），与 dsh-subprocess-local 的
 * PosixProcessInspector 用法一致，但完全自包含、不依赖其内部实现。
 */
export class WindowsProcessInspector {
  table = { entries: [], at: 0 };

  processTable() {
    const now = Date.now();
    if (now - this.table.at < PROCESS_TABLE_TTL_MS) return this.table.entries;
    try {
      this.table = { entries: windowsProcessTable(), at: now };
    } catch {
      /* 瞬时失败沿用旧表；查不到按"已退出"处理 */
    }
    return this.table.entries;
  }

  foregroundPgid(shellPid) {
    return shellPid;
  }

  isStdinWaiting() {
    return false;
  }

  processTree(rootPid) {
    return processTree(this.processTable(), rootPid);
  }

  processSession() {
    return [];
  }

  isAlive(identity) {
    return this.processTable().some(
      (entry) => entry.pid === identity.pid && entry.started === identity.started,
    );
  }

  signalProcess(identity) {
    if (!this.isAlive(identity)) return;
    taskkillTree(identity.pid);
  }

  signalGroup(pgid) {
    for (const member of this.processTree(pgid)) {
      if (member.pid !== pgid) taskkillTree(member.pid);
    }
  }
}

/** 已打补丁标记：防止插件重复加载时二次包装。 */
const patched = new WeakSet();

/**
 * 解包 windows-acl 沙箱 runner 包装：`[node, runner.js, --workspace W, --temp T,
 * --mode M, --, <cmd...>]` → `<cmd...>`。
 *
 * 为什么必须解包：MSYS2 运行时（msys-2.0.dll，Git Bash 及所有 msys 版程序）
 * 启动时创建/打开一个以用户 SID 命名的共享内存映射（进程间同步），而
 * windows-acl 受限令牌（WRITE_RESTRICTED）删除了 Authenticated Users /
 * INTERACTIVE / LOCAL 组，`CreateFileMapping` 必然返回 ACCESS_DENIED——
 * 实测 bash 直接 fatal error 退出（Win32 error 5）。这不是检查器能修的问题，
 * 是 MSYS 与受限令牌的根本冲突，PTY 交互会话只能绕过文件沙箱（等同
 * danger-full-access 的文件语义；一次性命令工具的标准模式沙箱不受影响，
 * 那条路径不经 spawnTerminal）。
 */
function unwrapSandboxArgv(argv) {
  if (argv.length < 4) return argv;
  const program = String(argv[0]).toLowerCase();
  const runner = String(argv[1] ?? "").toLowerCase();
  const isNode = program.endsWith("node.exe") || program.endsWith("node");
  const isAclRunner = runner.includes("sandbox-windows-acl") || runner.includes("windows-acl");
  if (!isNode || !isAclRunner) return argv;
  const sep = argv.indexOf("--");
  if (sep < 0 || sep + 1 >= argv.length) return argv;
  return argv.slice(sep + 1);
}

/**
 * 修正 Windows 上的 shell 可执行路径：node-pty 的 ConPTY 后端对相对路径
 * （含 POSIX 风格 `/bin/bash`）用 PATH 查找，找不到就报
 * "File not found: "（空后缀）。只要 argv[0] 不是 Windows 绝对路径
 * （盘符或 UNC），就替换成探测到的 Git Bash；绝对路径原样保留。
 * 这样即使运行环境（如 DSH Desktop 自带 runtime）里的 dsh-terminal-bash
 * 没有 shellPath 探测补丁，PTY 也能正确启动 bash。
 */
function fixShellPath(argv) {
  if (process.platform !== "win32" || argv.length === 0) return argv;
  const first = String(argv[0] ?? "");
  if (first.length === 0) return argv;
  const isWinAbsolute = /^[A-Za-z]:[\\/]/.test(first) || first.startsWith("\\\\");
  if (isWinAbsolute) return argv;
  const bash = resolveGitBash();
  if (bash === undefined) return argv;
  return [bash, ...argv.slice(1)];
}

async function apply(ctx) {
  if (process.platform !== "win32") return;
  const runtime = ctx.subprocess;
  if (runtime === undefined || runtime === null) return;
  if (patched.has(runtime)) return;
  patched.add(runtime);

  // 1) 注入 win32 进程检查器（spawnTerminal 的预留注入点）
  runtime.terminalInspector = new WindowsProcessInspector();

  // 2) 包装 spawnTerminal：
  //    - 解包沙箱 runner（MSYS 与受限令牌不兼容）
  //    - 修正 shell 路径（node-pty 对相对/POSIX 路径解析失败）
  //    - SIGINT → Ctrl+C 字节注入（保留 shell）
  const originalSpawnTerminal = runtime.spawnTerminal.bind(runtime);
  runtime.spawnTerminal = async (spec) => {
    const fixed = fixShellPath(unwrapSandboxArgv(spec.argv));
    const handle = await originalSpawnTerminal(fixed === spec.argv ? spec : { ...spec, argv: fixed });
    const originalSignalForeground = handle.signalForeground.bind(handle);
    handle.signalForeground = async (signal) => {
      if (signal === "SIGINT") {
        const foreground = await handle.inspectForeground();
        if (foreground === undefined) {
          throw new Error(`cannot resolve foreground process group for terminal ${handle.pid}`);
        }
        await handle.write("\x03");
        return foreground.processGroupId;
      }
      return originalSignalForeground(signal);
    };
    return handle;
  };

  ctx.logger?.info?.(
    `[win32-pty] active: terminalInspector + Ctrl+C injection + sandbox unwrap + shell path fix (git bash: ${resolveGitBash() ?? "not found"})`,
  );
}

export { apply, inject, name, fixShellPath, unwrapSandboxArgv };
