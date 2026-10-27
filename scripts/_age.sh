# Shared by secrets.sh and fetch-age.sh (ported from the Zold app). Source it; do not run it.
#
# age is vendored under .toolchain/ like node: a pinned release whose SHA-256
# is checked before it is unpacked. The digests are GitHub's own for the
# release assets (api.github.com/repos/FiloSottile/age/releases/tags/v1.3.2).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGE_VERSION="v1.3.2"
AGE_DIR="$ROOT/.toolchain/age-$AGE_VERSION"
AGE="$AGE_DIR/age/age"
AGE_KEYGEN="$AGE_DIR/age/age-keygen"
# Public keys only; one per line. Gitignored because it is per-developer.
AGE_RECIPIENTS="${AGE_RECIPIENTS_FILE:-$ROOT/.age-recipients}"
# The identity (the private key) lives in the macOS Keychain under this name,
# unless AGE_IDENTITY_FILE points at one (an age-plugin-yubikey stub, say).
AGE_KEYCHAIN_SERVICE="shareme-age-identity"

age_asset() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "age-$AGE_VERSION-darwin-arm64.tar.gz e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5" ;;
    Darwin-x86_64) echo "age-$AGE_VERSION-darwin-amd64.tar.gz 1d1e4bc66e1427edad7739ae7616157de0e79db8b6d2a1497d7d9925fb06a539" ;;
    Linux-x86_64) echo "age-$AGE_VERSION-linux-amd64.tar.gz cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10" ;;
    *) echo "no pinned age build for $(uname -s)-$(uname -m)" >&2; return 1 ;;
  esac
}

require_age() {
  [[ -x "$AGE" ]] || { echo "age is not installed: run scripts/fetch-age.sh" >&2; exit 1; }
}

require_recipients() {
  [[ -s "$AGE_RECIPIENTS" ]] || { echo "no recipients in $AGE_RECIPIENTS: run scripts/secrets.sh init" >&2; exit 1; }
}

# Prints the identity to stdout, for a process substitution. Never to a file.
age_identity() {
  if [[ -n "${AGE_IDENTITY_FILE:-}" ]]; then
    cat "$AGE_IDENTITY_FILE"
  else
    security find-generic-password -s "$AGE_KEYCHAIN_SERVICE" -a "${USER:-$(id -un)}" -w
  fi
}
