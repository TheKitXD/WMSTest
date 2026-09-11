const express = require("express");
const path = require("path");
const store = require("./store");
const { generateEDI856 } = require("./edi856");
const { generateInvoicePDF } = require("./invoicePdf");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// This is the endpoint Roblox's ScanService would POST to - the shape here
// intentionally matches what ScanService.PerformScan already returns, so a
// scan result can be forwarded with little to no reshaping on the Roblox
// side. See the comment at the bottom of this file for the expected body.
app.post("/api/scan", (req, res) => {
	const body = req.body;

	if (!body || (body.Type !== "Box" && body.Type !== "Pallet")) {
		return res.status(400).json({ error: "Body must include Type: 'Box' or 'Pallet'" });
	}

	try {
		if (body.Type === "Pallet") {
			const pallet = store.recordPalletScan(body);
			return res.json({ ok: true, pallet });
		} else {
			const palletId = body.PalletId || req.query.palletId;
			const box = store.recordBoxScan(body, palletId);
			return res.json({ ok: true, box });
		}
	} catch (err) {
		return res.status(400).json({ error: err.message });
	}
});

// Manual box-to-pallet linking, for boxes scanned without a known pallet yet.
app.post("/api/pallets/:palletId/boxes/:barcodeId", (req, res) => {
	try {
		const box = store.attachBoxToPallet(req.params.barcodeId, req.params.palletId);
		res.json({ ok: true, box });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

// Mark a pallet picked (ready to load) or un-pick it.
// Body: { "picked": true } or { "picked": false }
app.post("/api/pallets/:palletId/pick", (req, res) => {
	try {
		const picked = req.body ? req.body.picked : true;
		const pallet = store.setPalletPicked(req.params.palletId, picked);
		res.json({ ok: true, pallet });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

// Finalize an invoice as shipped.
// Body (optional): { carrier, trackingNumber }
app.post("/api/invoices/:invoiceId/ship", (req, res) => {
	try {
		const { carrier, trackingNumber } = req.body || {};
		const invoice = store.shipInvoice(req.params.invoiceId, { carrier, trackingNumber });
		res.json({ ok: true, invoice });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

app.get("/api/invoices/:invoiceId/pdf", (req, res) => {
	const detail = store.getInvoiceDetail(req.params.invoiceId);
	if (!detail) return res.status(404).json({ error: "Invoice not found" });
	res.setHeader("Content-Type", "application/pdf");
	res.setHeader("Content-Disposition", `inline; filename="Invoice_${detail.invoiceId}.pdf"`);
	const doc = generateInvoicePDF(detail);
	doc.pipe(res);
});

app.get("/api/invoices", (req, res) => {
	res.json(store.listInvoices());
});

app.get("/api/invoices/:invoiceId", (req, res) => {
	const detail = store.getInvoiceDetail(req.params.invoiceId);
	if (!detail) return res.status(404).json({ error: "Invoice not found" });
	res.json(detail);
});

app.get("/api/invoices/:invoiceId/edi856", (req, res) => {
	const detail = store.getInvoiceDetail(req.params.invoiceId);
	if (!detail) return res.status(404).json({ error: "Invoice not found" });
	const edi = generateEDI856(detail);
	res.type("text/plain").send(edi);
});

// --- Product catalog ---

app.get("/api/products", (req, res) => {
	res.json(store.listProducts());
});

app.post("/api/products", (req, res) => {
	try {
		const product = store.addProduct(req.body || {});
		res.json({ ok: true, product });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

// Available (unallocated) pallets for a given product - used when building
// a purchase order's pallet picker.
app.get("/api/products/:productId/pallets", (req, res) => {
	res.json(store.getAvailablePalletsForProduct(req.params.productId));
});

// --- Warehouse inventory (pallets) ---

// Register a new pallet, or update an existing one's product info.
// Body: { palletId, productId, description, quantity }
app.post("/api/pallets", (req, res) => {
	try {
		const pallet = store.registerInventoryPallet(req.body || {});
		res.json({ ok: true, pallet });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

app.get("/api/pallets/search", (req, res) => {
	res.json(store.searchPallets(req.query.q));
});

app.get("/api/pallets/:palletId", (req, res) => {
	const pallet = store.getPallet(req.params.palletId);
	if (!pallet) return res.status(404).json({ error: "Pallet not found" });
	res.json(pallet);
});

// Corrective adjustment to a pallet's counted quantity.
// Body: { quantity, reason }
app.post("/api/pallets/:palletId/adjust", (req, res) => {
	try {
		const { quantity, reason } = req.body || {};
		const pallet = store.adjustPalletQuantity(req.params.palletId, quantity, reason);
		res.json({ ok: true, pallet });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

// Manual hand-off: moves a purchase order into In-Progress for a picker.
app.post("/api/invoices/:invoiceId/send-to-in-progress", (req, res) => {
	try {
		const invoice = store.sendToInProgress(req.params.invoiceId);
		res.json({ ok: true, invoice });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

// --- Purchase orders ---
// Body: { customerName, lineItems: [{ productId, quantityOrdered }] }
// Just product + quantity - no pallet selection. Which physical pallets
// fulfill this is a picker's job, done later.
app.post("/api/purchase-orders", (req, res) => {
	try {
		const invoice = store.createPurchaseOrder(req.body || {});
		res.json({ ok: true, invoice });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Delivery tracking backend running on port ${PORT}`);
});

/*
EXPECTED POST /api/scan BODY SHAPES
(matching ScanService.PerformScan's return values exactly):

Pallet:
{
  "Type": "Pallet",
  "PalletId": "58692959",
  "InvoiceId": "756672",
  "LocationNumber": "1491",
  "LocationNumber2": null,
  "StagingNumber": 1,
  "StagingMaxNumber": 4,
  "RouteNumber": "5602"
}

Box:
{
  "Type": "Box",
  "BarcodeId": "79393253",
  "PalletId": "58692959"   // optional - Roblox doesn't send this yet, see store.js
}
*/
