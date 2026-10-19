#!/usr/bin/env bash
# Runs secret-outputs.sh on the runner's OS image. Usage: .github/actions/secret-outputs/secret-outputs.test.sh
# Needs Docker; set SECRET_OUTPUTS_TEST_INNER=1 to run the checks on a machine that already has gpg.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [[ "${SECRET_OUTPUTS_TEST_INNER:-}" != "1" ]]; then
  exec docker run --rm -v "$here:/action:ro" -e SECRET_OUTPUTS_TEST_INNER=1 ubuntu:24.04 bash -c \
    'apt-get update -qq >/dev/null && apt-get install -y -qq gnupg procps >/dev/null && bash /action/secret-outputs.test.sh'
fi

script="$here/secret-outputs.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Literal `$` and quotes: neither value may be expanded on the way through.
# shellcheck disable=SC2016
passphrase='correct horse $battery "staple"'
# shellcheck disable=SC2016
value='postgresql://user:p%40ss w0rd@ep-preview.example/neondb?sslmode=require&x=$HOME'
failures=0

check() {
  if [[ "$2" == "$3" ]]; then echo "ok   $1"; else
    echo "FAIL $1"
    failures=$((failures + 1))
  fi
}

# Runs the action script and prints the `out` value it wrote; stdout and stderr go to files.
run() {
  local op="$1" in="$2" secret="$3" output="$work/output"
  : >"$output"
  GITHUB_OUTPUT="$output" SECRET_OUTPUTS_OP="$op" SECRET_OUTPUTS_IN="$in" \
    SECRET_OUTPUTS_PASSPHRASE="$secret" "$script" >"$work/stdout" 2>"$work/stderr" || return 1
  local delimiter
  delimiter="$(head -1 "$output" | sed 's/^out<<//')"
  sed '1d;$d' "$output"
  [[ "$(tail -1 "$output")" == "$delimiter" ]]
}

ciphertext="$(run encode "$value" "$passphrase")"
check "encode writes one base64 line" "$(printf '%s' "$ciphertext" | tr -d 'A-Za-z0-9+/=')" ""
check "encode masks the value" "$(grep -c "::add-mask::$value" "$work/stdout")" "1"
check "decode returns the exact value" "$(run decode "$ciphertext" "$passphrase")" "$value"
check "decode masks the value" "$(grep -c "::add-mask::$value" "$work/stdout")" "1"
check "decode prints the value only in its mask" "$(grep -v '::add-mask::' "$work/stdout" "$work/stderr" | grep -cF "$value" || true)" "0"

# The cloudposse encoder, verbatim, so a ciphertext it stored still decodes.
legacy="$(GNUPGHOME="$(mktemp -d)" gpg --symmetric --batch --passphrase "$passphrase" --output - <(echo "$value") | base64 -w0)"
check "decodes the cloudposse format" "$(run decode "$legacy" "$passphrase")" "$value"

if run decode "$ciphertext" "wrong passphrase" >/dev/null; then wrong="decoded"; else wrong="failed"; fi
check "a wrong passphrase fails" "$wrong" "failed"
check "a failed decode never prints the value" "$(cat "$work/stdout" "$work/stderr" | grep -cF "$value" || true)" "0"

if run rotate "$value" "$passphrase" >/dev/null; then bad="ran"; else bad="failed"; fi
check "an unknown op fails" "$bad" "failed"
if run encode "" "$passphrase" >/dev/null; then empty="ran"; else empty="failed"; fi
check "an empty value fails" "$empty" "failed"

injected=$'a\nout=injected'
check "a newline in the value cannot add an output" "$(run decode "$(run encode "$injected" "$passphrase")" "$passphrase")" "$injected"
# Parses the file as the runner does: `name<<delimiter` blocks and `name=value` lines.
outputs="$(awk '
  delimiter != "" { if ($0 == delimiter) delimiter = ""; next }
  /^[^=<]+<</ { split($0, part, "<<"); print part[1]; delimiter = part[2]; next }
  /^[^=]+=/ { split($0, part, "="); print part[1] }
' "$work/output")"
check "the runner reads exactly one output, out" "$outputs" "out"

# Samples the process table while gpg runs and looks for the passphrase in any command line.
( for _ in $(seq 1 200); do ps -eo args; done >"$work/ps" ) &
sampler=$!
for _ in 1 2 3; do run encode "$value" "$passphrase" >/dev/null; done
wait "$sampler"
check "the sampler saw gpg running" "$(grep -q 'gpg --batch' "$work/ps" && echo yes || echo no)" "yes"
check "the passphrase never appears in a process listing" "$(grep -cF 'battery' "$work/ps" || true)" "0"

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
