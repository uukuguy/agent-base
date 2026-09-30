/** Map a host CPU identifier to the Linux image architecture used by tags. */
export function hostImageArch(machine) {
  const normalized = String(machine ?? "").trim();
  if (normalized === "x86_64" || normalized === "amd64" || normalized === "x64") return "amd64";
  if (normalized === "aarch64" || normalized === "arm64") return "arm64";
  throw new Error(`Unsupported host architecture: ${normalized || "(empty)"}`);
}
