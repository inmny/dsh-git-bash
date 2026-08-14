# dsh-plugin-git-bash

让 DeepSeek Harness 在 Windows 上默认使用 Git for Windows 自带的 Bash，并兼容 DSH 的 `read-only`、`workspace-write` 和 `danger-full-access` 权限模式。

## 行为

- 自动探测 Program Files、用户安装和 Scoop 中的 Git Bash。
- 可通过 `DSH_GIT_BASH_PATH` 指定 `bash.exe`。
- 前台命令、后台命令和 Web Agent preset 使用同一个 Git Bash executor。
- `standard`、`code`、`cordis` 和 `minimal` preset 中的 PowerShell 工具会被 Git Bash 工具遮蔽。
- 插件不修改 DSH 安装目录；它作为 bundle layer 安装到指定 profile。

## 权限模式

### `read-only` 和 `workspace-write`

受限命令仍由 DSH 的 Windows ACL sandbox 建立 `WRITE_RESTRICTED` token。插件把 native guard 作为该 sandbox 内的第一层进程，再由 guard 启动 Git Bash：

```text
DSH ACL runner -> msys-token-guard.exe -> bash.exe -> child processes
```

Git for Windows 的 MSYS runtime 会创建共享 mapping、signal pipe 等 IPC 对象，并尝试重置 token default DACL。`msys-token-guard.exe` 和 companion hook 只处理这组 MSYS 兼容性问题：

- 校验 guard 和 Bash 的 restricting SID 集合一致。
- 要求 logon SID 本身位于 restricting SID 集合中。
- 给 MSYS IPC 使用的 default DACL 增加 logon SID。
- 在恢复 Bash 和每个受 hook 传播的 child 前拒绝 `TOKEN_ADJUST_DEFAULT`。
- 只把来自 `msys-2.0.dll` 的 `Administrators + GENERIC_ALL` IPC ACE 替换为当前 logon SID。
- setup、DLL 注入或 token invariant 失败时终止 suspended child，并以 `125` fail closed。

外层 DSH sandbox 仍是权限边界。插件不会增加 user SID 到 restricting SID 集合，不会提权，不会创建 unrestricted broker，也不会使用 `CREATE_BREAKAWAY_FROM_JOB`。因此：

- `read-only` 可以运行 Git Bash，但不能写 workspace。
- `workspace-write` 只能写 DSH 授权的 workspace 和 private temp，不能写 workspace 外部。
- Windows ACL backend 原有的 hard-link 限制不变，结果会继续报告 `enforcement: partial`。

### `danger-full-access`

该模式不经过 native guard，直接运行 Git Bash，行为与插件 0.1.x 一致。

## 平台要求

运行时要求：

- Windows x64
- Node.js 24 或更高版本
- DSH `0.1.0-rc.6`
- Git for Windows x64

npm 包包含预编译的 `msys-token-guard.exe` 和 `msys-token-guard-hook.dll`，普通安装不需要 Visual Studio 或 CMake。当前 native guard 仅支持 `win32-x64`；其他架构在受限模式下会返回 `SANDBOX_UNAVAILABLE`，不会退回到未隔离执行。

Microsoft Detours 4.0.1 源码按 MIT 许可 vendored 在 `native/vendor/detours`，许可文本随 npm 包分发。Detours 的 DLL path 参数使用 Windows ANSI API，因此插件安装路径必须能由当前系统代码页无损表示，且不能超过 `MAX_PATH`；不满足时 guard 会 fail closed。

## 安装到 DSH

从 npm 安装到 Web profile：

```powershell
dsh plugin --profile web add dsh-plugin-git-bash
```

也可以安装指定版本：

```powershell
dsh plugin --profile web add dsh-plugin-git-bash@0.2.0
```

DSH 会根据包内的 `dsh.bundle` 声明自动把插件加入 profile 的 bundle 列表。开发本地版本时可传入 checkout 路径：

```powershell
dsh plugin --profile web add C:\path\to\dsh-git-bash
```

安装后重启对应的 DSH profile，并新建会话。验证命令：

```bash
printf 'shell=%s\nversion=%s\nmsystem=%s\n' "$BASH" "$BASH_VERSION" "$MSYSTEM"
```

预期 `MSYSTEM` 为 `MINGW64` 或 `MINGW32`。可以分别切换到 `read-only` 和 `workspace-write` 验证权限边界；不再需要为了启动 Git Bash 切换到 `danger-full-access`。

## 自定义 Git Bash 路径

启动 DSH 前设置：

```powershell
$env:DSH_GIT_BASH_PATH = 'D:\Apps\Git\bin\bash.exe'
dsh web
```

路径也可以直接传给 provider：

```yaml
- id: git-bash-shell
  name: dsh-plugin-git-bash
  config:
    executable: D:\Apps\Git\bin\bash.exe
```

## 从源码构建与验证

Windows native rebuild 额外要求 Visual Studio C++ build tools 和 CMake 3.25 或更高版本：

```powershell
pnpm install
pnpm test
pnpm run pack:check
```

`pnpm test` 会以 C++20、静态 MSVC runtime、CFG、CET、ASLR 和 NX 重新构建两个 native artifact，然后运行真实 Windows ACL permission matrix 和 fail-closed 测试。非 Windows 主机不会交叉编译，只校验预编译 artifact 已存在。
