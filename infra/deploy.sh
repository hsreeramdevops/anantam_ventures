#!/usr/bin/env bash
# Provisions everything into the personal subscription. Review README "Cost" before running.
# Usage: ADMIN_EMAIL=you@example.com ./infra/deploy.sh
set -euo pipefail

SUBSCRIPTION=240b9dac-6757-42ad-84c4-b1d8c54fcb5c
RG=${RG:-anantam-rg}
LOCATION=${LOCATION:-centralindia}
BUDGET=${BUDGET:-20}
: "${ADMIN_EMAIL:?Set ADMIN_EMAIL to the first admin / budget alert email}"
cd "$(dirname "$0")"

az account set --subscription "$SUBSCRIPTION"
[ "$(az account show --query id -o tsv)" = "$SUBSCRIPTION" ] || { echo "Wrong subscription"; exit 1; }

# Cosmos free tier is limited to one account per subscription.
if az cosmosdb list --query "[?enableFreeTier].name" -o tsv | grep -q .; then
  echo "A free-tier Cosmos account already exists in this subscription; refusing to create a paid one."; exit 1
fi

az deployment sub create -n anantam-budget -l "$LOCATION" -f budget.bicep \
  -p amount="$BUDGET" contactEmails="[\"$ADMIN_EMAIL\"]" startDate="$(date -u +%Y-%m-01)" -o none

az group create -n "$RG" -l "$LOCATION" --tags app=anantam-ventures -o none
az deployment group create -g "$RG" -n anantam -f main.bicep \
  -p location="$LOCATION" bootstrapAdminEmail="$ADMIN_EMAIL" \
     jwtSecret="$(openssl rand -hex 32)" jobKey="$(openssl rand -hex 24)" \
  --query properties.outputs -o json

SWA=$(az staticwebapp list -g "$RG" --query "[0].name" -o tsv)
echo
echo "Next: add these GitHub repo secrets (Settings → Secrets → Actions):"
echo "  AZURE_STATIC_WEB_APPS_API_TOKEN = \$(az staticwebapp secrets list -n $SWA -g $RG --query properties.apiKey -o tsv)"
echo "  APP_URL = https://\$(az staticwebapp show -n $SWA -g $RG --query defaultHostname -o tsv)"
echo "  JOB_KEY = \$(az staticwebapp appsettings list -n $SWA -g $RG --query properties.JOB_KEY -o tsv)"
