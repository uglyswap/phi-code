#!/bin/sh
# Install Phi Code standalone binary.
#   curl -fsSL https://raw.githubusercontent.com/uglyswap/phi-code/main/scripts/install.sh | sh
# Options:
#   PHI_VERSION       release to install (default: latest)
#   PHI_INSTALL_DIR   directory for the `phi` launcher (default: ~/.local/bin)
#   PHI_INSTALL_ROOT  directory for the release files (default: ${XDG_DATA_HOME:-~/.local/share}/phi)
#
# The Bun executable reads package.json, theme/, export-html/, assets/ and the
# native helpers from the directory it lives in: without package.json it falls
# back to the upstream identity (name "pi", config dir ~/.pi, version 0.0.0).
# The whole archive is therefore installed under PHI_INSTALL_ROOT and only a
# small launcher goes on the PATH.
set -eu

REPO="uglyswap/phi-code"
INSTALL_DIR="${PHI_INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_ROOT="${PHI_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/phi}"
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

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		echo "sha256sum or shasum is required to verify the download" >&2
		exit 1
	fi
}

PLATFORM="$(detect_platform)"
ASSET="phi-${PLATFORM}.tar.gz"

if [ "$VERSION" = "latest" ]; then
	BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
	BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION#v}"
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${BASE_URL}/${ASSET}"
curl -fsSL "${BASE_URL}/${ASSET}" -o "$TMP/$ASSET"
# The release workflow publishes one SHA256SUMS file covering every asset.
curl -fsSL "${BASE_URL}/SHA256SUMS" -o "$TMP/SHA256SUMS"

expected="$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$TMP/SHA256SUMS")"
[ -n "$expected" ] || { echo "SHA256SUMS has no entry for $ASSET" >&2; exit 1; }
actual="$(sha256_of "$TMP/$ASSET")"
if [ "$expected" != "$actual" ]; then
	echo "Checksum mismatch for $ASSET: expected $expected, got $actual" >&2
	exit 1
fi
echo "Checksum verified"

mkdir -p "$TMP/extract"
tar -xzf "$TMP/$ASSET" -C "$TMP/extract"
# Unix archives wrap their content in a top-level phi/ directory.
SRC="$TMP/extract/phi"
[ -f "$SRC/phi" ] || { echo "Archive did not contain phi/phi" >&2; exit 1; }
[ -f "$SRC/package.json" ] || { echo "Archive did not contain phi/package.json" >&2; exit 1; }

# Copy the release files over the previous install. The executable is moved
# aside first and replaced by rename, which works while an old phi is running.
mkdir -p "$INSTALL_ROOT"
mv "$SRC/phi" "$TMP/phi.bin"
# Unlink every file about to be replaced first: cp writes into the existing
# inode, which corrupts the native modules (libonnxruntime, sharp, ast-grep,
# clipboard *.node) mapped by a phi that is still running. A running process
# keeps the unlinked inode; the copy gets a new one.
(cd "$SRC" && find . \( -type f -o -type l \) -print) | while IFS= read -r file; do
	rm -f "$INSTALL_ROOT/$file"
done
# Directories shipped by the archive (node_modules, extensions, theme, ...) are
# replaced wholesale so files of older releases do not pile up. Removing them is
# safe while phi runs: open files keep their unlinked inodes.
for dir in "$SRC"/*/; do
	[ -d "$dir" ] || continue
	name="$(basename "$dir")"
	rm -rf "${INSTALL_ROOT:?}/$name"
done
cp -R "$SRC/." "$INSTALL_ROOT/"
cp "$TMP/phi.bin" "$INSTALL_ROOT/.phi.new"
chmod +x "$INSTALL_ROOT/.phi.new"
mv -f "$INSTALL_ROOT/.phi.new" "$INSTALL_ROOT/phi"

# Launcher: exec the real binary so it resolves its files from INSTALL_ROOT.
mkdir -p "$INSTALL_DIR"
launcher_tmp="$INSTALL_DIR/.phi.launcher.$$"
escaped_root="$(printf '%s' "$INSTALL_ROOT" | sed "s/'/'\\\\''/g")"
printf "#!/bin/sh\nexec '%s/phi' \"\$@\"\n" "$escaped_root" > "$launcher_tmp"
chmod +x "$launcher_tmp"
mv -f "$launcher_tmp" "$INSTALL_DIR/phi"

echo "Installed phi to $INSTALL_ROOT (launcher: $INSTALL_DIR/phi)"
case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*) echo "Add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
"$INSTALL_DIR/phi" --version || true
