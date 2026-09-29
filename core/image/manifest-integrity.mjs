import { digestCanonical } from "../gates/index.mjs";

/** Digest the complete runtime control plane without including the digest field itself. */
export function digestManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("render manifest must be an object");
  const { manifestDigest: _ignored, ...controlPlane } = manifest;
  return digestCanonical(controlPlane);
}

export function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { ok: false, reason: "manifest 不是对象" };
  if (typeof manifest.manifestDigest !== "string") return { ok: false, reason: "缺 manifestDigest" };
  let expected;
  try { expected = digestManifest(manifest); } catch (error) { return { ok: false, reason: error.message }; }
  if (expected !== manifest.manifestDigest) return { ok: false, reason: `manifestDigest 不匹配：记录 ${manifest.manifestDigest}，实际 ${expected}` };
  return { ok: true, expected };
}
