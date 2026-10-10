#!/usr/bin/env bash
chmod +x build_deploy.sh
npm install
npm run build
echo "=== ZIP CONTENTS ==="
ls -la dist/
echo "=== DEPLOY FILES ==="
ls -la vercel.json build_deploy.sh DEPLOY.md DEPLOY_README.txt
