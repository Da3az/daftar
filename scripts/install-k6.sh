#!/usr/bin/env bash
#
# Install a pinned k6 into ./.tools/bin, with checksum verification.
#
# Pinned rather than "latest" because k6 is a measuring instrument: a floating
# version would make benchmark numbers incomparable across runs.
#
# The official tarball from GitHub releases — no AUR, no Snap, no sudo, no
# third-party package manager. Extracts one static binary.
#
# Usage:  ./scripts/install-k6.sh
#         ./.tools/bin/k6 version

set -euo pipefail

K6_VERSION="v2.4.0"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools_dir="${repo_root}/.tools"
bin_dir="${tools_dir}/bin"
target="${bin_dir}/k6"

uname_m="$(uname -m)"
case "${uname_m}" in
  x86_64 | amd64) arch="amd64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *)
    echo "unsupported architecture: ${uname_m}" >&2
    exit 1
    ;;
esac

uname_s="$(uname -s)"
case "${uname_s}" in
  Linux) os="linux" ;;
  Darwin) os="macos" ;;
  *)
    echo "unsupported OS: ${uname_s}" >&2
    exit 1
    ;;
esac

if [[ -x "${target}" ]] && "${target}" version 2>/dev/null | grep -q "${K6_VERSION#v}"; then
  echo "k6 ${K6_VERSION} already installed at ${target}"
  exit 0
fi

name="k6-${K6_VERSION}-${os}-${arch}"
url="https://github.com/grafana/k6/releases/download/${K6_VERSION}/${name}.tar.gz"
checksums_url="https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-checksums.txt"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

echo "downloading ${url}"
curl -fsSL -o "${work}/${name}.tar.gz" "${url}"

# Verify against the release's own checksums file. Downloading a binary over
# TLS proves who served it, not that it is the artefact the release names.
if curl -fsSL -o "${work}/checksums.txt" "${checksums_url}"; then
  expected="$(grep " ${name}.tar.gz\$" "${work}/checksums.txt" | awk '{print $1}')"
  if [[ -z "${expected}" ]]; then
    echo "no checksum entry for ${name}.tar.gz — refusing to install" >&2
    exit 1
  fi
  actual="$(sha256sum "${work}/${name}.tar.gz" | awk '{print $1}')"
  if [[ "${expected}" != "${actual}" ]]; then
    echo "checksum mismatch for ${name}.tar.gz" >&2
    echo "  expected ${expected}" >&2
    echo "  actual   ${actual}" >&2
    exit 1
  fi
  echo "checksum ok: ${actual}"
else
  echo "could not fetch ${checksums_url} — refusing to install unverified" >&2
  exit 1
fi

tar -xzf "${work}/${name}.tar.gz" -C "${work}"
mkdir -p "${bin_dir}"
install -m 0755 "${work}/${name}/k6" "${target}"

echo "installed: $("${target}" version)"
echo "path:      ${target}"
