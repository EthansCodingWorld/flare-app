#!/usr/bin/env bash
# Run this ONCE locally to generate your Tauri update signing key.
# Then add the private key to GitHub Secrets as TAURI_SIGNING_PRIVATE_KEY
# and paste the public key into tauri.conf.json > plugins > updater > pubkey.

set -e

if ! command -v cargo &>/dev/null; then
  echo "Rust/cargo not found. Install from https://rustup.rs"
  exit 1
fi

cargo tauri signer generate -w ~/.tauri/flare.key

echo ""
echo "========================================="
echo "Keys written to ~/.tauri/flare.key (private) and ~/.tauri/flare.key.pub (public)"
echo ""
echo "Next steps:"
echo "  1. Copy the PUBLIC key (~/.tauri/flare.key.pub) into tauri.conf.json:"
echo '     "updater": { "pubkey": "<paste here>", ... }'
echo ""
echo "  2. Add the PRIVATE key to GitHub:"
echo "     GitHub repo → Settings → Secrets → Actions → New secret"
echo "     Name:  TAURI_SIGNING_PRIVATE_KEY"
echo "     Value: contents of ~/.tauri/flare.key"
echo ""
echo "  3. (Optional) If you set a password, also add:"
echo "     Name:  TAURI_SIGNING_KEY_PASSWORD"
echo "========================================="
