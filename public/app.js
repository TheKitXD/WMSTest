const VIEW_STATUS = { po: "ordered", inprogress: "staged", finalized: "shipped" };
const VIEW_TITLE = { po: "Purchase Orders", inprogress: "In-Progress Invoices", finalized: "Finalized Invoices" };

const state = {
	invoices: [],
	products: [],
	currentView: "po",
	openDetail: { po: null, inprogress: null, finalized: null },
	detailData: null,
	activeDetailTab: "overview",
	adjustingPalletId: null,
	shippingInvoiceId: null,
};

// ---------- Top nav ----------

function setView(view) {
	state.currentView = view;
	["po-view", "inprogress-view", "finalized-view", "products-view", "new-inventory-view"].forEach((id) => {
		document.getElementById(id).style.display = "none";
	});

	if (view === "po" || view === "inprogress" || view === "finalized") {
		document.getElementById(`${view}-view`).style.display = "flex";
	} else {
		document.getElementById(`${view}-view`).style.display = "block";
	}

	document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.view === view);
	});
	document.querySelectorAll(".dropdown-item").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.view === view);
	});
	document.querySelector('[data-dropdown="warehouse-inv-menu"]').classList.toggle("active", view === "products" || view === "new-inventory");
	document.querySelector('[data-dropdown="invoices-menu"]').classList.toggle("active", view === "inprogress" || view === "finalized");
	document.querySelectorAll(".dropdown-menu").forEach((menu) => menu.classList.remove("open"));

	if (view === "products") {
		fetchProducts().then(() => {
			document.getElementById("pallet-search").value = "";
			renderProductsSummary();
			document.getElementById("pallet-search-results").innerHTML = "";
		});
	} else if (view === "new-inventory") {
		fetchProducts().then(populatePalletFormProductSelect);
	} else {
		renderGrid(view);
	}
}

// Any button with data-dropdown toggles the matching #id menu, and closes
// the others - supports multiple independent dropdowns in the nav.
document.querySelectorAll(".dropdown-toggle").forEach((toggle) => {
	toggle.addEventListener("click", (e) => {
		e.stopPropagation();
		const targetMenu = document.getElementById(toggle.dataset.dropdown);
		const wasOpen = targetMenu.classList.contains("open");
		document.querySelectorAll(".dropdown-menu").forEach((menu) => menu.classList.remove("open"));
		if (!wasOpen) targetMenu.classList.add("open");
	});
});
document.addEventListener("click", () => {
	document.querySelectorAll(".dropdown-menu").forEach((menu) => menu.classList.remove("open"));
});
document.querySelectorAll(".nav-btn[data-view], .dropdown-item").forEach((btn) => {
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		setView(btn.dataset.view);
	});
});

// ---------- Invoice data + grids ----------

async function fetchInvoices() {
	const res = await fetch("/api/invoices");
	state.invoices = await res.json();
	if (["po", "inprogress", "finalized"].includes(state.currentView)) {
		renderGrid(state.currentView);
	}
}

function cardExtraLine(view, inv) {
	if (view === "finalized") {
		return `<div class="card-line"><span>Shipped</span><b>${new Date(inv.shippedAt).toLocaleDateString()}</b></div>
			<div class="card-line"><span>Carrier</span><b>${inv.carrier || "-"}</b></div>`;
	}
	if (view === "inprogress") {
		return `<div class="card-line"><span>Pallets</span><b>${inv.palletCount}</b></div>`;
	}
	return `<div class="card-line"><span>Created</span><b>${new Date(inv.createdAt).toLocaleDateString()}</b></div>
		<div class="card-line"><span>Pallets</span><b>${inv.palletCount}</b></div>`;
}

function renderGrid(view) {
	const grid = document.getElementById(`${view}-grid`);
	const status = VIEW_STATUS[view];
	const matching = state.invoices.filter((inv) => inv.status === status);

	if (matching.length === 0) {
		const emptyMsg =
			view === "po"
				? "No purchase orders yet. Click \"+ New Order\" to create one."
				: view === "inprogress"
				? "Nothing in progress. Orders move here once a pallet is picked or scanned."
				: "Nothing finalized yet. Invoices move here once marked shipped.";
		grid.innerHTML = `<div class="empty-grid-note">${emptyMsg}</div>`;
		return;
	}

	grid.innerHTML = matching
		.map(
			(inv) => `
			<div class="invoice-card status-${inv.status}" data-id="${inv.invoiceId}">
				<div class="card-id">${inv.invoiceId}</div>
				<div class="card-customer">${inv.customerName || "No customer name"}</div>
				${cardExtraLine(view, inv)}
			</div>`
		)
		.join("");

	grid.querySelectorAll(".invoice-card").forEach((card) => {
		card.addEventListener("click", () => openInvoiceDetail(view, card.dataset.id));
	});
}

async function openInvoiceDetail(view, invoiceId) {
	state.openDetail[view] = invoiceId;
	state.activeDetailTab = "overview";
	document.getElementById(`${view}-list-state`).style.display = "none";
	const detailEl = document.getElementById(`${view}-detail-state`);
	detailEl.style.display = "block";
	detailEl.innerHTML = `<div class="empty-grid-note">Loading...</div>`;

	const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
	state.detailData = res.ok ? await res.json() : null;
	renderInvoiceDetail(view);
}

function closeInvoiceDetail(view) {
	state.openDetail[view] = null;
	document.getElementById(`${view}-detail-state`).style.display = "none";
	document.getElementById(`${view}-list-state`).style.display = "block";
	renderGrid(view);
}

function renderInvoiceDetail(view) {
	const el = document.getElementById(`${view}-detail-state`);
	const d = state.detailData;
	if (!d) {
		el.innerHTML = `<div class="empty-grid-note">Invoice not found.</div>`;
		return;
	}

	const totalBoxes = d.pallets.reduce((sum, p) => sum + p.boxes.length, 0);
	const pickedCount = d.pallets.filter((p) => p.picked).length;

	let actionBtn = "";
	if (view === "po") {
		actionBtn = `<button class="action primary" id="send-to-inprogress">Send to In-Progress</button>`;
	} else if (view === "inprogress") {
		actionBtn = `<button class="action primary" id="ship-invoice">Mark Shipped</button>`;
	} else if (view === "finalized") {
		actionBtn = `<button class="action primary" id="download-pdf">Download PDF</button>`;
	}

	const shipInfo =
		view === "finalized"
			? `<div class="ship-info-row">
				<span><span class="info-label">Shipped</span>${new Date(d.shippedAt).toLocaleString()}</span>
				<span><span class="info-label">Carrier</span>${d.carrier || "-"}</span>
				<span><span class="info-label">Tracking</span>${d.trackingNumber || "-"}</span>
			</div>`
			: "";

	el.innerHTML = `
		<button class="back-btn" id="back-to-list">&larr; Back to ${VIEW_TITLE[view]}</button>
		<div class="detail-header">
			<span class="id">INV ${d.invoiceId}</span>
			<span class="status-badge ${d.status}">${d.status === "shipped" ? "Shipped" : d.status === "ordered" ? "Ordered" : "Staged"}</span>
			${actionBtn}
		</div>
		<div class="detail-meta">${d.customerName ? `${d.customerName} &middot; ` : ""}created ${new Date(d.createdAt).toLocaleString()}</div>
		${shipInfo}
		<div class="tabs">
			<div class="tab ${state.activeDetailTab === "overview" ? "active" : ""}" data-tab="overview">Overview</div>
			<div class="tab ${state.activeDetailTab === "edi" ? "active" : ""}" data-tab="edi">EDI 856</div>
		</div>
		<div id="detail-tab-content"></div>
	`;

	document.getElementById("back-to-list").addEventListener("click", () => closeInvoiceDetail(view));

	const sendBtn = document.getElementById("send-to-inprogress");
	if (sendBtn) {
		sendBtn.addEventListener("click", async () => {
			await fetch(`/api/invoices/${encodeURIComponent(d.invoiceId)}/send-to-in-progress`, { method: "POST" });
			closeInvoiceDetail(view);
			await fetchInvoices();
		});
	}

	const shipBtn = document.getElementById("ship-invoice");
	if (shipBtn) shipBtn.addEventListener("click", () => openShipModal(d.invoiceId, view));

	const pdfBtn = document.getElementById("download-pdf");
	if (pdfBtn) pdfBtn.addEventListener("click", () => window.open(`/api/invoices/${encodeURIComponent(d.invoiceId)}/pdf`, "_blank"));

	el.querySelectorAll(".tab").forEach((tab) => {
		tab.addEventListener("click", () => {
			state.activeDetailTab = tab.dataset.tab;
			renderInvoiceDetail(view);
		});
	});

	if (state.activeDetailTab === "overview") {
		renderDetailOverview(view);
	} else {
		renderDetailEdi(view);
	}
}

function renderDetailOverview(view) {
	const container = document.getElementById("detail-tab-content");
	const d = state.detailData;

	const orderedSection =
		d.lineItems && d.lineItems.length > 0
			? `
		<div class="pallet-card">
			<div class="pallet-card-head"><span class="pallet-id">Ordered</span></div>
			<div class="box-list">
				${d.lineItems
					.map((li) => `<div class="box-row"><span class="dot"></span>${li.quantityOrdered} ${li.unitOfMeasure || "pallet"}${li.quantityOrdered === 1 ? "" : "s"} of ${li.name} <span class="customer-note">(${li.productId})</span></div>`)
					.join("")}
			</div>
		</div>`
			: "";

	// Real pallets only show up here once actually scanned in Roblox with a
	// matching InvoiceId - picking/assignment isn't built yet, so this is
	// read-only and just reflects whatever's actually happened in-game.
	const palletSection =
		d.pallets.length > 0
			? `
		<div class="pallet-card">
			<div class="pallet-card-head"><span class="pallet-id">Pallets scanned in-game</span></div>
			<div class="box-list">
				${d.pallets
					.map(
						(p) =>
							`<div class="box-row"><span class="dot"></span>PAL ${p.palletId}${p.productName ? ` &middot; ${p.productName}` : ""}${p.routeNumber ? ` &middot; Route ${p.routeNumber}` : ""}</div>`
					)
					.join("")}
			</div>
		</div>`
			: "";

	container.innerHTML = orderedSection + palletSection;
}

async function renderDetailEdi(view) {
	const container = document.getElementById("detail-tab-content");
	container.innerHTML = `<div class="edi-block">Generating...</div>`;
	const res = await fetch(`/api/invoices/${encodeURIComponent(state.detailData.invoiceId)}/edi856`);
	const text = await res.text();
	container.innerHTML = `
		<div class="edi-toolbar">
			<button class="action" id="copy-edi">Copy</button>
			<button class="action" id="download-edi">Download .edi</button>
		</div>
		<div class="edi-block">${text.replace(/</g, "&lt;")}</div>
	`;
	document.getElementById("copy-edi").addEventListener("click", () => navigator.clipboard.writeText(text));
	document.getElementById("download-edi").addEventListener("click", () => {
		const blob = new Blob([text], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `ASN_${state.detailData.invoiceId}.edi`;
		a.click();
		URL.revokeObjectURL(url);
	});
}

// ---------- Ship modal ----------

function openShipModal(invoiceId, view) {
	state.shippingInvoiceId = invoiceId;
	state.shippingFromView = view;
	document.getElementById("ship-carrier").value = "";
	document.getElementById("ship-tracking").value = "";
	document.getElementById("ship-modal-overlay").style.display = "flex";
}

document.getElementById("cancel-ship").addEventListener("click", () => {
	document.getElementById("ship-modal-overlay").style.display = "none";
});

document.getElementById("submit-ship").addEventListener("click", async () => {
	const carrier = document.getElementById("ship-carrier").value.trim();
	const trackingNumber = document.getElementById("ship-tracking").value.trim();
	await fetch(`/api/invoices/${encodeURIComponent(state.shippingInvoiceId)}/ship`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ carrier, trackingNumber }),
	});
	document.getElementById("ship-modal-overlay").style.display = "none";
	const view = state.shippingFromView;
	closeInvoiceDetail(view);
	await fetchInvoices();
});

// ---------- Products tab: catalog summary + pallet search/adjust ----------

async function fetchProducts() {
	const res = await fetch("/api/products");
	state.products = await res.json();
	return state.products;
}

function renderProductsSummary() {
	const container = document.getElementById("products-summary");
	if (state.products.length === 0) {
		container.innerHTML = `<div class="empty-note">No products yet. Click "+ New Product" above.</div>`;
		return;
	}
	container.innerHTML = state.products
		.map(
			(p) => `
			<div class="product-summary-row">
				<span><span class="pname">${p.name}</span><span class="pid">${p.productId}</span></span>
				<span class="pcounts"><span class="avail">${p.availablePallets}</span> / ${p.totalPallets} pallets available</span>
			</div>`
		)
		.join("");
}

let searchDebounce;
document.getElementById("pallet-search").addEventListener("input", (e) => {
	clearTimeout(searchDebounce);
	const q = e.target.value.trim();
	searchDebounce = setTimeout(() => runPalletSearch(q), 200);
});

async function runPalletSearch(query) {
	const summaryEl = document.getElementById("products-summary");
	const resultsEl = document.getElementById("pallet-search-results");

	if (!query) {
		summaryEl.style.display = "block";
		resultsEl.innerHTML = "";
		return;
	}
	summaryEl.style.display = "none";

	const res = await fetch(`/api/pallets/search?q=${encodeURIComponent(query)}`);
	const pallets = await res.json();

	if (pallets.length === 0) {
		resultsEl.innerHTML = `<div class="empty-note">No pallets match "${query}".</div>`;
		return;
	}

	resultsEl.innerHTML = pallets
		.map((p) => {
			const allocationNote = p.invoiceId
				? `<span class="allocation-note">Allocated to INV ${p.invoiceId}</span>`
				: `<span class="allocation-note" style="color: var(--green);">Available</span>`;
			return `
			<div class="pallet-result-row">
				<div class="left">
					<span class="pallet-id-main">PAL ${p.palletId} &middot; ${p.productName || "(no product)"}</span>
					<span class="meta-line">${p.description || "No description"} &middot; Qty ${p.quantity ?? "-"} &middot; ${allocationNote}</span>
				</div>
				<div class="right">
					<button class="action" data-adjust="${p.palletId}" data-qty="${p.quantity ?? 0}">Adjust</button>
				</div>
			</div>`;
		})
		.join("");

	resultsEl.querySelectorAll("[data-adjust]").forEach((btn) => {
		btn.addEventListener("click", () => openAdjustModal(btn.dataset.adjust, Number(btn.dataset.qty)));
	});
}

function openAdjustModal(palletId, currentQty) {
	state.adjustingPalletId = palletId;
	document.getElementById("adjust-pallet-label").textContent = `Pallet ${palletId}`;
	document.getElementById("adjust-quantity").value = currentQty;
	document.getElementById("adjust-reason").value = "";
	document.getElementById("adjust-error").textContent = "";
	document.getElementById("adjust-modal-overlay").style.display = "flex";
}

document.getElementById("cancel-adjust").addEventListener("click", () => {
	document.getElementById("adjust-modal-overlay").style.display = "none";
});

document.getElementById("submit-adjust").addEventListener("click", async () => {
	const quantity = Number(document.getElementById("adjust-quantity").value);
	const reason = document.getElementById("adjust-reason").value.trim();
	const errorEl = document.getElementById("adjust-error");
	const res = await fetch(`/api/pallets/${encodeURIComponent(state.adjustingPalletId)}/adjust`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ quantity, reason }),
	});
	if (res.ok) {
		document.getElementById("adjust-modal-overlay").style.display = "none";
		runPalletSearch(document.getElementById("pallet-search").value.trim());
		fetchProducts().then(renderProductsSummary);
	} else {
		const err = await res.json();
		errorEl.textContent = err.error;
	}
});

// ---------- New Inventory tab ----------

function populatePalletFormProductSelect() {
	const select = document.getElementById("pallet-form-product");
	select.innerHTML = state.products.length
		? state.products.map((p) => `<option value="${p.productId}">${p.name} (${p.productId})</option>`).join("")
		: `<option value="">No products yet - add one first</option>`;
}

document.getElementById("pallet-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const form = e.target;
	const msgEl = document.getElementById("pallet-form-msg");
	const body = {
		palletId: form.palletId.value.trim(),
		productId: form.productId.value,
		description: form.description.value.trim(),
		quantity: Number(form.quantity.value),
	};
	const res = await fetch("/api/pallets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.ok) {
		msgEl.style.color = "var(--green)";
		msgEl.textContent = `Pallet ${body.palletId} added to inventory.`;
		form.reset();
		fetchProducts();
	} else {
		const err = await res.json();
		msgEl.style.color = "var(--red)";
		msgEl.textContent = err.error;
	}
});

// ---------- New product modal ----------

function openProductModal() {
	document.getElementById("product-id-input").value = "";
	document.getElementById("product-name-input").value = "";
	document.getElementById("product-desc-input").value = "";
	document.getElementById("product-unit-input").value = "pallet";
	document.getElementById("product-error").textContent = "";
	document.getElementById("product-modal-overlay").style.display = "flex";
}

document.getElementById("new-product-btn").addEventListener("click", openProductModal);
document.getElementById("cancel-product").addEventListener("click", () => {
	document.getElementById("product-modal-overlay").style.display = "none";
});

document.getElementById("submit-product").addEventListener("click", async () => {
	const body = {
		productId: document.getElementById("product-id-input").value.trim(),
		name: document.getElementById("product-name-input").value.trim(),
		description: document.getElementById("product-desc-input").value.trim(),
		unitOfMeasure: document.getElementById("product-unit-input").value.trim() || "pallet",
	};
	const errorEl = document.getElementById("product-error");
	if (!body.productId || !body.name) {
		errorEl.textContent = "SKU and name are required.";
		return;
	}
	const res = await fetch("/api/products", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.ok) {
		document.getElementById("product-modal-overlay").style.display = "none";
		await fetchProducts();
		renderProductsSummary();
	} else {
		const err = await res.json();
		errorEl.textContent = err.error;
	}
});

// ---------- New order modal (pallet-based line items) ----------

let lineItemCounter = 0;

function openOrderModal() {
	document.getElementById("order-customer-name").value = "";
	document.getElementById("order-line-items").innerHTML = "";
	document.getElementById("order-error").textContent = "";
	lineItemCounter = 0;
	addLineItemRow();
	document.getElementById("order-modal-overlay").style.display = "flex";
}

function closeOrderModal() {
	document.getElementById("order-modal-overlay").style.display = "none";
}

function addLineItemRow() {
	lineItemCounter += 1;
	const rowId = `line-${lineItemCounter}`;
	const options = state.products.length
		? state.products.map((p) => `<option value="${p.productId}">${p.name}</option>`).join("")
		: `<option value="">No products in catalog</option>`;

	const row = document.createElement("div");
	row.className = "line-item-row";
	row.id = rowId;
	row.innerHTML = `
		<select class="line-product">${options}</select>
		<input type="number" class="line-qty" min="1" value="1" />
		<button type="button" class="remove-line">&times;</button>
	`;
	document.getElementById("order-line-items").appendChild(row);
	row.querySelector(".remove-line").addEventListener("click", () => row.remove());
}

document.getElementById("new-order-btn").addEventListener("click", async () => {
	await fetchProducts();
	openOrderModal();
});
document.getElementById("cancel-order").addEventListener("click", closeOrderModal);
document.getElementById("add-line-item").addEventListener("click", addLineItemRow);

document.getElementById("submit-order").addEventListener("click", async () => {
	const customerName = document.getElementById("order-customer-name").value.trim();
	const errorEl = document.getElementById("order-error");
	errorEl.textContent = "";

	if (!customerName) {
		errorEl.textContent = "Customer name is required.";
		return;
	}

	const rows = document.querySelectorAll("#order-line-items .line-item-row");
	const lineItems = Array.from(rows)
		.map((row) => ({
			productId: row.querySelector(".line-product").value,
			quantityOrdered: Number(row.querySelector(".line-qty").value),
		}))
		.filter((li) => li.productId && li.quantityOrdered > 0);

	if (lineItems.length === 0) {
		errorEl.textContent = "Add at least one line item with a quantity.";
		return;
	}

	const res = await fetch("/api/purchase-orders", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ customerName, lineItems }),
	});

	if (res.ok) {
		closeOrderModal();
		await fetchInvoices();
		if (state.currentView !== "po") setView("po");
		else renderGrid("po");
	} else {
		const err = await res.json();
		errorEl.textContent = err.error;
	}
});

// Poll for new scans every few seconds so the floor updates live.
fetchInvoices();
setInterval(fetchInvoices, 4000);
