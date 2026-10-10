#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies..."
npm install
echo "Building for deploy..."
npm run build
echo "Built successfully."
echo "Deploy to Vercel: vercel"
echo "Deploy static: upload the contents of dist/"
