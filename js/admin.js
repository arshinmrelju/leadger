/* =========================================================
   SEVA LEDGER — Developer console (admin.html)
   -----------------------------------------------------------------
   The ADMIN role IS the developer. This page is the management
   console: members, shop access code, services maintenance and a
   full-data browser. The dashboard stays operational-only.
   ========================================================= */

import { toast, confirm, setLoading } from "./app.js";
import {
  formatINR,
  formatKolkataTime,
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
  getCurrentUser,
  reportError,
  ROLES,
  roleLabel,
  listMembers,
  listPendingInvites,
  inviteMember,
  setMemberRole,
  setMemberActive,
  cancelInvite,
  getAccessCode,
  setAccessCode,
  generateAccessCode,
} from "./auth.js";

const membersCache = [];

function shield(icon, title, text, actionsHtml) {
  return (
    '<div class="state card" style="max-width:520px;margin:2rem auto;padding:2rem;">' +
    '<svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    icon +
    "</svg>" +
    "<h3>" + escapeHtml(title) + "</h3>" +
    "<p>" + escapeHtml(text) + "</p>" +
    (actionsHtml || "") +
    "</div>"
  );
}

function svg(id) {
  const paths = {
    members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    code: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    services: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    data: '<path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-7"/>',
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

  if (!ctx.isAdmin) {
    mainContent.innerHTML = shield(
      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
      "Developer access only",
      "This is the developer console. Only accounts with the Developer role can open it.",
      '<a class="btn btn-secondary" href="dashboard.html">Back to dashboard</a>'
    );
    return;
  }

  mainContent.innerHTML =
    '<div class="dash-head">' +
    "<div>" +
    "<h1>Developer console</h1>" +
    '<p class="small muted">Members, shop access code, services and full data access.</p>' +
    "</div>" +
    '<span class="pill pill-accent" id="devShopPill">' + escapeHtml(ctx.general ? ctx.general.name || "SEVA LEDGER" : "SEVA LEDGER") + "</span>" +
    "</div>" +

    '<section class="card" id="membersCard">' +
    '<div class="card-header"><h3>' + svg("members") + "Members</h3>" +
    '<div class="card-actions"><button type="button" class="btn btn-primary btn-sm" id="openAddMemberBtn">Add member</button></div></div>' +
    '<div class="card-body" id="membersList"><div class="state"><span class="spinner" aria-hidden="true"></span><p class="muted">Loading members&hellip;</p></div></div>' +
    "</section>" +

    '<section class="card mt-2" id="codeCard">' +
    '<div class="card-header"><h3>' + svg("code") + "Shop access code</h3></div>" +
    '<div class="card-body">' +
    '<p class="small muted">Staff can sign in with this code on the shop computer instead of an email account.</p>' +
    '<div class="flex" style="gap:0.6rem;flex-wrap:wrap;align-items:center;">' +
    '<code id="shopCodeBox" style="font-size:1.3rem;letter-spacing:.12em;">&mdash;</code>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="codeCopyBtn">Copy</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="codeRegenBtn">Set code</button>' +
    "</div></div></section>" +

    '<section class="card mt-2" id="servicesCard">' +
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

  wireMembersCard();
  loadMembersList();
  wireShopCodeBox();
  wireAddService();
  loadServicesList();
  wireDataBrowser();
  loadDataBrowser();
}

/* =========================================================
   Members
   ========================================================= */
function wireMembersCard() {
  document.getElementById("openAddMemberBtn").addEventListener("click", () => {
    document.getElementById("memberEmail").value = "";
    document.getElementById("addMemberModal").classList.add("is-open");
    setTimeout(() => document.getElementById("memberEmail").focus(), 60);
  });

  document.querySelectorAll("#addMemberModal [data-close], #addMemberModal .modal-close").forEach((el) => {
    el.addEventListener("click", () => el.closest(".modal-overlay").classList.remove("is-open"));
  });

  document.getElementById("addMemberForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = document.getElementById("addMemberBtn");
    const email = document.getElementById("memberEmail").value.trim();
    if (!email) {
      toast("Enter an email address.", "error");
      return;
    }
    btn.classList.add("is-loading");
    btn.disabled = true;
    try {
      await inviteMember(email);
      document.getElementById("addMemberModal").classList.remove("is-open");
      toast("Invitation sent to " + email + ".", "success");
      loadMembersList();
    } catch (err) {
      toast(reportError(err), "error");
    } finally {
      btn.classList.remove("is-loading");
      btn.disabled = false;
    }
  });
}

function memberRow(member) {
  const isSelf = member.uid === getCurrentUser().uid;
  const active = member.active !== false;
  const name = member.name || (isSelf ? "You" : "Member");
  const email = member.email || "shop access code";
  const select =
    '<select class="select input-sm" data-role data-uid="' + escapeHtml(member.uid) + '" ' + (isSelf ? "disabled" : "") + ">" +
    '<option value="ADMIN"' + (member.role === ROLES.ADMIN ? " selected" : "") + ">Developer</option>" +
    '<option value="EMPLOYEE"' + (member.role !== ROLES.ADMIN ? " selected" : "") + ">Employee</option>" +
    "</select>";
  const toggle =
    '<button type="button" class="btn btn-sm ' + (active ? "btn-secondary" : "btn-danger-soft") + '" data-active data-uid="' + escapeHtml(member.uid) + '" ' + (isSelf ? "disabled" : "") + ">" +
    (active ? "Active" : "Disabled") + "</button>";
  return (
    '<div class="member-row">' +
    '<div class="member-info">' +
    '<div class="member-name">' + escapeHtml(name) + (isSelf ? ' <span class="small muted">(you)</span>' : "") + "</div>" +
    '<div class="member-email">' + escapeHtml(email) + "</div>" +
    "</div>" +
    select +
    toggle +
    '<span class="badge ' + (member.role === ROLES.ADMIN ? "badge-accent" : "badge-neutral") + '">' + escapeHtml(roleLabel(member.role)) + "</span>" +
    "</div>"
  );
}

async function loadMembersList() {
  const list = document.getElementById("membersList");
  if (!list) return;
  try {
    const [members, invites] = await Promise.all([listMembers(), listPendingInvites()]);
    membersCache.length = 0;
    membersCache.push(...members);
    let html = members.map(memberRow).join("");
    if (invites.length) {
      html +=
        '<div class="mt-2"><div class="small muted mb-1">Pending invitations</div>' +
        invites
          .map(
            (inv) =>
              '<div class="invite-row"><span class="badge badge-warning">Invited</span>' +
              '<span class="flex" style="flex:1;">' + escapeHtml(inv.email) + "</span>" +
              '<button type="button" class="btn btn-danger-soft btn-sm" data-cancel-invite="' + escapeHtml(inv.email) + '">Cancel</button></div>'
          )
          .join("") +
        "</div>";
    }
    if (!html) {
      html = '<div class="state"><h3>No members yet</h3><p>The owner is added automatically when the shop is set up.</p></div>';
    }
    list.innerHTML = html;

    list.querySelectorAll("[data-role]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        try {
          await setMemberRole(sel.dataset.uid, sel.value);
          toast("Role updated.", "success");
          loadMembersList();
        } catch (err) {
          toast(reportError(err), "error");
          sel.value = membersCache.find((m) => m.uid === sel.dataset.uid)?.role || sel.value;
        }
      });
    });

    list.querySelectorAll("[data-active]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const member = membersCache.find((m) => m.uid === btn.dataset.uid);
        const nextActive = member.active === false;
        const action = nextActive ? "reactivate" : "disable";
        const ok = await confirm({
          title: action === "disable" ? "Disable member" : "Reactivate member",
          message:
            action === "disable"
              ? "This member will immediately lose access to the shop until reactivated."
              : "This member will regain access to the shop.",
          confirmText: action === "disable" ? "Disable" : "Reactivate",
          variant: action === "disable" ? "danger" : "primary",
        });
        if (!ok) return;
        try {
          await setMemberActive(btn.dataset.uid, nextActive);
          toast(nextActive ? "Member reactivated." : "Member disabled.", "success");
          loadMembersList();
        } catch (err) {
          toast(reportError(err), "error");
        }
      });
    });

    list.querySelectorAll("[data-cancel-invite]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await cancelInvite(btn.dataset.cancelInvite);
          toast("Invitation cancelled.", "info");
          loadMembersList();
        } catch (err) {
          toast(reportError(err), "error");
        }
      });
    });
  } catch (err) {
    list.innerHTML = shield(
      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
      "Could not load members",
      reportError(err),
      '<button type="button" class="btn btn-secondary" onclick="window.location.reload()">Retry</button>'
    );
  }
}

/* =========================================================
   Shop access code
   ========================================================= */
async function wireShopCodeBox() {
  const box = document.getElementById("shopCodeBox");
  if (!box) return;
  const copyBtn = document.getElementById("codeCopyBtn");
  const regenBtn = document.getElementById("codeRegenBtn");
  let current = "";
  try {
    current = await getAccessCode();
  } catch (err) {
    toast(reportError(err), "error");
  }
  box.textContent = current || "—";
  regenBtn.textContent = current ? "Change code" : "Set code";

  const setCode = async (fresh) => {
    try {
      current = await setAccessCode(fresh);
      box.textContent = current;
      regenBtn.textContent = "Change code";
      toast("Shop access code set: " + current + ". Save it somewhere safe.", "success");
    } catch (err) {
      toast(reportError(err), "error");
    }
  };

  regenBtn.addEventListener("click", async () => {
    const fresh = generateAccessCode();
    const ok = await confirm({
      title: "Change shop access code",
      message: "Staff will use this code to sign in: " + fresh + ". The previous code is switched off immediately.",
      confirmText: "Use this code",
      variant: "primary",
    });
    if (!ok) return;
    await setCode(fresh);
  });

  copyBtn.addEventListener("click", async () => {
    if (!current) {
      toast("Set a code first.", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(current);
      toast("Code copied.", "success");
    } catch (_) {
      toast("Select and copy the code above.", "info");
    }
  });
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

    const txnTotal = txns.reduce((sum, t) => sum + t.totalPaise, 0);
    const paidTotal = txns.reduce((sum, t) => sum + t.collectedPaise, 0);
    const dueTotal = txns.reduce((sum, t) => sum + t.duePaise, 0);
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
    console.error("[seva-ledger] all-data:", err);
    txnBody.innerHTML =
      '<tr><td colspan="8"><div class="state is-error"><h3>Could not load data</h3><p>' + escapeHtml(reportError(err)) + "</p></div></td></tr>";
    expBody.innerHTML = "";
  }
}