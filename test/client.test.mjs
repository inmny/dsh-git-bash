import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const CLIENT_PATH = new URL("../client.js", import.meta.url);

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadClient(document) {
  let descriptor;
  vm.runInNewContext(readFileSync(CLIENT_PATH, "utf8"), {
    window: {
      __ModuleLoader__: {
        load(value) {
          descriptor = value;
        },
      },
    },
    ...(document === undefined ? {} : { document }),
  });
  assert.ok(descriptor);

  const createElement = (type, props, ...children) => ({ type, props, children });
  const plugin = descriptor.factory((name) => {
    assert.equal(name, "react");
    return { createElement };
  });
  return { descriptor, plugin };
}

function registerCompatRow(plugin) {
  function OriginalBashRow() {}
  let registration;
  const ctx = {
    slots: {
      entries(name) {
        assert.equal(name, "tool.call.toolview");
        return [{
          component: OriginalBashRow,
          options: { key: "bash", priority: 0 },
        }];
      },
      inject(name, callback) {
        assert.equal(name, "tool.call.toolview");
        return callback();
      },
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.ok(registration);
  return { OriginalBashRow, registration };
}

function renderBlock(component, block) {
  return component({
    toolName: "bash",
    block,
    sessionId: "session-test",
  });
}

function wrappedBashRow(element) {
  assert.equal(element.type, "div");
  assert.equal(element.props["data-dsh-git-bash-wrap"], "");
  assert.deepEqual(json(element.props.style), { display: "contents" });
  assert.equal(element.children.length, 1);
  return element.children[0];
}

test("client bundle registers a higher-priority Bash row wrapper", () => {
  const { descriptor, plugin } = loadClient();
  assert.equal(descriptor.id, "dsh-plugin-git-bash");
  assert.deepEqual(json(plugin.inject), ["slots"]);

  const { OriginalBashRow, registration } = registerCompatRow(plugin);
  assert.deepEqual(json(registration.options), {
    name: "tool.call.toolview",
    key: "bash",
    priority: -100,
    locale: "conversation",
  });

  const block = {
    callId: "call-root",
    name: "bash",
    argsRaw: "{}",
    callView: { card: "terminal", title: "printf root" },
    subCalls: [],
  };
  const element = renderBlock(registration.component, block);
  assert.equal(element.type, OriginalBashRow);
  assert.equal(element.props.block, block);
});

test("client bundle reconstructs terminal views for nested Bash lifecycle", () => {
  const { plugin } = loadClient();
  const { registration } = registerCompatRow(plugin);
  const argsRaw = JSON.stringify({
    command: "printf nested",
    description: "Print nested output",
    workdir: "C:\\workspace",
  });

  const running = wrappedBashRow(renderBlock(registration.component, {
    callId: "call-root:code:1",
    name: "bash",
    argsRaw,
    callView: null,
    subCalls: [],
  }));
  assert.deepEqual(json(running.props.block.callView), {
    card: "terminal",
    title: "printf nested",
    description: "Print nested output",
    cwd: "C:\\workspace",
  });

  const settled = wrappedBashRow(renderBlock(registration.component, {
    kind: "tool-result",
    seq: 12,
    time: 34,
    callId: "call-root:code:1",
    call: { name: "bash", argsRaw },
    callTime: 30,
    content: [{ type: "text", text: "nested output\n[exit code: 7]" }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
  }));
  assert.deepEqual(json(settled.props.block.resultView), {
    card: "terminal",
    output: "nested output",
    exitCode: 7,
  });
});

test("client bundle leaves presented and errored Bash blocks unchanged", () => {
  const { plugin } = loadClient();
  const { registration } = registerCompatRow(plugin);
  const presented = {
    callId: "call-presented",
    name: "bash",
    argsRaw: "{}",
    callView: { card: "terminal", title: "existing" },
    subCalls: [],
  };
  assert.equal(renderBlock(registration.component, presented).props.block, presented);

  const errored = {
    kind: "tool-result",
    seq: 20,
    time: 30,
    callId: "call-error:code:1",
    call: {
      name: "bash",
      argsRaw: JSON.stringify({ command: "false", description: "Fail to spawn" }),
    },
    callTime: 25,
    content: [{ type: "text", text: "spawn failed" }],
    isError: true,
    callView: null,
    resultView: null,
    subCalls: [],
  };
  assert.equal(renderBlock(registration.component, errored).props.block, errored);
});

test("client bundle scopes automatic command wrapping to reconstructed rows", () => {
  let style;
  const document = {
    getElementById(id) {
      return style?.id === id ? style : null;
    },
    createElement(tag) {
      assert.equal(tag, "style");
      return { id: "", textContent: "" };
    },
    head: {
      appendChild(value) {
        style = value;
      },
    },
  };
  const { plugin } = loadClient(document);
  registerCompatRow(plugin);

  assert.equal(style.id, "dsh-plugin-git-bash-command-wrap");
  assert.match(style.textContent, /\[data-dsh-git-bash-wrap\]/);
  assert.match(style.textContent, /white-space: pre-wrap !important/);
  assert.match(style.textContent, /overflow-wrap: anywhere !important/);
  assert.match(style.textContent, /text-overflow: clip !important/);
});

test("package declares the browser bundle for DSH discovery", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "0.2.1");
  assert.equal(pkg.exports["./client"], "./client.js");
  assert.ok(pkg.files.includes("client.js"));
  assert.deepEqual(pkg.dsh.client, {
    platform: "web",
    inject: ["@deepseek-ai/dsh-client-ui-tool"],
  });
});
