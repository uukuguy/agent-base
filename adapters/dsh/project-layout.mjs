// ============================================================================
// 本运行时的**产物读法**（供 `core/introspect/project-info.mjs` 的 `collect` 调用）
//
// 本运行时的产物形状与另一个**不同**：配置目录是 profile 目录，模型路由写在
// `cordis.patch.yml` 的 row 里（`agent-default-model` + `llm-pi-ai`），
// 增强与连接器以 **insert row** 表达。
//
// ## 两条硬约束（都来自"这个文件会被拷进产物"）
//
//   ① **不许裸导入**（`import YAML from "yaml"` 之类）：接入件位于产物里，不在该运行时的
//      `node_modules` 之下，裸导入在运行期直接 `failed to import`（本仓库踩过）。
//      所以这里只 import `node:` 内置模块。
//   ② 因此模型事实**从渲染清单读**（清单里本来就有 `modelProviders` /
//      `modelProviderApi` / `modelProviderAuth` / `modelProviderModels` —— 与另一个运行时同名）
//      而不是去解析 `cordis.patch.yml`。清单是产物自描述的共同事实，解析非标准标签的 YAML
//      既需要依赖、又要处理 `!!js` 未求值的问题，得不偿失。
//
// 报告里这一节显示的是**声明的路由**（与另一个运行时一致）：真正生效的值由运行期插值决定。
// ============================================================================

import path from "node:path";

export const DSH_PROJECT_LAYOUT = {
  id: "dsh",
  /**
   * 本运行时的**配置目录** = profile 目录：`<产物>/<DSH_HOME>/profiles/<智能体名>`。
   * 与另一个运行时不同（那边配置直接摊在布局值指向的目录里），所以由布局回答、调用方不猜。
   */
  configDir({ artifact, env, agent }) {
    const home = env?.DSH_HOME;
    return home && agent ? path.join(artifact, home, "profiles", agent) : null;
  },
  /**
   * @param {{productDir: string, artifact: string, readJson: (f: string) => any}} ctx
   */
  read({ artifact, readJson }) {
    const manifest = readJson(path.join(artifact, "render-manifest.json"));
    const providerId = manifest?.modelProviders?.[0] ?? null;
    const models = Array.isArray(manifest?.modelProviderModels) ? manifest.modelProviderModels : [];
    return {
      settings: providerId ? { defaultProvider: providerId } : null,
      models: providerId
        ? {
            providers: {
              [providerId]: {
                api: manifest?.modelProviderApi ?? null,
                apiKey: manifest?.modelProviderAuth ?? null,
                models: models.map((id) => ({ id })),
              },
            },
          }
        : null,
      // 增强与连接器：声明侧在 `render-manifest.json` 里（清单是两侧的共同事实）
      enhancements: [],
      servers: [],
    };
  },
};

/** 与 harness 无关的名字：调用方按它取，不必知道是哪个运行时。 */
export const projectLayout = DSH_PROJECT_LAYOUT;
