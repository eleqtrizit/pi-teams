#!/bin/sh
# Build and publish @eleqtrizit/pi-teams-cli. Run from anywhere; needs an npm
# login with rights to the @eleqtrizit scope. Run the tests first: npm test
# Usage: sh scripts/publish-cli.sh [OTP]   (OTP is your authenticator code)
set -eu
cd "$(dirname "$0")/.."
node scripts/build-cli.mjs
cd cli
if [ $# -gt 0 ]; then
  npm publish --access public --otp="$1"
else
  npm publish --access public
fi
