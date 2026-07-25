#!/usr/bin/env bash
#
# Turn an Apple **Developer ID Application** certificate into the GitHub secrets
# the release workflow reads, without needing a Mac.
#
# Inputs (in packages/harness-desktop/.cert/, which is gitignored — never commit
# any of it):
#   devid.key                     the private key the CSR was generated from
#   *.cer                         the Developer ID Application certificate
#
# Sets: CSC_LINK, CSC_KEY_PASSWORD, APPLE_TEAM_ID.
# You must set APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD yourself (or export them
# before running and this will set them too) — they're account credentials, not
# derivable from the certificate.
#
# Re-run this whenever the certificate is renewed (Apple issues them for 1 year).
#
# Usage:  packages/harness-desktop/scripts/mac-signing-secrets.sh [path/to.cer]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_dir="$here/../.cert"
key="$cert_dir/devid.key"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$key" ] || die "missing private key: $key"

# Pick the certificate: an explicit argument, else the only .cer in .cert/.
if [ $# -ge 1 ]; then
  cer="$1"
else
  mapfile -t candidates < <(find "$cert_dir" -maxdepth 1 -name "*.cer" | sort)
  [ ${#candidates[@]} -gt 0 ] || die "no .cer found in $cert_dir"
  [ ${#candidates[@]} -eq 1 ] || die "several .cer files in $cert_dir — pass the one to use as an argument:$(printf '\n  %s' "${candidates[@]}")"
  cer="${candidates[0]}"
fi
[ -f "$cer" ] || die "no such certificate: $cer"

subject="$(openssl x509 -inform DER -in "$cer" -noout -subject)"

# GUARD: the whole point of this check. An "Apple Development" / "Mac Developer"
# certificate looks superficially fine (it even says Code Signing) but Apple's
# notary service rejects it, and Gatekeeper still blocks the app on any Mac that
# isn't in the team's provisioning profile — so signing with it achieves nothing
# for distribution. Only a Developer ID Application cert works outside the store.
case "$subject" in
  *"Developer ID Application"*) : ;;
  *)
    die "$(printf 'not a Developer ID Application certificate:\n  %s\n\nCreate the right one at developer.apple.com → Certificates → + → Software →\n"Developer ID Application", reusing devid.certSigningRequest. Note that only\nthe team'"'"'s ACCOUNT HOLDER may create Developer ID certificates.' "$subject")"
    ;;
esac

# The certificate must belong to this key, or codesign gets an unusable identity.
key_mod="$(openssl rsa -in "$key" -noout -modulus | openssl sha256)"
cer_mod="$(openssl x509 -inform DER -in "$cer" -noout -modulus | openssl sha256)"
[ "$key_mod" = "$cer_mod" ] || die "certificate does not match devid.key (different keypair)"

# OU is the Team ID in every Apple-issued certificate.
team_id="$(sed -n 's/.*OU=\([A-Z0-9]*\).*/\1/p' <<<"$subject")"
[ -n "$team_id" ] || die "could not read the Team ID (OU) from: $subject"

echo "certificate : ${subject#subject=}"
echo "team id     : $team_id"
echo "expires     : $(openssl x509 -inform DER -in "$cer" -noout -enddate | cut -d= -f2)"

# Build the .p12 electron-builder imports. -legacy is REQUIRED on OpenSSL 3:
# without it the archive uses AES-256, which macOS's keychain refuses to import.
p12="$cert_dir/devid.p12"
pem="$cert_dir/.cert.pem.tmp"
p12_password="$(openssl rand -base64 24)"
trap 'rm -f "$pem"' EXIT

openssl x509 -inform DER -in "$cer" -out "$pem"
openssl pkcs12 -export -legacy \
  -out "$p12" \
  -inkey "$key" \
  -in "$pem" \
  -name "Sapiom Developer ID Application" \
  -passout pass:"$p12_password"
chmod 600 "$p12"
echo "wrote       : $p12 (gitignored)"

command -v gh >/dev/null || die "gh CLI not found — cannot set secrets"

# Nothing sensitive is echoed: values go to gh over stdin.
base64 -w0 "$p12" | gh secret set CSC_LINK
printf '%s' "$p12_password" | gh secret set CSC_KEY_PASSWORD
printf '%s' "$team_id" | gh secret set APPLE_TEAM_ID
echo "set secrets : CSC_LINK, CSC_KEY_PASSWORD, APPLE_TEAM_ID"

# Optional convenience: if the account credentials are already exported, set them
# too, so one run finishes the whole configuration.
if [ -n "${APPLE_ID:-}" ]; then
  printf '%s' "$APPLE_ID" | gh secret set APPLE_ID
  echo "set secrets : APPLE_ID"
fi
if [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | gh secret set APPLE_APP_SPECIFIC_PASSWORD
  echo "set secrets : APPLE_APP_SPECIFIC_PASSWORD"
fi

echo
echo "Remaining, if not listed above:"
echo "  gh secret set APPLE_ID                       # the Apple ID email on the developer account"
echo "  gh secret set APPLE_APP_SPECIFIC_PASSWORD    # appleid.apple.com → Sign-In and Security"
echo
echo "Then tag to ship:  git tag harness-desktop-v0.1.0 && git push origin harness-desktop-v0.1.0"
