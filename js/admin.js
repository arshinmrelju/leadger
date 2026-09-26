/* =========================================================
   TrustX Ledger — Developer console (admin.html)
   -----------------------------------------------------------------
   Not linked from the public navigation and gated by its own admin
   code: this browser must hold an admins/{uid} grant (see auth.js /
   firestore.rules) before any of this renders. Behind the gate the
   console covers the shop's maintenance — the service catalog, the
   trust registry and a full-data browser. The dashboard stays
   operational-only.
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
  seedDefaultServices,
  updateService,
  fetchTransactions,
  fetchExpenses,
} from "./ledger.js";
import { findMissingCatalogServices, SERVICE_CATALOG } from "./service-catalog.js";
import {
  reportError,
  listTrustedDevices,
  listAdminGrants,
  revokeDevice,
  restoreDevice,
  removeDevice,
  grantAdminAccess,
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
   The admin-code gate
   ========================================================= */
function renderAdminGate(mainContent) {
  mainContent.innerHTML =
    '<div class="state card" style="max-width:460px;margin:2rem auto;padding:2rem;">' +
    '<svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
    "<h3>Developer console is locked</h3>" +
    '<p class="small muted">This console is kept out of the shop&rsquo;s daily screens. ' +
    "Enter the admin code to manage services, trusted devices and all data.</p>" +
    '<div class="field" style="text-align:left;">' +
    '<label class="small muted" for="adminCodeInput">Admin code</label>' +
    '<input class="input" id="adminCodeInput" type="password" autocomplete="off" ' +
    'autocapitalize="characters" spellcheck="false" placeholder="ADMIN CODE" />' +
    "</div>" +
    '<div class="flex" style="gap:0.5rem;justify-content:center;flex-wrap:wrap;margin-top:1rem;">' +
    '<button type="button" class="btn btn-primary" id="adminUnlockBtn">Unlock console</button>' +
    '<a class="btn btn-secondary" href="dashboard.html">Back to dashboard</a>' +
    "</div></div>";

  const input = document.getElementById("adminCodeInput");
  const btn = document.getElementById("adminUnlockBtn");

  const submit = async () => {
    if (!input.value.trim()) {
      toast("Enter the admin code.", "error");
      input.focus();
      return;
    }
    setLoading(btn, true);
    try {
      await grantAdminAccess(input.value);
      /* The grant now lives server-side, so a reload picks it up and the
         console renders for real. */
      window.location.reload();
    } catch (err) {
      toast(reportError(err), "error");
      input.value = "";
      setLoading(btn, false);
      input.focus();
    }
  };

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  input.focus();
}

/* =========================================================
   Page
   ========================================================= */
export async function renderAdminPage(ctx) {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;

  /* Second gate: the shop code opens the ledger, the admin code opens
     this console. Without a grant we show the unlock card instead of the
     console — the rules would refuse the device management anyway. */
  if (!ctx.isAdmin) {
    renderAdminGate(mainContent);
    return;
  }

  thisDeviceHash = ctx.trust ? ctx.trust.tokenHash : null;

  mainContent.innerHTML =
    '<div class="dash-head">' +
    "<div>" +
    "<h1>Developer console</h1>" +
    '<p class="small muted">Admin-only: services maintenance, trusted devices and full data access.</p>' +
    "</div>" +
    '<span class="pill pill-accent" id="devShopPill">' + escapeHtml(ctx.general ? ctx.general.name || "TrustX Ledger" : "TrustX Ledger") + "</span>" +
    "</div>" +

    '<section class="card" id="servicesCard">' +
    '<div class="card-header"><h3>' + svg("services") + "Services</h3>" +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="seedSvcBtn" title="Add the default service list (printing, certificates, online work, photos)">Add default services</button>' +
    "</div></div>" +
    '<div class="card-body">' +
    '<div class="rule-row">' +
    '<div class="field" style="margin:0;flex:1;"><input class="input" id="addSvcName" type="text" maxlength="80" placeholder="New service name" /></div>' +
    '<div class="field" style="margin:0;width:130px;"><input class="input" id="addSvcPrice" type="text" inputmode="decimal" placeholder="Rate (&curren;)" /></div>' +
    '<div class="flex" style="gap:0.5rem;">' +
    '<button type="button" class="btn btn-secondary btn-sm" id="addSvcClear">Clear</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="addSvcSave">Add service</button>' +
    "</div></div>" +
    '<p class="small muted" id="seedSvcNote" style="margin:.75rem 0 .25rem;">The default list is added automatically the first time a device opens the app &mdash; printing, DTP, certificates, online applications and photos. Every service starts at &curren;0, so set your rate on the row below. The button only adds whatever is still missing.</p>' +
    '<div id="servicesList"><div class="state"><span class="spinner" aria-hidden="true"></span><p class="muted">Loading services&hellip;</p></div></div>' +
    "</div></section>" +

    '<section class="card mt-2" id="devicesCard">' +
    '<div class="card-header"><h3>' + svg("devices") + "Trusted devices</h3>" +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-sm btn-secondary" id="devicesRefreshBtn">Refresh</button>' +
    "</div></div>" +
    '<div class="card-body">' +
    '<p class="small muted" style="margin:0 0 .75rem;">These browsers open the ledger without the shop code. Only an admin can revoke, restore or remove them, so the shop code alone can never lock you out of your own shop. Revoke any device you do not recognise; the next time it opens the app it will ask for the code again.</p>' +
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
  wireSeedDefaults();
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

/**
 * Re-run the default catalog seed. The shell already does this on every
 * protected page, so this button is a repair tool: it reports how much is
 * still missing, never duplicates a service, and disables itself once the
 * catalog covers the list.
 */
function wireSeedDefaults() {
  const btn = document.getElementById("seedSvcBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    let missing = [];
    try {
      const existing = await fetchServices({ includeInactive: true });
      missing = findMissingCatalogServices(existing);
    } catch (err) {
      toast(reportError(err), "error");
      return;
    }

    if (!missing.length) {
      toast("Your catalog already covers the default list.", "info");
      return;
    }

    const preview = missing
      .map((m) => escapeHtml(m.name))
      .join(", ");
    const ok = await confirm({
      title: "Add default services",
      message:
        '<p class="small">This adds ' + missing.length + " of " + SERVICE_CATALOG.length +
        " default services at &curren;0, in counter order. You can rename, re-price or archive any of them afterwards.</p>" +
        '<p class="small muted" style="margin-bottom:0;">' + preview + "</p>",
      confirmText: "Add " + missing.length,
      variant: "primary",
    });
    if (!ok) return;

    setLoading(btn, true);
    btn.textContent = "Adding…";
    try {
      /* 25 sequential writes is a visible wait on a slow connection, so
         report progress rather than leaving the button inert. */
      const { created } = await seedDefaultServices({
        onProgress: ({ done, total }) => {
          btn.textContent = "Adding " + done + "/" + total + "…";
        },
      });
      toast(
        created.length
          ? created.length + " services added. Set your rates in the list below."
          : "Nothing to add.",
        "success",
      );
    } catch (err) {
      toast(reportError(err), "error");
    } finally {
      /* Stay inert until the refreshed list has recomputed the count. */
      setLoading(btn, true);
      loadServicesList();
    }
  });
}

/** Keep the seed button honest about how many defaults are still missing. */
function updateSeedButton(services) {
  const btn = document.getElementById("seedSvcBtn");
  if (!btn) return;
  const missing = findMissingCatalogServices(services);
  btn.textContent = missing.length
    ? "Add " + missing.length + " default service" + (missing.length === 1 ? "" : "s")
    : "Defaults added";
  btn.title = missing.length
    ? "Add the " + missing.length + " default service(s) not in your catalog yet"
    : "Your catalog already covers the default list";
  setLoading(btn, missing.length === 0);
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
    updateSeedButton(services);
    list.innerHTML =
      services.map(serviceRow).join("") ||
      '<div class="state" style="padding:1rem 0;"><p class="muted" style="margin:0;">No services yet &mdash; the default list seeds itself on the next sign-in, or use the button above.</p></div>';

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
    /* The seed button holds its loading state across a refresh so it cannot
       be double-clicked mid-seed — so release it here, where we know the
       count could not be recomputed. */
    const seedBtn = document.getElementById("seedSvcBtn");
    if (seedBtn) {
      setLoading(seedBtn, false);
      seedBtn.textContent = "Add default services";
    }
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

function deviceRow(d, adminUids) {
  const isThis = d.tokenHash === thisDeviceHash;
  const isAdmin = Array.isArray(adminUids) && adminUids.includes(d.uid);
  const label = String(d.label || "Untitled device").trim() || "Untitled device";
  const ua = (d.client && d.client.ua) || "";
  const subBits = [ua, networkSummary(d)].filter(Boolean);
  return (
    '<div class="dev-row">' +
    '<div class="dev-main">' +
    '<div class="dev-title">' + escapeHtml(label) +
    (isThis ? ' <span class="badge badge-accent">This browser</span>' : "") +
    (isAdmin ? ' <span class="badge badge-neutral">Admin</span>' : "") +
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
    /* Best effort: the rules only allow this list to admins, and we are
       already behind the admin gate — but never let it break the list. */
    let adminUids = [];
    try {
      adminUids = await listAdminGrants();
    } catch (err) {
      console.warn("[trustx-ledger] admin grants list unavailable:", err);
    }
    list.innerHTML = devices.length
      ? devices.map((d) => deviceRow(d, adminUids)).join("")
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