import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const CLIENT_PATH = new URL("../client.js", import.meta.url);

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

function createReactRuntime() {
  const states = [];
  let cursor = 0;
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    react: {
      createElement,
      useEffect(callback) {
        callback();
      },
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (value) => {
          states[index] = typeof value === "function" ? value(states[index]) : value;
        }];
      },
      useSyncExternalStore(_subscribe, getSnapshot) {
        return getSnapshot();
      },
    },
    render(component, props) {
      cursor = 0;
      return component(props);
    },
  };
}

function loadClient(document, runtime = createReactRuntime()) {
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

  function IconChevronDownOutline14() {}
  function IconFolderOpenOutline16() {}
  const plugin = descriptor.factory((name) => {
    if (name === "react") return runtime.react;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      return { IconChevronDownOutline14, IconFolderOpenOutline16 };
    }
    assert.fail(`unexpected client module: ${name}`);
  });
  return { descriptor, plugin, runtime };
}

function createSettingsScope(overrides = {}) {
  let snapshot = {
    status: "ready",
    value: { executable: "" },
    base: { executable: "" },
    user: undefined,
    revision: 0,
    writable: true,
    mode: "host",
    ...overrides,
  };
  const writes = [];
  const listeners = new Set();
  const publish = (next) => {
    snapshot = { ...snapshot, ...next, revision: (snapshot.revision ?? 0) + 1 };
    for (const listener of listeners) listener();
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async set(field, value) {
      writes.push({ op: "set", field, value });
      publish({
        value: { ...snapshot.value, [field]: value },
        user: { ...(snapshot.user ?? {}), [field]: value },
      });
    },
    async unset(field) {
      writes.push({ op: "unset", field });
      const { [field]: _removed, ...user } = snapshot.user ?? {};
      publish({
        value: { ...snapshot.value, [field]: snapshot.base?.[field] ?? "" },
        user: Object.keys(user).length === 0 ? undefined : user,
      });
    },
  };
  return { scope, writes };
}

function registerCompatRow(plugin, options = {}) {
  function OriginalBashRow() {}
  const registrations = [];
  const effects = [];
  const settings = options.settings ?? createSettingsScope();
  const selectedDirectory = options.selectedDirectory ?? "D:\\Apps\\Git";
  let pickCount = 0;
  const ctx = {
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === "function") effects.push(dispose);
      return dispose;
    },
    locale: {
      bind(namespace) {
        assert.equal(namespace, "git-bash.settings");
        return (key) => key;
      },
      register(namespace, dictionaries) {
        assert.equal(namespace, "git-bash.settings");
        assert.equal(dictionaries.zh.title, "Git Bash");
        return () => {};
      },
    },
    settingsScope: {
      bind(spec) {
        assert.deepEqual(json(spec), { namespace: "shell" });
        return settings.scope;
      },
    },
    workspaces: {
      async pickDirectory() {
        pickCount += 1;
        return selectedDirectory;
      },
    },
    slots: {
      entries(name) {
        if (name !== "tool.call.toolview") return [];
        return [{
          component: OriginalBashRow,
          options: { key: "bash", priority: 0 },
        }];
      },
      inject(name, callback) {
        assert.ok(["tool.call.toolview", "settings.plugin.item"].includes(name));
        return callback();
      },
      register(registrationOptions, component) {
        const registration = { options: registrationOptions, component };
        registrations.push(registration);
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  const registration = registrations.find((entry) => entry.options.name === "tool.call.toolview");
  const settingsRegistration = registrations.find(
    (entry) => entry.options.name === "settings.plugin.item",
  );
  assert.ok(registration);
  assert.ok(settingsRegistration);
  return {
    OriginalBashRow,
    registration,
    settingsRegistration,
    settings,
    get pickCount() {
      return pickCount;
    },
    dispose() {
      for (const dispose of effects.reverse()) dispose();
    },
  };
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

function findElement(node, predicate) {
  if (typeof node !== "object" || node === null) return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findElement(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

test("client bundle registers a higher-priority Bash row wrapper", () => {
  const { descriptor, plugin } = loadClient();
  assert.equal(descriptor.id, "dsh-plugin-git-bash");
  assert.deepEqual(json(plugin.inject), [
    "slots",
    "locale",
    "settingsScope",
    "connection",
    "remote",
    "workspaces",
  ]);

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

test("client bundle converts selected Git directories to bash.exe paths", () => {
  const { plugin } = loadClient();
  assert.equal(
    plugin.gitBashExecutableFromDirectory("C:\\Program Files\\Git"),
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );
  assert.equal(
    plugin.gitBashExecutableFromDirectory("D:/Tools/Git/bin/"),
    "D:\\Tools\\Git\\bin\\bash.exe",
  );
  assert.equal(
    plugin.gitBashExecutableFromDirectory("E:\\PortableGit\\usr"),
    "E:\\PortableGit\\usr\\bin\\bash.exe",
  );
  assert.equal(plugin.isGitBashExecutablePath("D:\\Tools\\Git\\bin\\bash.exe"), true);
  assert.equal(plugin.isGitBashExecutablePath("D:\\Tools\\Git"), false);
  assert.equal(plugin.isGitBashExecutablePath("relative\\bash.exe"), false);
  assert.equal(plugin.isGitBashExecutablePath(""), true);
});

test("client bundle registers and operates the Git Bash settings card", async () => {
  const { plugin, runtime } = loadClient();
  const harness = registerCompatRow(plugin, { selectedDirectory: "D:\\PortableGit" });
  const { settingsRegistration } = harness;
  assert.deepEqual(json(settingsRegistration.options), {
    name: "settings.plugin.item",
    id: "git-bash",
    order: 5,
    locale: "git-bash.settings",
  });

  const props = settingsRegistration.options.inject();
  let card = runtime.render(settingsRegistration.component, props);
  assert.equal(card.props["data-dsh-git-bash-settings"], "");
  await card.children[0].props.onClick();
  card = runtime.render(settingsRegistration.component, props);

  const picker = findElement(
    card,
    (element) => element.props.className?.includes("dgb-settings-picker"),
  );
  assert.ok(picker);
  await picker.props.onClick();
  assert.equal(harness.pickCount, 1);

  card = runtime.render(settingsRegistration.component, props);
  const input = findElement(card, (element) => element.type === "input");
  assert.equal(input.props.value, "D:\\PortableGit\\bin\\bash.exe");
  assert.equal(input.props["aria-describedby"], "plugin-config-git-bash-executable-hint");
  const hint = findElement(
    card,
    (element) => element.props.id === "plugin-config-git-bash-executable-hint",
  );
  assert.ok(hint);
  const save = findElement(
    card,
    (element) => element.props.className?.includes("dgb-settings-button-primary"),
  );
  await save.props.onClick();
  assert.deepEqual(harness.settings.writes, [{
    op: "set",
    field: "executable",
    value: "D:\\PortableGit\\bin\\bash.exe",
  }]);

  card = runtime.render(settingsRegistration.component, props);
  const reset = findElement(
    card,
    (element) => element.props.className === "dgb-settings-reset",
  );
  assert.ok(reset);
  reset.props.onClick();
  card = runtime.render(settingsRegistration.component, props);
  const resetSave = findElement(
    card,
    (element) => element.props.className?.includes("dgb-settings-button-primary"),
  );
  await resetSave.props.onClick();
  assert.deepEqual(harness.settings.writes[1], { op: "unset", field: "executable" });
});

test("settings card can reset an invalid stored executable", async () => {
  const invalidPath = "relative\\bash.exe";
  const settings = createSettingsScope({
    value: { executable: invalidPath },
    base: { executable: "" },
    user: { executable: invalidPath },
  });
  const { plugin, runtime } = loadClient();
  const harness = registerCompatRow(plugin, { settings });
  const registration = harness.settingsRegistration;
  const props = registration.options.inject();
  let card = runtime.render(registration.component, props);
  card.children[0].props.onClick();
  card = runtime.render(registration.component, props);

  const input = findElement(card, (element) => element.type === "input");
  assert.equal(input.props["aria-invalid"], true);
  assert.equal(
    input.props["aria-errormessage"],
    "plugin-config-git-bash-executable-hint",
  );
  const alert = findElement(card, (element) => element.props.role === "alert");
  assert.ok(alert);

  const reset = findElement(
    card,
    (element) => element.props.className === "dgb-settings-reset",
  );
  reset.props.onClick();
  card = runtime.render(registration.component, props);
  const save = findElement(
    card,
    (element) => element.props.className?.includes("dgb-settings-button-primary"),
  );
  await save.props.onClick();
  assert.deepEqual(settings.writes, [{ op: "unset", field: "executable" }]);
});

test("typing back to the inherited executable clears the pending override", () => {
  const inherited = "D:\\PortableGit\\bin\\bash.exe";
  const settings = createSettingsScope({
    value: { executable: inherited },
    base: { executable: inherited },
    user: undefined,
  });
  const { plugin, runtime } = loadClient();
  const harness = registerCompatRow(plugin, { settings });
  const registration = harness.settingsRegistration;
  const props = registration.options.inject();
  let card = runtime.render(registration.component, props);
  card.children[0].props.onClick();
  card = runtime.render(registration.component, props);

  let input = findElement(card, (element) => element.type === "input");
  input.props.onChange({ target: { value: "D:\\OtherGit\\bin\\bash.exe" } });
  card = runtime.render(registration.component, props);
  input = findElement(card, (element) => element.type === "input");
  input.props.onChange({ target: { value: inherited } });
  card = runtime.render(registration.component, props);

  const save = findElement(
    card,
    (element) => element.props.className?.includes("dgb-settings-button-primary"),
  );
  assert.equal(save.props.disabled, true);
  assert.deepEqual(settings.writes, []);
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

test("client bundle scopes command wrapping and settings styles", () => {
  const styles = new Map();
  const document = {
    getElementById(id) {
      return styles.get(id) ?? null;
    },
    createElement(tag) {
      assert.equal(tag, "style");
      const style = {
        id: "",
        textContent: "",
        remove() {
          styles.delete(style.id);
        },
      };
      return style;
    },
    head: {
      appendChild(value) {
        styles.set(value.id, value);
      },
    },
  };
  const { plugin } = loadClient(document);
  const harness = registerCompatRow(plugin);

  const commandStyle = styles.get("dsh-plugin-git-bash-command-wrap");
  assert.ok(commandStyle);
  assert.match(commandStyle.textContent, /\[data-dsh-git-bash-wrap\]/);
  assert.match(commandStyle.textContent, /white-space: pre-wrap !important/);
  assert.match(commandStyle.textContent, /overflow-wrap: anywhere !important/);
  assert.match(commandStyle.textContent, /text-overflow: clip !important/);

  const settingsStyle = styles.get("dsh-plugin-git-bash-settings");
  assert.ok(settingsStyle);
  assert.match(settingsStyle.textContent, /\[data-dsh-git-bash-settings\]/);
  assert.match(settingsStyle.textContent, /dgb-settings-input-row/);
  assert.match(settingsStyle.textContent, /@media \(max-width: 560px\)/);

  harness.dispose();
  assert.equal(styles.size, 0);
});

test("package declares the browser bundle for DSH discovery", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "0.3.0");
  assert.equal(pkg.exports["./client"], "./client.js");
  assert.ok(pkg.files.includes("client.js"));
  assert.deepEqual(pkg.dsh.client, {
    platform: "web",
    inject: [
      "@deepseek-ai/dsh-client-ui-tool",
      "@deepseek-ai/dsh-client-ui-settings-plugins",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-api-remotes",
    ],
  });
});
