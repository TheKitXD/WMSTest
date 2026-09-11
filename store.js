// In-memory data store.
//
// This is deliberately NOT a database yet - it's here so the concept is
// fully testable end to end before you add persistence. Everything lives
// in these Maps and resets when the server restarts.
//
// PALLET-LEVEL FULFILLMENT
// Purchase orders are picked by whole pallet, never by case/box. A pallet's
// "quantity" field is how many units are on it (informational, correctable
// via adjustPalletQuantity), but ordering, allocation, and picking all
// operate on pallets as the atomic unit - never on individual boxes.
// Boxes scanned on a pallet are descriptive detail only; they don't count
// toward order quantities anywhere in this file.

// invoiceId -> { invoiceId, createdAt, palletIds: Set<palletId>, status,
//                shippedAt, customerName, lineItems }
const invoices = new Map();

// palletId -> { palletId, productId, description, quantity, invoiceId,
//               locationNumber, locationNumber2, routeNumber,
//               stagingNumber, stagingMaxNumber, scannedAt, addedAt,
//               source ("scanned" | "manual"), boxIds: Set<barcodeId>,
//               picked, adjustments: [{ at, from, to, reason }] }
const pallets = new Map();

// barcodeId -> { barcodeId, palletId, scannedAt }
const boxes = new Map();

// productId -> { productId, name, description, unitOfMeasure, createdAt }
const products = new Map();

let poCounter = 100000;

function getOrCreateInvoice(invoiceId) {
	let invoice = invoices.get(invoiceId);
	if (!invoice) {
		invoice = {
			invoiceId,
			createdAt: new Date().toISOString(),
			palletIds: new Set(),
			status: "staged", // "ordered" | "staged" | "shipped"
			shippedAt: null,
			customerName: null,
			lineItems: [],
		};
		invoices.set(invoiceId, invoice);
	}
	return invoice;
}

function getOrCreatePallet(palletId) {
	let pallet = pallets.get(palletId);
	if (!pallet) {
		pallet = { palletId, boxIds: new Set(), picked: false, adjustments: [] };
		pallets.set(palletId, pallet);
	}
	return pallet;
}

function bumpToStaged(invoiceId) {
	if (!invoiceId) return;
	const invoice = invoices.get(invoiceId);
	if (invoice && invoice.status === "ordered") {
		invoice.status = "staged";
	}
}

// Records a pallet scan from Roblox. Only touches scan-specific fields -
// product info set via registerInventoryPallet (description, quantity,
// productId) is left alone if already present, so a pallet registered in
// Warehouse Inventory first and physically scanned later keeps its data.
function recordPalletScan(data) {
	const { PalletId, InvoiceId, LocationNumber, LocationNumber2, StagingNumber, StagingMaxNumber, RouteNumber } = data;
	if (!PalletId) throw new Error("recordPalletScan: PalletId is required");

	const pallet = getOrCreatePallet(String(PalletId));
	if (!pallet.source) pallet.source = "scanned";

	if (InvoiceId) {
		const invoice = getOrCreateInvoice(String(InvoiceId));
		invoice.palletIds.add(pallet.palletId);
		pallet.invoiceId = String(InvoiceId);
		bumpToStaged(invoice.invoiceId);
	}

	pallet.locationNumber = LocationNumber;
	pallet.locationNumber2 = LocationNumber2;
	pallet.stagingNumber = StagingNumber;
	pallet.stagingMaxNumber = StagingMaxNumber;
	pallet.routeNumber = RouteNumber;
	pallet.scannedAt = new Date().toISOString();
	return pallet;
}

// Records a box scan. Descriptive only - see the note at the top of this
// file. If the box isn't yet linked to a pallet, pass palletId explicitly.
function recordBoxScan(data, palletId) {
	const { BarcodeId } = data;
	if (!BarcodeId) throw new Error("recordBoxScan: BarcodeId is required");

	const box = boxes.get(String(BarcodeId)) || { barcodeId: String(BarcodeId) };
	box.scannedAt = new Date().toISOString();
	if (palletId) {
		box.palletId = String(palletId);
	}
	boxes.set(box.barcodeId, box);

	if (box.palletId && pallets.has(box.palletId)) {
		pallets.get(box.palletId).boxIds.add(box.barcodeId);
	}
	return box;
}

function attachBoxToPallet(barcodeId, palletId) {
	const box = boxes.get(String(barcodeId));
	if (!box) throw new Error(`attachBoxToPallet: unknown box ${barcodeId}`);
	const pallet = pallets.get(String(palletId));
	if (!pallet) throw new Error(`attachBoxToPallet: unknown pallet ${palletId}`);
	box.palletId = pallet.palletId;
	pallet.boxIds.add(box.barcodeId);
	return box;
}

// Marks a pallet as picked (physically pulled/staged) or un-picks it.
function setPalletPicked(palletId, picked) {
	const pallet = pallets.get(String(palletId));
	if (!pallet) throw new Error(`setPalletPicked: unknown pallet ${palletId}`);
	pallet.picked = Boolean(picked);
	if (pallet.picked) bumpToStaged(pallet.invoiceId);
	return pallet;
}

// Explicit, manual hand-off: moves a purchase order into In-Progress so a
// picker knows to start on it. This is separate from (and in addition to)
// the automatic bump that happens if a real pallet gets scanned against
// this invoice in Roblox before anyone clicks this.
function sendToInProgress(invoiceId) {
	const invoice = invoices.get(String(invoiceId));
	if (!invoice) throw new Error(`sendToInProgress: unknown invoice ${invoiceId}`);
	if (invoice.status !== "ordered") {
		throw new Error(`sendToInProgress: invoice ${invoiceId} is already ${invoice.status}`);
	}
	invoice.status = "staged";
	return invoice;
}

// Finalizes an invoice as shipped. Doesn't transmit anything anywhere yet -
// see the note in server.js about that being a later step. Takes a frozen
// snapshot of the full invoice/pallet/lineItem data at this exact moment,
// so a later correction to a pallet's quantity doesn't silently rewrite
// history for an invoice that's already gone out the door - see
// getInvoiceDetail below, which returns this snapshot once it exists.
function shipInvoice(invoiceId, { carrier, trackingNumber } = {}) {
	const invoice = invoices.get(String(invoiceId));
	if (!invoice) throw new Error(`shipInvoice: unknown invoice ${invoiceId}`);
	invoice.status = "shipped";
	invoice.shippedAt = new Date().toISOString();
	invoice.carrier = carrier || null;
	invoice.trackingNumber = trackingNumber || null;
	invoice.finalizedSnapshot = JSON.parse(JSON.stringify(getInvoiceDetail(invoiceId)));
	return invoice;
}

// --- Product catalog (SKU master data, no quantity here) ---

function addProduct({ productId, name, description, unitOfMeasure }) {
	if (!productId) throw new Error("addProduct: productId is required");
	if (!name) throw new Error("addProduct: name is required");
	const product = {
		productId: String(productId),
		name,
		description: description || "",
		unitOfMeasure: unitOfMeasure || "pallet",
		createdAt: new Date().toISOString(),
	};
	products.set(product.productId, product);
	return product;
}

function listProducts() {
	// Includes a live count of available (unallocated) pallets per product,
	// derived from actual inventory rather than a manually-tracked counter.
	return Array.from(products.values()).map((p) => ({
		...p,
		availablePallets: Array.from(pallets.values()).filter((pl) => pl.productId === p.productId && !pl.invoiceId).length,
		totalPallets: Array.from(pallets.values()).filter((pl) => pl.productId === p.productId).length,
	}));
}

// --- Warehouse inventory: pallets as the real, trackable unit ---

// Registers a new pallet in inventory, or updates an existing one's product
// info (e.g. a pallet that was scanned in Roblox before its details were
// entered here). Does NOT touch scan-specific fields.
function registerInventoryPallet({ palletId, productId, description, quantity }) {
	if (!palletId) throw new Error("registerInventoryPallet: palletId is required");
	if (!productId) throw new Error("registerInventoryPallet: productId is required");
	if (!products.has(String(productId))) throw new Error(`registerInventoryPallet: unknown product ${productId}`);

	const pallet = getOrCreatePallet(String(palletId));
	if (!pallet.source) pallet.source = "manual";
	pallet.productId = String(productId);
	pallet.description = description || "";
	pallet.quantity = Number(quantity) || 0;
	if (!pallet.addedAt) pallet.addedAt = new Date().toISOString();
	return pallet;
}

// Corrective adjustment to a pallet's counted quantity (e.g. after a
// physical recount finds a discrepancy). Keeps a small audit trail.
function adjustPalletQuantity(palletId, newQuantity, reason) {
	const pallet = pallets.get(String(palletId));
	if (!pallet) throw new Error(`adjustPalletQuantity: unknown pallet ${palletId}`);
	const qty = Number(newQuantity);
	if (Number.isNaN(qty) || qty < 0) throw new Error("adjustPalletQuantity: quantity must be a non-negative number");

	pallet.adjustments.push({
		at: new Date().toISOString(),
		from: pallet.quantity ?? null,
		to: qty,
		reason: reason || "",
	});
	pallet.quantity = qty;
	return pallet;
}

function palletWithProductName(pallet) {
	const product = pallet.productId ? products.get(pallet.productId) : null;
	return {
		...pallet,
		boxIds: undefined,
		boxes: Array.from(pallet.boxIds || [])
			.map((barcodeId) => boxes.get(barcodeId))
			.filter(Boolean),
		productName: product ? product.name : null,
	};
}

function getPallet(palletId) {
	const pallet = pallets.get(String(palletId));
	if (!pallet) return null;
	return palletWithProductName(pallet);
}

// Search by pallet ID or product name - powers the Products tab's lookup.
function searchPallets(query) {
	const q = String(query || "").toLowerCase().trim();
	const all = Array.from(pallets.values());
	const matches = q
		? all.filter((p) => {
				const product = p.productId ? products.get(p.productId) : null;
				return p.palletId.toLowerCase().includes(q) || (product && product.name.toLowerCase().includes(q));
		  })
		: all;
	return matches.map(palletWithProductName);
}

function getAvailablePalletsForProduct(productId) {
	return Array.from(pallets.values())
		.filter((p) => p.productId === String(productId) && !p.invoiceId)
		.map(palletWithProductName);
}

// --- Purchase orders ---
// Picked by pallet, not case: each line item is a specific set of pallet
// IDs, not a quantity number. Creating a PO immediately allocates those
// pallets (sets their invoiceId) - "ordered" means allocated but not yet
// physically picked; sendToInProgress() or a real Roblox scan moves it to
// "staged".
//
// Deliberately NOT selecting specific pallets here: a purchase order is
// just a request for product + quantity. Which physical pallets fulfill
// it is a picker's job, done later - that picking workflow isn't built
// yet, so line items stay abstract until real pallets get attached
// (currently only via a Roblox scan carrying a matching InvoiceId).

function createPurchaseOrder({ customerName, lineItems }) {
	if (!customerName) throw new Error("createPurchaseOrder: customerName is required");
	if (!Array.isArray(lineItems) || lineItems.length === 0) {
		throw new Error("createPurchaseOrder: at least one line item is required");
	}

	const resolvedItems = lineItems.map(({ productId, quantityOrdered }) => {
		const product = products.get(String(productId));
		if (!product) throw new Error(`createPurchaseOrder: unknown product ${productId}`);
		const qty = Number(quantityOrdered);
		if (!qty || qty <= 0) throw new Error(`createPurchaseOrder: invalid quantity for ${product.name}`);
		return { productId: product.productId, name: product.name, unitOfMeasure: product.unitOfMeasure, quantityOrdered: qty };
	});

	poCounter += 1;
	const invoiceId = String(poCounter);

	const invoice = {
		invoiceId,
		createdAt: new Date().toISOString(),
		palletIds: new Set(),
		status: "ordered",
		shippedAt: null,
		customerName,
		lineItems: resolvedItems,
	};
	invoices.set(invoiceId, invoice);
	return invoice;
}

function listInvoices() {
	return Array.from(invoices.values()).map((inv) => ({
		invoiceId: inv.invoiceId,
		createdAt: inv.createdAt,
		palletCount: inv.palletIds.size,
		status: inv.status,
		shippedAt: inv.shippedAt,
		customerName: inv.customerName,
		carrier: inv.carrier || null,
		trackingNumber: inv.trackingNumber || null,
	}));
}

// Full, nested view of one invoice: invoice -> pallets -> boxes.
// This is what both the EDI 856 generator, the PDF, and the dashboard
// consume. Once an invoice is shipped, this returns the frozen snapshot
// taken at that moment (see shipInvoice) rather than re-deriving from
// live pallet data, so a later corrective adjustment can't retroactively
// change a document that's already gone out.
function getInvoiceDetail(invoiceId) {
	const invoice = invoices.get(String(invoiceId));
	if (!invoice) return null;

	if (invoice.status === "shipped" && invoice.finalizedSnapshot) {
		return invoice.finalizedSnapshot;
	}

	const palletList = Array.from(invoice.palletIds)
		.map((palletId) => pallets.get(palletId))
		.filter(Boolean)
		.map((pallet) => ({
			...pallet,
			boxes: Array.from(pallet.boxIds)
				.map((barcodeId) => boxes.get(barcodeId))
				.filter(Boolean),
		}));

	return {
		invoiceId: invoice.invoiceId,
		createdAt: invoice.createdAt,
		status: invoice.status,
		shippedAt: invoice.shippedAt,
		customerName: invoice.customerName,
		carrier: invoice.carrier || null,
		trackingNumber: invoice.trackingNumber || null,
		lineItems: invoice.lineItems,
		pallets: palletList,
	};
}

module.exports = {
	recordPalletScan,
	recordBoxScan,
	attachBoxToPallet,
	setPalletPicked,
	sendToInProgress,
	shipInvoice,
	addProduct,
	listProducts,
	registerInventoryPallet,
	adjustPalletQuantity,
	getPallet,
	searchPallets,
	getAvailablePalletsForProduct,
	createPurchaseOrder,
	listInvoices,
	getInvoiceDetail,
};
