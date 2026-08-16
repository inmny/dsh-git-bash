window.__ModuleLoader__.load({
  id: "dsh-plugin-git-bash",
  factory: (require) => {
    const module = { exports: {} };
    const {
      createElement,
      useEffect,
      useState,
      useSyncExternalStore,
    } = require("react");
    const {
      IconChevronDownOutline14,
      IconFolderOpenOutline16,
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const SLOT = "tool.call.toolview";
    const SETTINGS_SLOT = "settings.plugin.item";
    const SETTINGS_NAMESPACE = "shell";
    const LOCALE_NAMESPACE = "git-bash.settings";
    const PRIORITY = -100;
    const WRAP_ATTR = "data-dsh-git-bash-wrap";
    const STYLE_ID = "dsh-plugin-git-bash-command-wrap";
    const SETTINGS_STYLE_ID = "dsh-plugin-git-bash-settings";
    const STYLE_OWNER = {};
    const COMMAND_WRAP_CSS = `
[${WRAP_ATTR}] [class*="_command_"] {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
  overflow: visible !important;
  text-overflow: clip !important;
}
`;
    const SETTINGS_CSS = `
[data-dsh-git-bash-settings] {
  list-style: none;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  transition: border-color 0.16s, background 0.16s;
}
[data-dsh-git-bash-settings]:hover,
[data-dsh-git-bash-settings][data-open="true"] {
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-git-bash-settings][data-open="true"] {
  background: var(--dsw-alias-bg-layer-2);
}
.dgb-settings-header {
  appearance: none;
  width: 100%;
  min-height: 68px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
}
.dgb-settings-header:focus-visible,
.dgb-settings-button:focus-visible,
.dgb-settings-reset:focus-visible,
.dgb-settings-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dgb-settings-head-text {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}
.dgb-settings-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.dgb-settings-description {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dgb-settings-pending,
.dgb-settings-overridden {
  flex: none;
  padding: 1px 8px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}
.dgb-settings-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.16s;
}
.dgb-settings-chevron-open {
  transform: rotate(180deg);
}
.dgb-settings-body {
  margin: 0 16px;
  padding: 0 0 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dgb-settings-readonly,
.dgb-settings-message,
.dgb-settings-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
.dgb-settings-readonly {
  padding-top: 12px;
}
.dgb-settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dgb-settings-field-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dgb-settings-label {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.dgb-settings-field-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dgb-settings-reset {
  padding: 0;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.dgb-settings-reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dgb-settings-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dgb-settings-input {
  min-width: 0;
  height: 34px;
  flex: 1 1 260px;
  padding: 0 12px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.dgb-settings-input[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dgb-settings-input:disabled,
.dgb-settings-button:disabled,
.dgb-settings-reset:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dgb-settings-button {
  min-height: 34px;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 5px 12px;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.dgb-settings-button:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-3);
}
.dgb-settings-button-primary {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-button-primary-fill);
  border-color: transparent;
}
.dgb-settings-button-primary:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-button-primary-hover);
}
.dgb-settings-button-primary:disabled {
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-button-primary-dimmed);
}
.dgb-settings-error {
  color: var(--dsw-alias-state-error-primary);
}
.dgb-settings-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dgb-settings-message {
  min-width: 0;
  flex: 1;
}
@media (max-width: 560px) {
  .dgb-settings-header {
    align-items: flex-start;
  }
  .dgb-settings-pending {
    display: none;
  }
  .dgb-settings-input-row {
    align-items: stretch;
    flex-direction: column;
  }
  .dgb-settings-input {
    width: 100%;
    flex-basis: 34px;
  }
  .dgb-settings-picker {
    width: 100%;
  }
}
`;

    function installStyle(id, content) {
      if (typeof document === "undefined") return () => {};
      let style = document.getElementById(id);
      if (style === null) {
        style = document.createElement("style");
        style.id = id;
        document.head.appendChild(style);
      }
      style.textContent = content;
      style.__dshGitBashOwner = STYLE_OWNER;
      return () => {
        if (style.__dshGitBashOwner === STYLE_OWNER) style.remove();
      };
    }

    function installCommandWrapStyle() {
      return installStyle(STYLE_ID, COMMAND_WRAP_CSS);
    }

    function installSettingsStyle() {
      return installStyle(SETTINGS_STYLE_ID, SETTINGS_CSS);
    }

    function parseArguments(block) {
      const raw = "kind" in block ? block.call?.argsRaw : block.argsRaw;
      if (typeof raw !== "string" || raw === "") return null;
      try {
        const value = JSON.parse(raw);
        return typeof value === "object" && value !== null ? value : null;
      } catch {
        return null;
      }
    }

    function flattenContent(content) {
      return content.map((block) => {
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        return JSON.stringify(block, null, 2);
      }).join("\n");
    }

    function parseTerminalOutput(output) {
      const signal = output.match(/(?:\r?\n)?\[killed by signal: ([^\]\r\n]+)\]\s*$/);
      if (signal !== null) {
        return { output: output.slice(0, signal.index), signal: signal[1] };
      }
      const exit = output.match(/(?:\r?\n)?\[exit code: (-?\d+)\]\s*$/);
      if (exit !== null) {
        return { output: output.slice(0, exit.index), exitCode: Number(exit[1]) };
      }
      return { output };
    }

    function addNestedTerminalViews(block) {
      const settled = "kind" in block;
      if (block.callView !== null) return block;
      if (settled && (block.resultView !== null || block.isError)) return block;

      const args = parseArguments(block);
      if (args === null || typeof args.command !== "string" || args.command === "") return block;
      const callView = {
        card: "terminal",
        title: args.command,
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.workdir === "string" ? { cwd: args.workdir } : {}),
      };
      if (!settled) return { ...block, callView };

      return {
        ...block,
        callView,
        resultView: {
          card: "terminal",
          ...parseTerminalOutput(flattenContent(block.content)),
        },
      };
    }

    const settingsLocales = {
      en: {
        title: "Git Bash",
        description: "Select the Git for Windows shell used by Bash commands.",
        unsaved: "Unsaved",
        overridden: "Overridden",
        reset: "Reset to default",
        readOnly: "This deployment stores settings read-only.",
        pathLabel: "Git Bash executable",
        pathHint: "Leave blank to auto-detect Git for Windows. The path must point to bash.exe.",
        invalidPath: "Enter an absolute Windows path ending in bash.exe, or leave it blank.",
        browse: "Select Git installation folder",
        browsing: "Selecting...",
        browseTitle: "Open the Windows folder picker",
        discard: "Discard",
        save: "Save",
        saving: "Saving...",
        saveFailed: "That bash.exe is unavailable or invalid. Check the path and try again.",
        pickerFailed: "The Windows folder picker could not be opened.",
      },
      zh: {
        title: "Git Bash",
        description: "选择 Bash 命令使用的 Git for Windows 终端。",
        unsaved: "未保存",
        overridden: "已覆盖",
        reset: "恢复默认",
        readOnly: "本部署的设置为只读。",
        pathLabel: "Git Bash 可执行文件",
        pathHint: "留空会自动探测 Git for Windows；路径必须指向 bash.exe。",
        invalidPath: "请输入以 bash.exe 结尾的 Windows 绝对路径，或留空自动探测。",
        browse: "选择 Git 安装目录",
        browsing: "选择中...",
        browseTitle: "打开 Windows 原生目录选择窗口",
        discard: "放弃修改",
        save: "保存",
        saving: "保存中...",
        saveFailed: "该 bash.exe 不可用或路径无效，请检查后重试。",
        pickerFailed: "无法打开 Windows 原生目录选择窗口。",
      },
    };

    function hasOwn(value, key) {
      return typeof value === "object" && value !== null &&
        Object.prototype.hasOwnProperty.call(value, key);
    }

    function isGitBashExecutablePath(value) {
      return /^(?:$|(?:[A-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|%[^%]+%[\\/])(?:.*[\\/])?bash\.exe)$/i
        .test(value.trim());
    }

    function appendWindowsPath(directory, suffix) {
      return directory.endsWith("\\") ? directory + suffix : directory + "\\" + suffix;
    }

    function gitBashExecutableFromDirectory(directory) {
      let normalized = typeof directory === "string" ? directory.trim().replace(/\//g, "\\") : "";
      normalized = normalized.replace(/\\+$/, "");
      if (/^[A-Za-z]:$/.test(normalized)) normalized += "\\";
      if (normalized === "" || /(?:^|\\)bash\.exe$/i.test(normalized)) return normalized;
      if (/(?:^|\\)bin$/i.test(normalized)) return appendWindowsPath(normalized, "bash.exe");
      if (/(?:^|\\)usr$/i.test(normalized)) return appendWindowsPath(normalized, "bin\\bash.exe");
      return appendWindowsPath(normalized, "bin\\bash.exe");
    }

    function executableOf(value) {
      return typeof value?.executable === "string" ? value.executable : "";
    }

    function GitBashSettingsCard(props) {
      const { scope, pickDirectory, t } = props;
      const snapshot = useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
        () => scope.getSnapshot(),
      );
      const effective = executableOf(snapshot.value);
      const inherited = executableOf(snapshot.base);
      const supported = snapshot.status === "ready" && hasOwn(snapshot.value, "executable");
      const overridden = hasOwn(snapshot.user, "executable");
      const writable = supported && snapshot.writable;
      const [open, setOpen] = useState(false);
      const [text, setText] = useState(effective);
      const [dirty, setDirty] = useState(false);
      const [resetPending, setResetPending] = useState(false);
      const [saving, setSaving] = useState(false);
      const [picking, setPicking] = useState(false);
      const [message, setMessage] = useState("");

      useEffect(() => {
        if (dirty) return;
        setText(effective);
      }, [dirty, effective, snapshot.revision]);

      if (!supported) return null;

      const trimmed = text.trim();
      const willUnset = resetPending || trimmed === "";
      const invalid = !willUnset && !isGitBashExecutablePath(trimmed);
      const previewOverridden = dirty ? !willUnset : overridden;
      const busy = saving || picking;

      const edit = (value) => {
        setText(value);
        setDirty(value.trim() !== effective.trim());
        setResetPending(false);
        setMessage("");
      };
      const reset = () => {
        setText(inherited);
        setDirty(true);
        setResetPending(true);
        setMessage("");
      };
      const discard = () => {
        setText(effective);
        setDirty(false);
        setResetPending(false);
        setMessage("");
      };
      const browse = async () => {
        setPicking(true);
        setMessage("");
        try {
          const directory = await pickDirectory();
          if (directory !== null) edit(gitBashExecutableFromDirectory(directory));
        } catch {
          setMessage(t("pickerFailed"));
        } finally {
          setPicking(false);
        }
      };
      const save = async () => {
        if (!dirty || invalid || !writable || saving) return;
        setSaving(true);
        setMessage("");
        try {
          if (willUnset) await scope.unset("executable");
          else await scope.set("executable", trimmed);

          const latest = scope.getSnapshot();
          const accepted = willUnset
            ? !hasOwn(latest.user, "executable")
            : hasOwn(latest.user, "executable") && latest.user.executable === trimmed;
          if (!accepted) {
            setMessage(t("saveFailed"));
            return;
          }

          setText(executableOf(latest.value));
          setDirty(false);
          setResetPending(false);
        } catch {
          setMessage(t("saveFailed"));
        } finally {
          setSaving(false);
        }
      };

      return createElement("li", {
        "data-dsh-git-bash-settings": "",
        "data-open": open ? "true" : undefined,
      },
      createElement("button", {
        type: "button",
        className: "dgb-settings-header",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
      },
      createElement("span", { className: "dgb-settings-head-text" },
        createElement("span", { className: "dgb-settings-title" }, t("title")),
        createElement("span", { className: "dgb-settings-description" }, t("description")),
      ),
      dirty ? createElement("span", { className: "dgb-settings-pending" }, t("unsaved")) : null,
      createElement(IconChevronDownOutline14, {
        className: open
          ? "dgb-settings-chevron dgb-settings-chevron-open"
          : "dgb-settings-chevron",
      })),
      open ? createElement("div", { className: "dgb-settings-body" },
        !writable ? createElement("p", {
          className: "dgb-settings-readonly",
          role: "status",
        }, t("readOnly")) : null,
        createElement("div", { className: "dgb-settings-field" },
          createElement("div", { className: "dgb-settings-field-head" },
            createElement("label", {
              className: "dgb-settings-label",
              htmlFor: "plugin-config-git-bash-executable",
            }, t("pathLabel")),
            previewOverridden ? createElement("span", { className: "dgb-settings-field-actions" },
              createElement("span", { className: "dgb-settings-overridden" }, t("overridden")),
              createElement("button", {
                type: "button",
                className: "dgb-settings-reset",
                disabled: !writable || busy,
                onClick: reset,
              }, t("reset")),
            ) : null,
          ),
          createElement("div", { className: "dgb-settings-input-row" },
            createElement("input", {
              id: "plugin-config-git-bash-executable",
              className: "dgb-settings-input",
              type: "text",
              autoComplete: "off",
              spellCheck: false,
              value: text,
              placeholder: "C:\\Program Files\\Git\\bin\\bash.exe",
              disabled: !writable || busy,
              "aria-describedby": "plugin-config-git-bash-executable-hint",
              ...(invalid ? {
                "aria-invalid": true,
                "aria-errormessage": "plugin-config-git-bash-executable-hint",
              } : {}),
              onChange: (event) => edit(event.target.value),
            }),
            createElement("button", {
              type: "button",
              className: "dgb-settings-button dgb-settings-picker",
              title: t("browseTitle"),
              disabled: !writable || busy,
              onClick: browse,
            },
            createElement(IconFolderOpenOutline16, {}),
            t(picking ? "browsing" : "browse")),
          ),
          createElement("p", {
            id: "plugin-config-git-bash-executable-hint",
            className: invalid ? "dgb-settings-hint dgb-settings-error" : "dgb-settings-hint",
            ...(invalid ? { role: "alert" } : {}),
          }, t(invalid ? "invalidPath" : "pathHint")),
        ),
        createElement("div", { className: "dgb-settings-footer" },
          message ? createElement("p", {
            className: "dgb-settings-message dgb-settings-error",
            role: "status",
          }, message) : null,
          createElement("button", {
            type: "button",
            className: "dgb-settings-button",
            disabled: !dirty || busy,
            onClick: discard,
          }, t("discard")),
          createElement("button", {
            type: "button",
            className: "dgb-settings-button dgb-settings-button-primary",
            disabled: !dirty || invalid || !writable || busy,
            onClick: save,
          }, t(saving ? "saving" : "save")),
        ),
      ) : null);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const disposeCommandStyle = installCommandWrapStyle();
        const disposeSettingsStyle = installSettingsStyle();
        return () => {
          disposeSettingsStyle();
          disposeCommandStyle();
        };
      }, "git-bash: client styles");

      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, settingsLocales),
        "git-bash: settings dictionaries");
      const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: "git-bash",
        order: 5,
        locale: LOCALE_NAMESPACE,
        inject: () => ({
          scope,
          pickDirectory: () => ctx.workspaces.pickDirectory(),
          t,
        }),
      }, GitBashSettingsCard));

      ctx.slots.inject(SLOT, () => {
        const original = ctx.slots.entries(SLOT)
          .filter((entry) => entry.options.key === "bash" && entry.options.priority !== PRIORITY)
          .sort((left, right) => (left.options.priority ?? 0) - (right.options.priority ?? 0))[0];
        if (original === undefined) return undefined;

        function GitBashRow(props) {
          const block = addNestedTerminalViews(props.block);
          const row = createElement(original.component, { ...props, block });
          if (block === props.block) return row;
          return createElement("div", {
            [WRAP_ATTR]: "",
            style: { display: "contents" },
          }, row);
        }

        return ctx.slots.register({
          name: SLOT,
          key: "bash",
          priority: PRIORITY,
          locale: "conversation",
        }, GitBashRow);
      });
    }

    const inject = [
      "slots",
      "locale",
      "settingsScope",
      "connection",
      "remote",
      "workspaces",
    ];
    module.exports = {
      apply,
      inject,
      gitBashExecutableFromDirectory,
      isGitBashExecutablePath,
    };
    return module.exports;
  },
});
