#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
node --version
npm ci --no-audit --no-fund
npm run build
npm test
