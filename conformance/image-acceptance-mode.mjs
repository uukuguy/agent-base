export function acceptanceMode(env = process.env) {
  const release = env.AGENT_BASE_RELEASE_ACCEPTANCE === "1";
  return {
    release,
    requireDebug: !release,
  };
}
