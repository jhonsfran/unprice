#!/usr/bin/env bash
# Encrypts a job output with a shared passphrase (op=encode) or decrypts it (op=decode).
# The ciphertext format matches cloudposse/github-action-secret-outputs: gpg symmetric, base64
# without wrapping. Unlike it, the passphrase reaches gpg through a pipe instead of its argv,
# outputs use a random delimiter so a value cannot inject another output, and gpg runs in a
# throwaway home with no passphrase cache.
set -euo pipefail
umask 077

fail() {
  echo "::error::secret-outputs: $1" >&2
  exit 1
}

op="${SECRET_OUTPUTS_OP:-}"
value="${SECRET_OUTPUTS_IN:-}"
passphrase="${SECRET_OUTPUTS_PASSPHRASE:-}"
unset SECRET_OUTPUTS_IN SECRET_OUTPUTS_PASSPHRASE

[[ -n "$passphrase" ]] || fail "secret is empty"
[[ -n "$value" ]] || fail "in is empty"
[[ -n "${GITHUB_OUTPUT:-}" ]] || fail "GITHUB_OUTPUT is not set"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
cleanup() {
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$GNUPGHOME"
}
trap cleanup EXIT

# printf is a builtin, so neither the value nor the passphrase appears in a process listing.
run_gpg() {
  gpg --batch --quiet --no-tty --yes --pinentry-mode loopback --no-symkey-cache \
    --passphrase-fd 3 "$@" 3< <(printf '%s' "$passphrase")
}

# The runner hides a value only line by line.
mask() {
  printf '%s\n' "$1" | while IFS= read -r line; do
    [[ -z "$line" ]] || echo "::add-mask::$line"
  done
}

write_output() {
  local delimiter
  delimiter="SECRET_OUTPUTS_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$1" != *"$delimiter"* ]] || fail "value contains the output delimiter"
  printf 'out<<%s\n%s\n%s\n' "$delimiter" "$1" "$delimiter" >>"$GITHUB_OUTPUT"
}

case "$op" in
  encode)
    mask "$value"
    ciphertext="$(printf '%s' "$value" |
      run_gpg --symmetric --cipher-algo AES256 \
        --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --output - |
      base64 -w0)"
    write_output "$ciphertext"
    ;;
  decode)
    # Command substitution drops trailing newlines, as the cloudposse decoder did, so values it
    # encoded with a trailing newline decode to the same string.
    plaintext="$(printf '%s' "$value" | base64 --decode | run_gpg --decrypt --output -)" ||
      fail "could not decrypt in"
    [[ -n "$plaintext" ]] || fail "decrypted value is empty"
    mask "$plaintext"
    write_output "$plaintext"
    ;;
  *)
    fail "op must be encode or decode"
    ;;
esac
