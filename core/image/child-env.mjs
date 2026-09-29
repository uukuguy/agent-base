// 子进程环境策略的唯一实现。
// 运行时不能默认继承宿主环境，否则 Agent 可读取 CI、云厂商和数据库凭据。

export const DEFAULT_PERMISSION_MODE = "workspace-write";
export const PERMISSION_MODES = new Set(["ask", "workspace-write", "danger-full-access"]);

const SAFE_ENV_NAMES = new Set([
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "NO_COLOR",
  "AGENT_ARTIFACT_DIR", "AGENT_GATES_DIR", "AGENT_RUN_DIR", "AGENT_RUN_MODE",
  "AGENT_TRACE_DEST", "AGENT_TRACE_CONTENT", "AGENT_SESSION_ID", "AGENT_RESUMED",
  "AGENT_DEFINITION_DIR", "AGENT_NAME", "AGENT_MODEL_ROUTE",
  "AGENT_EFFECTIVE_CONFIG_DIGEST", "AGENT_BUNDLES", "AGENT_BUNDLES_ACTIVE", "AGENT_BUNDLES_AVAILABLE",
  "AGENT_PERMISSION_MODE", "AGENT_HARNESS_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR",
  "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "NARB_DISABLE_NATIVE_CACHE",
  "AGENT_SECRETS_DIR", "AGENT_OVERLAY_DIR", "AGENT_CRASH_TAIL_LINES", "AGENT_BASE_VARIANT_FILE",
]);

function copyIfPresent(target, source, name) {
  if (source && source[name] !== undefined && source[name] !== null) target[name] = String(source[name]);
}

/**
 * @param {{baseEnv?: object, values?: object, platform?: object, extra?: object, allowedExtra?: string[], permissionMode?: string|null}} opts
 */
export function buildChildEnv({
  baseEnv = process.env,
  values = {},
  platform = {},
  extra = {},
  allowedExtra = [],
  permissionMode = null,
} = {}) {
  const output = {};
  for (const name of SAFE_ENV_NAMES) copyIfPresent(output, baseEnv, name);
  for (const name of Object.keys(platform)) copyIfPresent(output, platform, name);
  for (const name of allowedExtra) copyIfPresent(output, extra, name);
  for (const [name, value] of Object.entries(values ?? {})) copyIfPresent(output, { [name]: value }, name);

  const requested = permissionMode ?? output.AGENT_PERMISSION_MODE ?? DEFAULT_PERMISSION_MODE;
  if (!PERMISSION_MODES.has(requested)) throw new Error(`invalid AGENT_PERMISSION_MODE: ${requested}`);
  output.AGENT_PERMISSION_MODE = requested;
  return output;
}

export function safeEnvNames() {
  return [...SAFE_ENV_NAMES].sort();
}

/** Copy only names declared by the rendered runtime contract from a source environment. */
export function declaredRuntimeValues(manifest, source = process.env) {
  const values = {};
  for (const param of manifest?.runtimeParams ?? []) {
    if (source[param.name] !== undefined) values[param.name] = source[param.name];
    if (source[`${param.name}_FILE`] !== undefined) values[`${param.name}_FILE`] = source[`${param.name}_FILE`];
  }
  return values;
}
