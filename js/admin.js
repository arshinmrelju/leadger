/* =========================================================
   TrustX Ledger — Developer console (admin.html)
   -----------------------------------------------------------------
   Not linked from the public navigation and gated by its own admin
   role: this browser must hold an accessGrants/{uid} grant with
   role 'admin' (see auth.js / firestore.rules) before any of this
   renders. Behind the gate the console covers the shop's
   maintenance — the service catalog, the trust registry and a
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
  seedDefaultServices,
  updateService,
  fetchTransactions,
  fetchExpenses,
} from "./ledger.js";
import { findMissingCatalogServices, SERVICE_CATALOG } from "./service-catalog.js";
import {
  reportError,
  listAccessGrants,
  revokeGrant,
  restoreGrant,
  removeGrant,
  grantAdminAccess,
  AuthError,
} from "./auth.js";
import {
  SPARK_LIMITS,
  getUsage,
  subscribeUsage,
  resetUsage,
} from "./quota.js";

function svg(id) {
  const paths = {
    services: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    data: '<path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-7"/>',
    devices:
      '<rect x="2" y="4" width="20" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    quota:
      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  return (
    '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (paths[id] || "") +
    "</svg>"
  );
}

/* =========================================================
   Free-plan usage

   Firebase's Spark plan allows 50,000 reads, 20,000 writes and 20,000
   deletes per day, and — because the project has no billing account —
   offers no budget alert to warn of them coming. The console's own Usage
   tab cannot be relied on as a warning either: it reports what was
   charged, and it deliberately omits zero-result queries and index-entry
   reads, so it is a floor rather than a total.

   So the console counts what THIS browser spends and shows the headroom.
   It is explicitly an estimate for one device, and the panel says so: its
   job is to make the wall visible before the shop hits it, not to be an
   accountant. The day rolls over at the Pacific midnight that Firestore
   actually resets on, which is mid-afternoon in India — worth seeing
   plainly, because a shop that is cut off at 1pm has no obvious reason why.
   ========================================================= */

function quotaBar(label, used, cap, pct) {
  const level = pct >= 85 ? "danger" : pct >= 60 ? "warning" : "ok";
  return (
    '<div class="quota-row">' +
    '<div class="quota-row-head"><span class="quota-row-label">' + escapeHtml(label) + "</span>" +
    '<span class="quota-row-value">' + used.toLocaleString("en-IN") + " / " + cap.toLocaleString("en-IN") +
    ' <span class="quota-row-pct">(' + pct.toFixed(pct < 1 ? 2 : 0) + "%)</span></span></div>" +
    '<div class="quota-track"><div class="quota-fill quota-' + level + '" style="width:' +
    Math.max(pct, used > 0 ? 1.5 : 0).toFixed(2) + '%"></div></div>' +
    "</div>"
  );
}

/** The panel's static half. */
function quotaPanelMarkup() {
  return (
    '<p class="small muted" style="margin:0 0 .8rem;">This shop runs on Firebase\'s free Spark plan, which allows ' +
    SPARK_LIMITS.readsPerDay.toLocaleString("en-IN") + " reads, " +
    SPARK_LIMITS.writesPerDay.toLocaleString("en-IN") + " writes and " +
    SPARK_LIMITS.deletesPerDay.toLocaleString("en-IN") +
    " deletes a day. Crossing any of them stops every read and write until the daily reset — there is no partial service and no warning from Firebase, because a Spark project has no billing account to attach a budget alert to.</p>" +
    '<div id="quotaBars">' + quotaBarsHtml(getUsage()) + "</div>" +
    '<p class="small muted" id="quotaResetNote" style="margin:.8rem 0 0;"></p>'
  );
}

function quotaBarsHtml(usage) {
  return (
    quotaBar("Document reads", usage.reads, SPARK_LIMITS.readsPerDay, usage.readsPct) +
    quotaBar("Document writes", usage.writes, SPARK_LIMITS.writesPerDay, usage.writesPct) +
    quotaBar("Document deletes", usage.deletes, SPARK_LIMITS.deletesPerDay, usage.deletesPct)
  );
}

/** Keep the panel live as this browser spends more. */
function mountQuotaPanel(mainContent) {
  const bars = mainContent.querySelector("#quotaBars");
  const note = mainContent.querySelector("#quotaResetNote");
  if (!bars || !note) return;

  subscribeUsage((usage) => {
    bars.innerHTML = quotaBarsHtml(usage);

    const resetAt = usage.resetAt ? usage.resetAt : "shortly";
    const parts = [
      "Counted by this browser only, and the Firebase console Usage tab is still the ground truth.",
      "Resets around " + resetAt + " in India time.",
    ];
    if (usage.exhausted) {
      parts.unshift("Today's limit has already been reached on this device — the app is running read-only until the reset.");
    }
    note.textContent = parts.join(" ");
  });

  const clearBtn = mainContent.querySelector("#quotaResetBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      const ok = await confirm({
        title: "Clear today's counter?",
        message:
          "This only zeroes the estimate shown above. It does not restore any Firestore quota — if the real daily limit is spent, only the reset brings it back.",
        confirmText: "Clear counter",
        cancelText: "Cancel",
        variant: "secondary",
      });
      if (ok) resetUsage();
    });
  }
}

/* =========================================================
   The admin gate
   ========================================================= */
function renderAdminGate(mainContent) {
  mainContent.innerHTML =
    '<div class="state card" style="max-width:460px;margin:2rem auto;padding:2rem;">' +
    '<svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
    "<h3>Developer console is locked</h3>" +
    '<p class="small muted">This console is kept out of the shop&rsquo;s daily screens. ' +
    "Sign in with an authorised Google admin account to manage services, trusted devices and all data.</p>" +
    '<div class="flex" style="gap:0.5rem;justify-content:center;flex-wrap:wrap;margin-top:1rem;">' +
    '<a class="btn btn-primary" href="login.html?reason=not-admin">Switch account</a>' +
    '<a class="btn btn-secondary" href="dashboard.html">Back to dashboard</a>' +
    "</div></div>";
}

/* =========================================================
   Page
   ========================================================= */
export async function renderAdminPage(ctx) {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent) return;

  /* Second gate: the shop code opens the ledger, the admin code opens
     this console. Without the admin role on this browser's own grant we
     show the unlock card instead — and the rules would refuse the access
     management anyway.

     The rules are the ONLY thing that can answer "is this account an
     admin?", because the allowlist is unreadable by any client, so we ask
     them rather than guessing: an admin-scope proof is accepted only when
     the signed-in account's OWN verified address carries the admin role in
     the allowlist, and refused for everybody else. So a non-admin visit
     costs one refused write and no UI decision, and an owner landing here
     is promoted without leaving the page.

     The proof is keyed to the verified token email, so this cannot be
     talked into: naming somebody else's address in a request would be
     refused, and a shop account cannot ask for the admin scope at all. */
  if (!ctx.isAdmin) {
    try {
      await grantAdminAccess();
      ctx.isAdmin = true;
      if (ctx.grant) ctx.grant.role = "admin";
    } catch (err) {
      /* `not-authorized` is the ordinary answer for a shop account and needs
         no noise. Anything else is a real fault — say so, rather than
         letting it read as "you are simply not an admin". */
      if (!(err instanceof AuthError) || err.code !== "not-authorized") {
        toast(reportError(err), "error");
      }
      renderAdminGate(mainContent);
      return;
    }
  }

  thisUid = ctx.grant ? ctx.grant.uid : null;

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
    '<div id="servicesList"><div class="state state-table-loading"><div class="state-loading-badge"><span class="spinner spinner-sm"></span><span>Loading services<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></span></div></div></div>' +
    "</div></section>" +

    '<section class="card mt-2" id="quotaCard">' +
    '<div class="card-header"><h3>' + svg("quota") + "Free plan usage</h3>" +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-sm btn-secondary" id="quotaResetBtn">Clear counter</button>' +
    "</div></div>" +
    '<div class="card-body">' +
    quotaPanelMarkup() +
    "</div></section>" +

    '<section class="card mt-2" id="devicesCard">' +
    '<div class="card-header"><h3>' + svg("devices") + "Trusted browsers</h3>" +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-sm btn-secondary" id="devicesRefreshBtn">Refresh</button>' +
    "</div></div>" +
    '<div class="card-body">' +
    '<p class="small muted" style="margin:0 0 .75rem;">These browsers open the ledger with their authorised Google accounts. Only an admin can revoke, restore or remove them, so a stolen Google session alone can never lock you out of your own shop. Revoke any device you do not recognise; the next time it opens the app it will ask to sign in again.</p>' +
    '<div id="devicesList"><div class="state state-table-loading"><div class="state-loading-badge"><span class="spinner spinner-sm"></span><span>Loading devices<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></span></div></div></div>' +
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
    '<tbody id="dataTxnBody"><tr><td colspan="8"><div class="state state-table-loading"><div class="state-loading-badge"><span class="spinner spinner-sm"></span><span>Loading transactions<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></span></div></div></td></tr></tbody>' +
    "</table></div>" +
    '<div class="txn-footer small" id="dataTxnFooter">&nbsp;</div>' +
    '<h4 style="margin:1rem 0 .5rem;">Expenses</h4>' +
    '<div class="table-wrap"><table class="table txn-table">' +
    "<thead><tr>" +
    "<th>Date</th><th>Title</th><th>Category</th>" +
    '<th class="text-right">Amount</th>' +
    "</tr></thead>" +
    '<tbody id="dataExpBody"><tr><td colspan="4"><div class="state state-table-loading"><div class="state-loading-badge"><span class="spinner spinner-sm"></span><span>Loading expenses<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></span></div></div></td></tr></tbody>' +
    "</table></div>" +
    '<div class="txn-footer small" id="dataExpFooter">&nbsp;</div>' +
    "</div></section>";

  wireAddService();
  wireSeedDefaults();
  loadServicesList();
  mountQuotaPanel(mainContent);
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
      /* Markup, so htmlMessage rather than the escaped-by-default `message`.
         Every interpolated value below is either a count or pre-escaped. */
      htmlMessage:
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
   Trusted browsers
   -----------------------------------------------------------------
   These rows are `accessGrants/{uid}` — the same records firestore.rules
   checks before it serves any money, so Revoke here is not a UI state:
   the very next read that browser makes is denied by the backend.
   ========================================================= */
let thisUid = null;

function wireDevices() {
  const list = document.getElementById("devicesList");
  document.getElementById("devicesRefreshBtn").addEventListener("click", loadAccessGrants);

  list.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-grant-action]");
    if (!btn) return;
    const { grantAction, grantUid } = btn.dataset;
    if (!grantUid) return;

    const isThis = grantUid === thisUid;
    if (grantAction === "revoke") {
      const ok = await confirm({
        title: "Revoke this browser?",
        message:
          (isThis ? "This browser will need to sign in again on its next visit. " : "") +
          "It cannot read or record anything until it is restored or signs in with Google again.",
        confirmText: "Revoke",
        variant: "danger",
      });
      if (!ok) return;
      try {
        await revokeGrant(grantUid);
        toast(isThis ? "This browser revoked. It will need the code next time." : "Browser revoked.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    } else if (grantAction === "restore") {
      const ok = await confirm({
        title: "Restore this browser?",
        message: "It will open the ledger with its Google account again.",
        confirmText: "Restore",
        variant: "primary",
      });
      if (!ok) return;
      try {
        await restoreGrant(grantUid);
        toast("Browser restored.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    } else if (grantAction === "remove") {
      const ok = await confirm({
        title: "Remove this browser?",
        message:
          (isThis ? "This browser will need to sign in again on its next visit. " : "") +
          "Its trust record is deleted and cannot be restored — it must sign in with Google again.",
        confirmText: "Remove",
        variant: "danger",
      });
      if (!ok) return;
      try {
        await removeGrant(grantUid);
        toast("Browser removed.", "success");
      } catch (err) {
        toast(reportError(err), "error");
      }
    }
    loadAccessGrants();
  });

  /* Paint the list on open, not only after a button is pressed. */
  loadAccessGrants();
}

function fmtTs(ts) {
  if (!ts) return "—";
  const dt = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  if (Number.isNaN(dt.getTime())) return "—";
  return escapeHtml(formatKolkataLong(dt) + ", " + formatKolkataTime(dt));
}

function grantRow(g) {
  const isThis = g.uid === thisUid;
  const isAdmin = g.role === "admin";
  const label = String(g.label || "Unnamed browser").trim() || "Unnamed browser";
  const ua = (g.client && g.client.ua) || "";
  const subBits = [ua, g.client && g.client.lang ? g.client.lang : ""].filter(Boolean);
  return (
    '<div class="dev-row">' +
    '<div class="dev-main">' +
    '<div class="dev-title">' + escapeHtml(label) +
    (isThis ? ' <span class="badge badge-accent">This browser</span>' : "") +
    (isAdmin ? ' <span class="badge badge-neutral">Admin</span>' : "") +
    "</div>" +
    '<div class="dev-sub">' + escapeHtml(subBits.join(" &middot; ")) + "</div>" +
    '<div class="dev-sub small muted">Trusted ' + fmtTs(g.createdAt) +
    ' &middot; Last used ' + fmtTs(g.lastUsedAt) + "</div>" +
    "</div>" +
    '<div class="dev-side">' +
    '<span class="badge ' + (g.active ? "badge-success" : "badge-neutral") + '">' +
    (g.active ? "Active" : "Revoked") + "</span>" +
    (g.active
      ? '<button type="button" class="btn btn-secondary btn-sm" data-grant-action="revoke" data-grant-uid="' + escapeHtml(g.uid) + '">Revoke</button>'
      : '<button type="button" class="btn btn-primary btn-sm" data-grant-action="restore" data-grant-uid="' + escapeHtml(g.uid) + '">Restore</button>') +
    '<button type="button" class="btn btn-secondary btn-sm" data-grant-action="remove" data-grant-uid="' + escapeHtml(g.uid) + '">Remove</button>' +
    "</div>" +
    "</div>"
  );
}

async function loadAccessGrants() {
  const list = document.getElementById("devicesList");
  if (!list) return;
  try {
    const grants = await listAccessGrants();
    list.innerHTML = grants.length
      ? grants.map((g) => grantRow(g)).join("")
      : '<div class="state" style="padding:1rem 0;"><p class="muted" style="margin:0;">No trusted browsers yet. The first browser to sign in with an authorised Google account appears here.</p></div>';
  } catch (err) {
    console.error("[trustx-ledger] access grants:", err);
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