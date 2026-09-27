// ============================================================================
// 本运行时的**产物读法**（供 `core/introspect/project-info.mjs` 的 `collect` 调用）
//
// 为什么单独一个文件：自省逻辑必须**与运行时无关**（`core/` 里不许出现运行时名与专有文件名），
// 而"产物长什么样"恰恰是运行时专有的。所以 core 只定义"要哪几样事实"，
// 各运行时在这里回答"从哪儿读"。新增运行时 = 加一个这样的文件，core 不动。
//
// 本运行时的产物形状：配置目录里是 `settings.json` / `models.json(.tmpl)` /
// `enhancements.yaml` / `mcp.json`；技能在配置目录的 `skills/`。
// ============================================================================

import path from "node:path";

export const PI_PROJECT_LAYOUT = {
  id: "pi",
  /**
   * 本运行时的**配置目录**在哪：布局契约里它是运行期布局的第一个值（`runtimePlan.env`）。
   * 由布局回答而不是让调用方猜 —— 各运行时的产物形状不同。
   */
  configDir({ artifact, env }) {
    const rel = env && Object.values(env)[0];
    return rel ? path.join(artifact, rel) : null;
  },
  /**
   * @param {{productDir: string, artifact: string, readJson: (f: string) => any}} ctx
   */
  read({ productDir, readJson }) {
    const settings = readJson(path.join(productDir, "settings.json"));
    const models = readJson(path.join(productDir, "models.json.tmpl"))
      ?? readJson(path.join(productDir, "models.json"));
    const enhancementsDoc = readJson(path.join(productDir, "enhancements.yaml"));
    const mcp = readJson(path.join(productDir, "mcp.json"));
    return {
      settings,
      models,
      enhancements: (enhancementsDoc?.enhancements ?? []).map((e) => ({
        id: e.id,
        kind: e.kind,
        target: e.entry ?? e.package ?? null,
        events: Array.isArray(e.events) ? e.events : null,
      })),
      servers: Object.entries(mcp?.mcpServers ?? {}).map(([name, cfg]) => ({
        name,
        transport: cfg.url ? "streamable-http" : "stdio",
        hasCommand: !!cfg.command,
        hasUrl: !!cfg.url,
      })),
    };
  },
};

/** 与 harness 无关的名字：调用方按它取，不必知道是哪个运行时。 */
export const projectLayout = PI_PROJECT_LAYOUT;
