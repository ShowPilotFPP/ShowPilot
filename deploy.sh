#!/bin/bash
# ============================================================
# OpenFalcon — Deploy Script
# Run on the server (e.g. /opt/openfalcon) to update to latest.
# ============================================================
set -e

cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}→ Pulling latest from git...${NC}"
git pull

echo -e "${YELLOW}→ Installing/updating dependencies...${NC}"
npm install --omit=dev

# Reload via PM2 if it's managing the process; otherwise tell the user
if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q openfalcon; then
  echo -e "${YELLOW}→ Reloading openfalcon (PM2)...${NC}"
  pm2 reload openfalcon
  echo
  pm2 list | grep openfalcon || true
else
  echo -e "${YELLOW}⚠ PM2 not managing openfalcon. Restart the server manually.${NC}"
fi

echo
echo -e "${GREEN}✓ Deploy complete.${NC}"
