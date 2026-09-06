#!/bin/sh
# Install Phi Code standalone binary.
#   curl -fsSL https://raw.githubusercontent.com/uglyswap/phi-code/main/scripts/install.sh | sh
# Options: PHI_INSTALL_DIR (default: ~/.local/bin), PHI_VERSION (default: latest)
set -eu

REPO="uglyswap/phi-code"
INSTALL_DIR="${PHI_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${PHI_VERSION:-latest}"

detect_platform() {
	os="$(uname -s)"
	arch="$(uname -m)"
	case "$os" in
		Linux) os_part="linux" ;;
		Darwin) os_part="darwin" ;;
		*) echo "Unsupported OS: $os (use install.ps1 on Windows)" >&2; exit 1 ;;
	esac
	case "$arch" in
		x86_64 | amd64) arch_part="x64" ;;
		aarch64 | arm64) arch_part="arm64" ;;
		*) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
	esac
	echo "${os_part}-${arch_part}"
}

PLATFORM="$(detect_platform)"
ASSET="phi-${PLATFORM}.tar.gz"

if [ "$VERSION" = "latest" ]; then
	URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
	URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${URL}"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL "$URL" -o "$TMP/phi.tar.gz"
	curl -fsSL "${URL}.sha256" -o "$TMP/phi.tar.gz.sha256" 2>/dev/null || true
else
	echo "curl is required" >&2; exit 1
fi

if [ -f "$TMP/phi.tar.gz.sha256" ]; then
	expected="$(cut -d' ' -f1 < "$TMP/phi.tar.gz.sha256")"
	actual="$(sha256sum "$TMP/phi.tar.gz" | cut -d' ' -f1)"
	if [ "$expected" != "$actual" ]; then
		echo "Checksum mismatch: expected $expected, got $actual" >&2; exit 1
	fi
fi

tar -xzf "$TMP/phi.tar.gz" -C "$TMP"
BIN="$(find "$TMP" -name phi -type f | head -1)"
[ -n "$BIN" ] || { echo "Archive did not contain a phi binary" >&2; exit 1; }

mkdir -p "$INSTALL_DIR"
cp "$BIN" "$INSTALL_DIR/phi"
chmod +x "$INSTALL_DIR/phi"

echo "Installed phi to $INSTALL_DIR/phi"
case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*) echo "Add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
"$INSTALL_DIR/phi" --version || true
