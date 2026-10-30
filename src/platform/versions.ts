/**
 * Pinned external build artifacts (`BLD-NF-02`).
 *
 * Railpack is pre-1.0 and BuildKit is a container image, so neither may be
 * resolved at runtime. This module is the single declaration point for the
 * Railpack version, the per-architecture assets and SHA-256 digests, and the
 * BuildKit image tag and digest. Every other module imports from here.
 *
 * Upgrade procedure: change the constants below in one reviewed commit, copy
 * the asset names and digests from the upstream release, then rebuild the
 * fixtures. There is deliberately no `latest`, range, or floating tag.
 *
 * Evidence for the pins:
 * - `docs/reviews/bld-0.1-spike.md` records the Phase 0 spike on rootless
 *   Podman 5.7.0, including the x86_64 archive digest and the BuildKit image
 *   digest.
 * - The spike corrected two upstream-spec assumptions that are honoured here:
 *   the published image tag is `v0.34.1-rootless` (no such tag without the
 *   `v`), and the Railpack build flag is `--name` (not `--tag`).
 * - The aarch64 digest comes from the release's published `checksums.txt` and
 *   was independently re-hashed from the downloaded asset on 2026-10-30.
 */

/** Canonical architecture names used by the pinned Railpack assets. */
export type RailpackArchitecture = "x86_64" | "aarch64";

/** The architectures this release of easy-host can build on. */
export const RAILPACK_ARCHITECTURES = ["x86_64", "aarch64"] as const;

/** The exact Railpack release. Never a range (`BLD-NF-02`). */
export const RAILPACK_VERSION = "0.43.0";

/** Release page used for the pinned assets. */
export const RAILPACK_RELEASE_BASE_URL = `https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}`;

/** Executable name inside the release archive and in `<root>/tools`. */
export const RAILPACK_BINARY_NAME = "railpack";

/** SHA-256 of the x86_64 release archive (verified in the Phase 0 spike). */
const RAILPACK_SHA256_X86_64 = "248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb";

/** SHA-256 of the aarch64 release archive (upstream checksums.txt, re-hashed). */
const RAILPACK_SHA256_AARCH64 = "732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9";

/**
 * Per-architecture archive digests, keyed the same way as
 * {@link RAILPACK_RELEASES}. The feature document names this table
 * `RAILPACK_SHA256`; keeping the name makes the contract easy to find.
 */
export const RAILPACK_SHA256: Readonly<Record<RailpackArchitecture, string>> = {
  x86_64: RAILPACK_SHA256_X86_64,
  aarch64: RAILPACK_SHA256_AARCH64,
};

/** One pinned Railpack release asset. */
export interface PinnedRailpackRelease {
  /** Exact release version. */
  readonly version: string;
  /** Canonical architecture this asset targets. */
  readonly architecture: RailpackArchitecture;
  /** Asset file name inside the release. */
  readonly asset: string;
  /** Absolute download URL for the asset. */
  readonly url: string;
  /** Expected SHA-256 of the complete archive before extraction. */
  readonly sha256: string;
  /** Executable member that must exist inside the archive. */
  readonly binary: string;
}

function pinnedRelease(
  architecture: RailpackArchitecture,
  target: string,
  sha256: string,
): PinnedRailpackRelease {
  const asset = `railpack-v${RAILPACK_VERSION}-${target}-unknown-linux-musl.tar.gz`;

  return {
    version: RAILPACK_VERSION,
    architecture,
    asset,
    url: `${RAILPACK_RELEASE_BASE_URL}/${asset}`,
    sha256,
    binary: RAILPACK_BINARY_NAME,
  };
}

/**
 * The complete per-architecture release table. The aarch64 asset uses the
 * `arm64` target name even though the canonical architecture is `aarch64`;
 * that mismatch is upstream and is why the mapping lives in one place.
 */
export const RAILPACK_RELEASES: Readonly<Record<RailpackArchitecture, PinnedRailpackRelease>> = {
  x86_64: pinnedRelease("x86_64", "x86_64", RAILPACK_SHA256.x86_64),
  aarch64: pinnedRelease("aarch64", "arm64", RAILPACK_SHA256.aarch64),
};

/** Exact BuildKit version. Never a range (`BLD-NF-02`). */
export const BUILDKIT_VERSION = "0.34.1";

/** Repository of the rootless BuildKit image. */
export const BUILDKIT_IMAGE_NAME = "docker.io/moby/buildkit";

/** Published tag, including the `v` prefix the spike found on Docker Hub. */
export const BUILDKIT_IMAGE_TAG = `v${BUILDKIT_VERSION}-rootless`;

/** Image name and tag, without the digest. */
export const BUILDKIT_IMAGE = `${BUILDKIT_IMAGE_NAME}:${BUILDKIT_IMAGE_TAG}`;

/** Multi-architecture index digest recorded by the Phase 0 spike. */
export const BUILDKIT_DIGEST =
  "sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89";

/**
 * Fully pinned pull reference. Callers must pull and run this string; a tag
 * without the digest is not the pin.
 */
export const BUILDKIT_IMAGE_REFERENCE = `${BUILDKIT_IMAGE}@${BUILDKIT_DIGEST}`;
