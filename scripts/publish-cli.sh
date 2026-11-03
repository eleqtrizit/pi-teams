#!/bin/sh
# Build and publish @eleqtrizit/pi-teams-cli. Run from anywhere; needs an npm
# login with rights to the @eleqtrizit scope. Run the tests first: npm test
set -eu
cd "$(dirname "$0")/.."
node scripts/build-cli.mjs
cd cli
npm publish --access public
