# Manifest

Backend + dashboard for the Roblox delivery/scanning system. Receives scan
events from `ScanService.lua`, tracks them as Invoice → Pallet → Box, and
generates EDI 856 Advance Ship Notices you can view or download per invoice.

## Run it locally

```
npm install
npm start
```

Opens on http://localhost:3000. Scan a pallet in Studio (with
`WEBSITE_BASE_URL` pointed at a real deployed URL - Roblox can't reach
`localhost`) or simulate one with curl:

```bash
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"Type":"Pallet","PalletId":"58692959","InvoiceId":"756672","LocationNumber":"1491","StagingNumber":1,"StagingMaxNumber":4,"RouteNumber":"5602"}'

curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"Type":"Box","BarcodeId":"79393253","PalletId":"58692959"}'
```

Then open the dashboard and the invoice should appear within a few seconds
(it polls every 4s).

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render → New Web Service → connect the repo.
3. Environment should auto-detect as **Node** once `package.json` is in the
   repo (if it doesn't, pick Node manually in the setup screen).
4. Build command: `npm install`. Start command: `npm start`.
5. Deploy. You'll get a URL like `https://yourapp.onrender.com`.

## Connect Roblox to it

In `ScanService.lua`, set:

```lua
local WEBSITE_BASE_URL = "https://yourapp.onrender.com"
```

and make sure HTTP Requests are enabled under Game Settings > Security in
Studio. Every successful scan will then POST to `/api/scan` and show up on
the dashboard.

## What's here

- `server.js` — Express app, API routes, serves the dashboard.
- `store.js` — in-memory data model (Invoice → Pallet → Box). Resets on
  restart. Swap this for a real database when you're past the concept stage.
- `edi856.js` — generates the actual EDI 856 ASN text from an invoice's
  data. Structure is a real, valid X12 856 (Shipment/Order/Pack/Item
  hierarchy), but sender/receiver IDs and ship-from/ship-to names are
  placeholders - see the comment at the top of that file.
- `public/` — the dashboard (vanilla HTML/CSS/JS, no build step).

## Known gaps (concept stage)

- **Storage is in-memory.** Every scan is lost on server restart/redeploy.
  Fine for testing, not fine for production - add a real database
  (Postgres, MongoDB, etc.) before this goes anywhere near real inventory.
- **EDI placeholders.** `senderId`, `receiverId`, `shipFromName`,
  `shipToName` in `edi856.js` are hardcoded placeholders. Real EDI trading
  partners each have their own implementation guide specifying exact
  qualifiers/IDs - you'll need theirs once you have an actual partner.
- **REF*ZZ for route/location/staging.** These aren't standard 856 fields,
  so they're carried as "Mutually Defined" reference segments. That's
  normal EDI practice for partner-specific data, but confirm the actual
  qualifier codes your trading partner expects, if any.
