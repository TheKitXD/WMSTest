// EDI 856 (Advance Ship Notice) generator.
//
// Structure follows the standard X12 856 hierarchy:
//   HL Shipment (S)
//     HL Order (O)      <- one per invoice, PRF carries the invoice/PO number
//       HL Pack (P)      <- one per pallet, MAN carries the pallet ID (license plate)
//         HL Item (I)    <- one per pallet's product/quantity, not one per box.
//                           Fulfillment is tracked by whole pallet, never by
//                           case - see store.js's note on this.
//
// This is a real, valid 856 shape (verified against multiple published
// examples), but the trading-partner-specific bits - sender/receiver IDs,
// ship-from/ship-to names, how route/staging/location numbers map onto REF
// qualifiers - are placeholders using generic codes (REF*ZZ = "Mutually
// Defined", the standard EDI catch-all for data a spec doesn't have a
// dedicated qualifier for). Swap these for your real trading partner's
// implementation guide once you have one; every EDI partner has slightly
// different requirements even though the base 856 structure is fixed.

function pad(str, len) {
	return String(str).slice(0, len).padEnd(len, " ");
}

function segment(...elements) {
	return elements.map((e) => (e === undefined || e === null ? "" : String(e))).join("*");
}

function twoDigitYear(date) {
	return String(date.getFullYear()).slice(2);
}

function mm(date) {
	return String(date.getMonth() + 1).padStart(2, "0");
}

function dd(date) {
	return String(date.getDate()).padStart(2, "0");
}

function hhmm(date) {
	return String(date.getHours()).padStart(2, "0") + String(date.getMinutes()).padStart(2, "0");
}

function generateEDI856(invoiceDetail, options = {}) {
	const {
		senderId = "YOURWAREHOUSE",
		receiverId = "TRADINGPARTNER",
		shipFromName = "YOUR WAREHOUSE",
		shipToName = invoiceDetail.customerName || "CUSTOMER DC",
		controlNumber = Math.floor(Math.random() * 900000000) + 100000000, // 9 digits, matches ISA13 width
	} = options;

	const now = new Date();
	const dateYYMMDD = twoDigitYear(now) + mm(now) + dd(now);
	const dateCCYYMMDD = now.getFullYear() + mm(now) + dd(now);
	const time = hhmm(now);
	const isaControl = String(controlNumber).padStart(9, "0");
	const stControl = String(controlNumber).slice(-4).padStart(4, "0");

	const segments = [];
	let hlCounter = 0;
	const nextHL = () => {
		hlCounter += 1;
		return hlCounter;
	};

	// --- Interchange / functional group / transaction set headers ---
	segments.push(
		segment(
			"ISA", "00", pad("", 10), "00", pad("", 10),
			"ZZ", pad(senderId, 15), "ZZ", pad(receiverId, 15),
			dateYYMMDD, time, "U", "00401", isaControl, "0", "P", ">"
		)
	);
	segments.push(segment("GS", "SH", senderId, receiverId, dateCCYYMMDD, time, controlNumber, "X", "004010"));
	segments.push(segment("ST", "856", stControl));
	segments.push(segment("BSN", "00", invoiceDetail.invoiceId, dateCCYYMMDD, time));

	// --- Shipment level (HL*_**S) ---
	const shipmentHL = nextHL();
	segments.push(segment("HL", shipmentHL, "", "S"));
	const totalUnits = invoiceDetail.pallets.reduce((sum, p) => sum + (p.quantity || 0), 0);
	segments.push(segment("TD1", "CTN25", totalUnits));
	if (invoiceDetail.carrier) {
		segments.push(segment("TD5", "", "2", invoiceDetail.carrier));
	}
	segments.push(segment("REF", "BM", `BOL-${invoiceDetail.invoiceId}`));
	if (invoiceDetail.trackingNumber) {
		segments.push(segment("REF", "CN", invoiceDetail.trackingNumber));
	}
	segments.push(segment("DTM", "011", dateCCYYMMDD));
	segments.push(segment("N1", "SF", shipFromName));
	segments.push(segment("N1", "ST", shipToName));

	// --- Order level (HL*_*shipmentHL*O) - one per invoice ---
	const orderHL = nextHL();
	segments.push(segment("HL", orderHL, shipmentHL, "O"));
	segments.push(segment("PRF", invoiceDetail.invoiceId));

	let lineItemCount = 0;

	for (const pallet of invoiceDetail.pallets) {
		// --- Pack level (HL*_*orderHL*P) - one per pallet ---
		const packHL = nextHL();
		segments.push(segment("HL", packHL, orderHL, "P"));
		segments.push(segment("MAN", "GM", pallet.palletId));
		segments.push(segment("TD1", "CTN25", pallet.quantity ?? 0));
		if (pallet.routeNumber != null) segments.push(segment("REF", "ZZ", `ROUTE:${pallet.routeNumber}`));
		if (pallet.locationNumber != null) segments.push(segment("REF", "ZZ", `LOC:${pallet.locationNumber}`));
		if (pallet.stagingNumber != null && pallet.stagingMaxNumber != null) {
			segments.push(segment("REF", "ZZ", `STAGING:${pallet.stagingNumber}/${pallet.stagingMaxNumber}`));
		}

		// Item level: one per PALLET, describing what's on it as a whole -
		// never one per scanned box. Fulfillment is tracked by pallet, not
		// case, so the quantity here is the pallet's registered unit count.
		if (pallet.productId) {
			const itemHL = nextHL();
			segments.push(segment("HL", itemHL, packHL, "I"));
			segments.push(segment("LIN", "", "SK", pallet.productId));
			segments.push(segment("SN1", "", pallet.quantity ?? 0, "EA"));
			lineItemCount += 1;
		}
	}

	segments.push(segment("CTT", lineItemCount));

	// SE01 = count of every segment from ST through SE, inclusive.
	// segments.length right now = everything from ISA through CTT.
	// Subtract ISA+GS (not part of the transaction set), add 1 for SE itself.
	const seCount = segments.length - 2 + 1;
	segments.push(segment("SE", seCount, stControl));
	segments.push(segment("GE", "1", controlNumber));
	segments.push(segment("IEA", "1", isaControl));

	return segments.map((s) => s + "~").join("\n");
}

module.exports = { generateEDI856 };
