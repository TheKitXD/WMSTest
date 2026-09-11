// Generates a PDF for a finalized (shipped) invoice.
//
// Takes the same invoiceDetail shape that generateEDI856 consumes (from
// store.getInvoiceDetail) - for a shipped invoice this is the frozen
// snapshot taken at ship time, so the PDF always matches what actually
// went out, even if pallet data gets corrected afterward.

const PDFDocument = require("pdfkit");

const AMBER = "#b5790a";
const DARK = "#1a1a1a";
const GREY = "#666666";
const LINE = "#dddddd";

function formatDate(iso) {
	if (!iso) return "-";
	return new Date(iso).toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function generateInvoicePDF(invoiceDetail) {
	const doc = new PDFDocument({ size: "LETTER", margin: 50 });

	// --- Header ---
	doc.fontSize(22).fillColor(DARK).font("Helvetica-Bold").text("MANIFEST", 50, 50, { continued: true });
	doc.fillColor(AMBER).text(".");
	doc.fontSize(10).fillColor(GREY).font("Helvetica").text("Finalized Shipment / Advance Ship Notice", 50, 78);

	doc.moveTo(50, 100).lineTo(562, 100).strokeColor(AMBER).lineWidth(2).stroke();

	// --- Invoice summary block ---
	let y = 118;
	doc.fontSize(20).fillColor(DARK).font("Helvetica-Bold").text(`Invoice ${invoiceDetail.invoiceId}`, 50, y);
	y += 28;

	const summaryLeft = [
		["Customer", invoiceDetail.customerName || "-"],
		["Status", (invoiceDetail.status || "-").toUpperCase()],
		["Created", formatDate(invoiceDetail.createdAt)],
	];
	const summaryRight = [
		["Shipped", formatDate(invoiceDetail.shippedAt)],
		["Carrier", invoiceDetail.carrier || "-"],
		["Tracking #", invoiceDetail.trackingNumber || "-"],
	];

	doc.fontSize(10).font("Helvetica");
	let ly = y;
	for (const [label, value] of summaryLeft) {
		doc.fillColor(GREY).text(label, 50, ly, { width: 100, continued: false });
		doc.fillColor(DARK).font("Helvetica-Bold").text(value, 150, ly, { width: 200 });
		doc.font("Helvetica");
		ly += 18;
	}
	let ry = y;
	for (const [label, value] of summaryRight) {
		doc.fillColor(GREY).text(label, 320, ry, { width: 100, continued: false });
		doc.fillColor(DARK).font("Helvetica-Bold").text(value, 410, ry, { width: 150 });
		doc.font("Helvetica");
		ry += 18;
	}

	y = Math.max(ly, ry) + 20;

	// --- Line items ordered (summary) ---
	if (invoiceDetail.lineItems && invoiceDetail.lineItems.length > 0) {
		doc.fontSize(12).fillColor(DARK).font("Helvetica-Bold").text("Ordered", 50, y);
		y += 18;
		for (const li of invoiceDetail.lineItems) {
			doc
				.fontSize(10)
				.font("Helvetica")
				.fillColor(DARK)
				.text(`${li.quantityOrdered} pallet${li.quantityOrdered === 1 ? "" : "s"} of ${li.name} (${li.productId})`, 60, y);
			y += 15;
		}
		y += 10;
	}

	// --- Pallet table ---
	doc.fontSize(12).fillColor(DARK).font("Helvetica-Bold").text("Pallets", 50, y);
	y += 20;

	const columns = [
		{ label: "Pallet ID", x: 50, width: 90 },
		{ label: "Product", x: 140, width: 140 },
		{ label: "Description", x: 280, width: 150 },
		{ label: "Qty", x: 430, width: 50 },
		{ label: "Route", x: 480, width: 82 },
	];

	doc.fontSize(9).fillColor(GREY).font("Helvetica-Bold");
	for (const col of columns) {
		doc.text(col.label, col.x, y, { width: col.width });
	}
	y += 14;
	doc.moveTo(50, y).lineTo(562, y).strokeColor(LINE).lineWidth(1).stroke();
	y += 8;

	doc.font("Helvetica").fontSize(9).fillColor(DARK);
	for (const pallet of invoiceDetail.pallets || []) {
		if (y > 680) {
			doc.addPage();
			y = 50;
		}
		const rowValues = [
			pallet.palletId,
			pallet.productName || pallet.productId || "-",
			pallet.description || "-",
			String(pallet.quantity ?? "-"),
			pallet.routeNumber || "-",
		];
		let maxLines = 1;
		columns.forEach((col, i) => {
			const heightNeeded = doc.heightOfString(rowValues[i], { width: col.width });
			maxLines = Math.max(maxLines, Math.ceil(heightNeeded / 11));
		});
		columns.forEach((col, i) => {
			doc.text(rowValues[i], col.x, y, { width: col.width });
		});
		y += maxLines * 12 + 6;
	}

	y += 10;
	doc.moveTo(50, y).lineTo(562, y).strokeColor(LINE).lineWidth(1).stroke();

	// --- Footer ---
	doc
		.fontSize(8)
		.fillColor(GREY)
		.font("Helvetica")
		.text(`Generated ${formatDate(new Date().toISOString())} - reflects data as of shipment finalization.`, 50, 710, {
			width: 512,
			align: "center",
		});

	doc.end();
	return doc;
}

module.exports = { generateInvoicePDF };
