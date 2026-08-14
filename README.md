# dsh-plugin-git-bash

让 DeepSeek Harness 在 Windows 上默认使用 Git for Windows 自带的 Bash，而不是 PowerShell。

## 行为

- 自动探测 Program Files、用户安装和 Scoop 中的 Git Bash。
- 可通过 `DSH_GIT_BASH_PATH` 指定 `bash.exe`。
- 前台命令、后台命令和 Web Agent preset 使用同一个 Git Bash executor。
- `standard`、`code`、`cordis` 和 `minimal` preset 中的 PowerShell 工具会被 Git Bash 工具遮蔽。
- 插件不修改 DSH 安装目录；它作为 bundle layer 安装到指定 profile。

## Windows 沙盒限制

Git for Windows 的 MSYS2 runtime 启动时需要共享 file mapping。DSH 的 Windows `read-only` 和 `workspace-write` 模式使用 `WRITE_RESTRICTED` token，该 token 会拒绝这个映射，Git Bash 因而无法启动。

插件不会绕过或降级 DSH 沙盒：受限模式会在创建子进程前返回标准 `SANDBOX_UNAVAILABLE`。使用 Git Bash 时，需要把会话权限设为 `danger-full-access`。Web GUI 可在权限控件中选择该模式；也可以在启动 DSH 前设置：

```powershell
$env:DSH_PERMISSION_MODE = 'danger-full-access'
dsh web
```

## 开发与验证

```powershell
pnpm install
pnpm test
pnpm run pack:check
```

要求 Node.js 24 或更高版本、DSH `0.1.0-rc.6`，以及 Git for Windows。

## 安装到 DSH

例如安装到 Web profile：

```powershell
dsh plugin --profile web add C:\path\to\dsh-plugins
```

安装后重启对应的 DSH profile，并新建会话。验证命令：

```bash
printf 'shell=%s\nversion=%s\nmsystem=%s\n' "$BASH" "$BASH_VERSION" "$MSYSTEM"
```

预期 `MSYSTEM` 为 `MINGW64` 或 `MINGW32`。

## 自定义 Git Bash 路径

启动 DSH 前设置：

```powershell
$env:DSH_GIT_BASH_PATH = 'D:\Apps\Git\bin\bash.exe'
$env:DSH_PERMISSION_MODE = 'danger-full-access'
dsh web
```

路径也可以直接传给 provider：

```yaml
- id: git-bash-shell
  name: dsh-plugin-git-bash
  config:
    executable: D:\Apps\Git\bin\bash.exe
```
