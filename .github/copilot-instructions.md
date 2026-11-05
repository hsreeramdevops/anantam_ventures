# Copilot instructions — anantam_ventures

## Rule #1 — cost and deployment (non-negotiable)

- This is a personal project in a **public** GitHub repo. Never commit secrets, keys, connection strings, or `.env` files.
- All Azure resources deploy **only** to subscription `240b9dac-6757-42ad-84c4-b1d8c54fcb5c`
  (Visual Studio Enterprise, $150/month credit).
- **Total monthly spend must never exceed $150.** Design for ~$0–10/month:
  - Prefer free tiers (Static Web Apps Free, Cosmos DB free tier, Document Intelligence F0, consumption plans).
  - No always-on VMs, App Service plans above Free/B1, AKS, premium SKUs, or reserved capacity without explicit approval.
  - Every new resource needs a cost estimate before it is created.
  - Keep a subscription budget with alerts in place.
