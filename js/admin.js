/* =========================================================
   TrustX Ledger — Developer console (admin.html)
   -----------------------------------------------------------------
   Everyone who signs in with the shop code has full access, so this
   console covers the shop's maintenance: the service catalog and a
   full-data browser. The dashboard stays operational-only.
   ========================================================= */

import { toast, confirm, setLoading } from "./app.js";
import {
  formatINR,
  formatKolkataTime,
  formatKolkataLong,
  escapeHtml,
  todayKolkata,
  paiseToInput,
  rateToPaise,
} from "./utils.js";
import {
  fetchServices,
  createService,
  updateService,
  fetchTransactions,
  fetchExpenses,
} from "./ledger.js";
import {
  reportError,
  listTrustedDevices,
  revokeDevice,
  restoreDevice,
  removeDevice,
} from "./auth.js";

function svg(id) {
  const paths = {
    services: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    data: '<path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-7"/>',
    devices:
      '<rect x="2" y="4" width="20" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  };
  return (
    '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (paths[id] || "") +
    "</svg>"
  );
}

/* =========================================================
   Page
   ========================================================= */
export async function renderAdminPage(ctx) {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;

  thisDeviceHash = ctx.trust ? ctx.trust.tokenHash : null;

  mainContent.innerHTML =
    '<div class="dash-head">' +
    "<div>" +
    "<h1>Developer console</h1>" +
    '<p class="small muted">Services maintenance and full data access.</p>' +
    "</div>" +
    '<span class="pill pill-accent" id="devShopPill">' + escapeHtml(ctx.general ? ctx.general.name || "TrustX Ledger" : "TrustX Ledger") + "</span>" +
    "</div>" +

    '<section class="card" id="servicesCard">' +
    '<div class="card-header"><h3>' + svg("services") + "Services</h3></div>" +
    '<div class="card-body">' +
    '<div class="rule-row">' +
    '<div class="field" style="margin:0;flex:1;"><input class="input" id="addSvcName" type="text" maxlength="80" placeholder="New service name" /></div>' +
    '<div class="field" style="margin:0;width:130px;"><input class="input" id="addSvcPrice" type="text" inputmode="decimal" placeholder="Rate (&curren;)" /></div>' +
    '<div class="flex" style="gap:0.5rem;">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="addSvcClear">Clear</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="addSvcSave">Add service</button>' +
    "</div></div>" +
    '<div id="servicesList"><div class="state"><span class="spinner" aria-hidden="true"></span><p class="muted">Loading services&hellip;</p></div></div>' +
    "</div></section>" +

    '<section class="card mt-2" id="devicesCard">' +
    '<div class="card-header"><h3>' + svg("devices") + "Trusted devices</h3>" +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-sm btn-secondary" id="devicesRefreshBtn">Refresh</button>' +
    "</div></div>" +
    '<div class="card-body">' +
    '<p class="small muted" style="margin:0 0 .75rem;">These browsers open the ledger without the shop code. Revoke any device you do not recognise; the next time it opens the app it will ask for the code again.</p>' +
    '<div id="devicesList"><div class="state"><span class="spinner" aria-hidden="true"></span><p class="muted">Loading devices&hellip;</p></div></div>' +
    "</div></section>" +

    '<section class="card mt-2" id="dataCard">' +
    '<div class="card-header"><h3>' + svg("data") + "All data</h3>" +
    '<div class="card-actions">' +
    '<label class="small muted" for="dataDate">Day</label>' +
    '<input class="input input-sm" id="dataDate" type="date" value="' + escapeHtml(todayKolkata()) + '" />' +
    '<button type="button" class="btn btn-sm btn-primary" id="dataDayBtn">Day</button>' +
    '<button type="button" class="btn btn-sm btn-secondary" id="dataAllBtn">All recent</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="dataRefreshBtn">Refresh</button>' +
    "</div></div>" +
    '<div class="card-body">' +
    '<h4 style="margin:0 0 .5rem;">Transactions</h4>' +
    '<div class="table-wrap"><table class="table txn-table">' +
    "<thead><tr>" +
    "<th>Date</th><th>Time</th><th>Customer</th><th>Service</th><th>Payment</th>" +
    '<th class="text-right">Qty</th><th class="text-right">Rate</th>' +
    '<th class="text-right">Amount</th>' +
    "</tr></thead>" +
    '<tbody id="dataTxnBody"><tr><td colspan="8"><div class="state"><span class="spinner" aria-hidden="true"></span><p class="muted">Loading&hellip;</p></div></td></tr></tbody>' +
    "</table></div>" +
    '<div class="txn-footer small" id="dataTxnFooter">&nbsp;</div>' +
    '<h4 style="margin:1rem 0 .5rem;">Expenses</h4>' +
    '<div class="table-wrap"><table class="table txn-table">' +
    "<thead><tr>" +
    "<th>Date</th><th>Title</th><th>Category</th>" +
    '<th class="text-right">Amount</th>' +
    "</tr></thead>" +
    '<tbody id="dataExpBody"><tr><td colspan="4"><div class="state"><span class="spinner" aria-hidden="true"></span><p class="muted">Loading&hellip;</p></div></td></tr></tbody>' +
    "</table></div>" +
    '<div class="txn-footer small" id="dataExpFooter">&nbsp;</div>' +
    "</div></section>";

  wireAddService();
  loadServicesList();
  wireDataBrowser();
  loadDataBrowser();
  wireDevices();
}

/* =========================================================
   Services maintenance
   ========================================================= */
function wireAddService() {
  document.getElementById("addSvcSave").addEventListener("click", saveNewService);
  document.getElementById("addSvcClear").addEventListener("click", () => {
    document.getElementById("addSvcName").value = "";
    document.getElementById("addSvcPrice").value = "";
  });
}

async function saveNewService() {
  const name = document.getElementById("addSvcName").value.trim();
  const price = document.getElementById("addSvcPrice").value;
  const btn = document.getElementById("addSvcSave");
  if (!name) {
    toast("Enter a service name.", "error");
    return;
  }
  if (rateToPaise(price) === null) {
    toast("Enter a valid rate.", "error");
    return;
  }
  setLoading(btn, true);
  try {
    const created = await createService({ name, price });
    document.getElementById("addSvcName").value = "";
    document.getElementById("addSvcPrice").value = "";
    toast('Service "' + created.name + '" added.', "success");
    loadServicesList();
  } catch (err) {
    toast(reportError(err), "error");
  } finally {
    setLoading(btn, false);
  }
}

function serviceRow(s) {
  const id = escapeHtml(s.serviceId);
  return (
    '<div class="svc-row">' +
    '<div class="svc-fields">' +
    '<input class="input input-sm" data-svc-name="' + id + '" type="text" maxlength="80" value="' + escapeHtml(s.name) + '" />' +
    '<input class="input input-sm" data-svc-price="' + id + '" type="text" inputmode="decimal" value="' + escapeHtml(paiseToInput(s.pricePaise)) + '" style="width:110px;" />' +
    "</div>" +
    '<div class="svc-actions">' +
    '<span class="badge ' + (s.active ? "badge-success" : "badge-neutral") + '">' + (s.active ? "Active" : "Archived") + "</span>" +
    '<button type="button" class="btn btn-primary btn-sm" data-svc-save="' + id + '">Save</button>' +
    '<button type="button" class="btn btn-sm ' + (s.active ? "btn-secondary" : "btn-primary") + '" data-svc-toggle="' + id + '">' + (s.active ? "Archive" : "Restore") + "</button>" +
    "</div>" +
    "</div>"
  );
}

async function loadServicesList() {
  const list = document.getElementById("servicesList");
  if (!list) return;
  try {
    const services = await fetchServices({ includeInactive: true });
    list.innerHTML =
      services.map(serviceRow).join("") ||
      '<div class="state" style="padding:1rem 0;"><p class="muted" style="margin:0;">No services yet.</p></div>';

    services.forEach((s) => {
      const nameInput = list.querySelector('[data-svc-name="' + CSS.escape(s.serviceId) + '"]');
      const priceInput = list.querySelector('[data-svc-price="' + CSS.escape(s.serviceId) + '"]');
      list.querySelector('[data-svc-save="' + CSS.escape(s.serviceId) + '"]').addEventListener("click", async () => {
        const btn = document.querySelector('[data-svc-save="' + CSS.escape(s.serviceId) + '"]');
        setLoading(btn, true);
        try {
          await updateService(s.serviceId, { name: nameInput.value, price: priceInput.value });
          toast("Service updated.", "success");
          loadServicesList();
        } catch (err) {
          toast(reportError(err), "error");
        } finally {
          setLoading(btn, false);
        }
      });
      list.querySelector('[data-svc-toggle="' + CSS.escape(s.serviceId) + '"]').addEventListener("click", async () => {
        const nextActive = !s.active;
        const ok = await confirm({
          title: nextActive ? "Restore service" : "Archive service",
          message: nextActive
            ? '"' + s.name + '" will appear in the service list again.'
            : '"' + s.name + '" will be hidden from quick entry. Existing transactions are kept.',
          confirmText: nextActive ? "Restore" : "Archive",
          variant: nextActive ? "primary" : "danger",
        });
        if (!ok) return;
        try {
          await updateService(s.serviceId, { active: nextActive });
          toast(nextActive ? "Service restored." : "Service archived.", "success");
          loadServicesList();
        } catch (err) {
          toast(reportError(err), "error");
        }
      });
    });
  } catch (err) {
    list.innerHTML = ' <div class="state"><p class="muted">' + escapeHtml(reportError(err)) + "</p></div>";
  }
}

/* =========================================================
   Trusted devices
   ========================================================= */
let thisDeviceHash = null;

function wireDevices() {
  const list = document.getElementById("devicesList");
  document.getElementById("devicesRefreshBtn").addEventListener("click", loadTrustedDevices);

  list.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-dev-action]");
    if (!btn) return;
    const { devAction, devHash } = btn.dataset;
    if (!devHash) return;

    const isThis = devHash === thisDeviceHash;
    if (devAction === "revoke") {
      const ok = await confirm({
        title: "Revoke this device?",
        message:
          (isThis ? "This browser will need the shop code on its next visit. " : "") +
          "The device cannot open the ledger without the code until it is restored.",
        confirmText: "Revoke",
        variant: "danger",
      });
      if (!ok) return;
      try {
        await revokeDevice(devHash);
        toast(isThis ? "This browser revoked. It will need the code next time." : "Device revoked.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    } else if (devAction === "restore") {
      const ok = await confirm({
        title: "Restore this device?",
        message: "It will open the ledger without the code again.",
        confirmText: "Restore",
        variant: "primary",
      });
      if (!ok) return;
      try {
        await restoreDevice(devHash);
        toast("Device restored.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    } else if (devAction === "remove") {
      const ok = await confirm({
        title: "Remove this device?",
        message:
          (isThis ? "This browser will need the shop code on its next visit. " : "") +
          "Its trust record is deleted and cannot be restored — it must be enrolled again.",
        confirmText: "Remove",
        variant: "danger",
      });
      if (!ok) return;
      try {
        await removeDevice(devHash);
        toast("Device removed.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    }
    loadTrustedDevices();
  });
}

function fmtTs(ts) {
  if (!ts) return "—";
  const dt = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  if (Number.isNaN(dt.getTime())) return "—";
  return escapeHtml(formatKolkataLong(dt) + ", " + formatKolkataTime(dt));
}

function networkSummary(d) {
  const n = d.network || {};
  const bits = [];
  if (n.type) bits.push(escapeHtml(n.type));
  if (n.saveData) bits.push("data saver");
  if (typeof n.online === "boolean") bits.push("online");
  return bits.join(" &middot; ");
}

function deviceRow(d) {
  const isThis = d.tokenHash === thisDeviceHash;
  const label = String(d.label || "Untitled device").trim() || "Untitled device";
  const ua = (d.client && d.client.ua) || "";
  const subBits = [ua, networkSummary(d)].filter(Boolean);
  return (
    '<div class="dev-row">' +
    '<div class="dev-main">' +
    '<div class="dev-title">' + escapeHtml(label) +
    (isThis ? ' <span class="badge badge-accent">This browser</span>' : "") +
    "</div>" +
    '<div class="dev-sub">' + escapeHtml(subBits.join(" &middot; ")) + "</div>" +
    '<div class="dev-sub small muted">Trusted ' + fmtTs(d.createdAt || d.lastUsedAt) +
    ' &middot; Last used ' + fmtTs(d.lastUsedAt) + "</div>" +
    "</div>" +
    '<div class="dev-side">' +
    '<span class="badge ' + (d.active ? "badge-success" : "badge-neutral") + '">' +
    (d.active ? "Active" : "Revoked") + "</span>" +
    (d.active
      ? '<button type="button" class="btn btn-secondary btn-sm" data-dev-action="revoke" data-dev-hash="' + escapeHtml(d.tokenHash) + '">Revoke</button>'
      : '<button type="button" class="btn btn-primary btn-sm" data-dev-action="restore" data-dev-hash="' + escapeHtml(d.tokenHash) + '">Restore</button>') +
    '<button type="button" class="btn btn-secondary btn-sm" data-dev-action="remove" data-dev-hash="' + escapeHtml(d.tokenHash) + '">Remove</button>' +
    "</div>" +
    "</div>"
  );
}

async function loadTrustedDevices() {
  const list = document.getElementById("devicesList");
  if (!list) return;
  try {
    const devices = await listTrustedDevices();
    list.innerHTML = devices.length
      ? devices.map(deviceRow).join("")
      : '<div class="state" style="padding:1rem 0;"><p class="muted" style="margin:0;">No trusted devices yet. The first browser to enter the shop code appears here.</p></div>';
  } catch (err) {
    console.error("[trustx-ledger] devices:", err);
    list.innerHTML = '<div class="state is-error"><p class="muted">' + escapeHtml(reportError(err)) + "</p></div>";
  }
}

/* =========================================================
   All-data browser
   ========================================================= */
let dataModeState = "day";

function wireDataBrowser() {
  const dateInput = document.getElementById("dataDate");
  document.getElementById("dataRefreshBtn").addEventListener("click", loadDataBrowser);
  document.getElementById("dataDayBtn").addEventListener("click", () => {
    dataModeState = "day";
    document.getElementById("dataDayBtn").className = "btn btn-sm btn-primary";
    document.getElementById("dataAllBtn").className = "btn btn-sm btn-secondary";
    loadDataBrowser();
  });
  document.getElementById("dataAllBtn").addEventListener("click", () => {
    dataModeState = "all";
    document.getElementById("dataAllBtn").className = "btn btn-sm btn-primary";
    document.getElementById("dataDayBtn").className = "btn btn-sm btn-secondary";
    loadDataBrowser();
  });
  dateInput.addEventListener("change", () => {
    if (dataModeState === "day") loadDataBrowser();
  });
}

function methodChip(t) {
  return '<span class="badge badge-method badge-' + escapeHtml(t.paymentMethod) + '">' +
    escapeHtml(t.methodLabel) +
    (t.status === "pending" ? ' <span class="badge badge-warning" style="margin-left:2px;">Pending</span>' : "") +
    "</span>";
}

async function loadDataBrowser() {
  const txnBody = document.getElementById("dataTxnBody");
  const expBody = document.getElementById("dataExpBody");
  const txnFooter = document.getElementById("dataTxnFooter");
  const expFooter = document.getElementById("dataExpFooter");
  const dateKey = dataModeState === "day" ? document.getElementById("dataDate").value : null;

  try {
    const [txns, exps] = await Promise.all([
      fetchTransactions({ dateKey, limit: 300 }),
      fetchExpenses({ dateKey, limit: 300 }),
    ]);

    const txnTotal = txns.reduce((sum, t) => sum + t.totalPaise, 0);
    const paidTotal = txns.reduce((sum, t) => sum + t.collectedPaise, 0);
    const dueTotal = txns.reduce((sum, t) => sum + t.duePaise, 0);

    txnBody.innerHTML = txns.length
      ? txns
          .map(
            (t) =>
              "<tr>" +
              '<td class="txn-time">' + escapeHtml(t.dateKey) + "</td>" +
              '<td class="txn-time">' + escapeHtml(formatKolkataTime(t.createdAt)) + "</td>" +
              '<td class="txn-customer"><div class="txn-clip">' + escapeHtml(t.customerName || "Walk-in") + "</div></td>" +
              '<td class="txn-service"><div class="txn-clip">' + escapeHtml(t.serviceName) + (t.quantity > 1 ? " &times; " + String(t.quantity) : "") + "</div></td>" +
              "<td>" + methodChip(t) + "</td>" +
              '<td class="text-right txn-num">' + String(t.quantity) + "</td>" +
              '<td class="text-right txn-num">' + formatINR(t.ratePaise) + "</td>" +
              '<td class="text-right txn-num">' + formatINR(t.totalPaise) + "</td>" +
              "</tr>"
          )
          .join("") +
          '<tr><td class="text-right" colspan="7"><strong>Total (' + txns.length + ")</strong></td>" +
          '<td class="text-right txn-num"><strong>' + formatINR(txnTotal) + "</strong></td></tr>"
      : '<tr><td colspan="8"><div class="state"><h3>No transactions</h3>' +
        "<p>" + (dateKey ? "Nothing recorded on this day." : "No transactions yet.") + "</p></div></td></tr>";

    txnFooter.innerHTML =
      "<strong>" + (txns.length === 1 ? "1 transaction" : txns.length + " transactions") + "</strong>" +
      " &middot; Total " + formatINR(txnTotal) +
      " &middot; Collected " + formatINR(paidTotal) +
      " &middot; Due " + formatINR(dueTotal);

    expBody.innerHTML = exps.length
      ? exps
          .map(
            (e) =>
              "<tr>" +
              '<td class="txn-time">' + escapeHtml(e.date) + "</td>" +
              '<td class="txn-service"><div class="txn-clip">' + escapeHtml(e.title) + "</div></td>" +
              "<td>" + escapeHtml(e.category || "—") + "</td>" +
              '<td class="text-right txn-num">' + formatINR(e.amountPaise) + "</td>" +
              "</tr>"
          )
          .join("")
      : '<tr><td colspan="4"><div class="state"><h3>No expenses</h3>' +
        "<p>" + (dateKey ? "Nothing recorded on this day." : "No expenses yet.") + "</p></div></td></tr>";

    const expTotal = exps.reduce((sum, e) => sum + e.amountPaise, 0);
    expFooter.innerHTML = "<strong>Total expenses " + formatINR(expTotal) + "</strong>" +
      (dateKey ? " &middot; " + escapeHtml(dateKey) : " &middot; most recent first");
  } catch (err) {
    console.error("[trustx-ledger] all-data:", err);
    txnBody.innerHTML =
      '<tr><td colspan="8"><div class="state is-error"><h3>Could not load data</h3><p>' + escapeHtml(reportError(err)) + "</p></div></td></tr>";
    expBody.innerHTML = "";
  }
}