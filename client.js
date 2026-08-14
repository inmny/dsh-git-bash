window.__ModuleLoader__.load({
  id: "dsh-plugin-git-bash",
  factory: (require) => {
    const module = { exports: {} };
    const { createElement } = require("react");

    const SLOT = "tool.call.toolview";
    const PRIORITY = -100;
    const WRAP_ATTR = "data-dsh-git-bash-wrap";
    const STYLE_ID = "dsh-plugin-git-bash-command-wrap";
    const COMMAND_WRAP_CSS = `
[${WRAP_ATTR}] [class*="_command_"] {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
  overflow: visible !important;
  text-overflow: clip !important;
}
`;

    function installCommandWrapStyle() {
      if (typeof document === "undefined") return;
      let style = document.getElementById(STYLE_ID);
      if (style === null) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = COMMAND_WRAP_CSS;
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

    function apply(ctx) {
      installCommandWrapStyle();
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

    const inject = ["slots"];
    module.exports = { apply, inject };
    return module.exports;
  },
});
