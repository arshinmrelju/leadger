/* =========================================================
   TrustX Ledger — Grouped, searchable service picker
   -----------------------------------------------------------------
   Replaces the flat "Service *" <select> in the record-a-sale dialog.
   A counter with 25+ services cannot use a dropdown: nothing is
   findable in a flat list of names and prices, and the list is longer
   than the phone screen.

   The picker is a listbox combobox (WAI-ARIA pattern):
     - search box that filters on name, tile code and rate
     - services arranged under their group headings
     - full keyboard control (arrows / Home / End / Enter / Esc / type)
     - one tap target per row, sized for a thumb
   and it keeps a real focusable textbox as its own value, so no hidden
   input has to mirror the selection.

   It is a CONTROL, not a form field: nothing is read from a <select>,
   and the caller gets the chosen service back through onSelect(). That
   is why the file (and the browser) never needs a <form> to work.

   Deliberately Firebase-free and DOM-light, so the matching helpers are
   unit-testable in Node (see tests/ledger.mjs).
   ========================================================= */

import { SERVICE_CATALOG_GROUPS } from "./service-catalog.js";

/* ---------------- Matching / arrangement (pure) ---------------- */

/**
 * A service is found by its name, its two-letter tile code or its rate —
 * the three things the person at the counter already knows.
 */
export function serviceMatchesQuery(service, query) {
  const q = String(query ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!q) return true;
  return serviceSearchText(service).includes(q);
}

function serviceSearchText(service) {
  if (!service || typeof service !== "object") return "";
  const price = Number.isFinite(service.pricePaise) ? String(service.pricePaise) : "";
  return [service.name, service.code, price]
    .map((v) => String(v ?? "").toLowerCase())
    .join(" ");
}

/**
 * The group heading a service belongs under, derived from the `sortOrder`
 * band the catalog seed writes (100s = printing, 200s = computer, ...).
 * The catalog deliberately stores no `category` field — the rules pin the
 * service keys — so the band is the only grouping that survives a write.
 */
export function serviceGroupOf(service) {
  const order = Number(service && service.sortOrder);
  if (!Number.isFinite(order) || order <= 0) {
    return { id: "other", label: "Other services" };
  }
  const match = SERVICE_CATALOG_GROUPS.find(
    (g) => order >= g.base && order < g.base + 100
  );
  return match
    ? { id: match.id, label: match.label }
    : { id: "other", label: "Other services" };
}

/**
 * Group services under their headings, dropping empty groups.
 * A group heading is sticky when the list fits on screen — the heading
 * tells the eye which group the next rows belong to, so scrolling past
 * it is only ever a small loss.
 */
export function groupServices(services) {
  const buckets = new Map();
  for (const service of Array.isArray(services) ? services : []) {
    if (!service) continue;
    /* fetchServices() already hides archived rows, but the picker must not
       offer a deleted service if it is ever handed raw documents. */
    if (service.active === false) continue;
    const { id, label } = serviceGroupOf(service);
    if (!buckets.has(id)) buckets.set(id, { id, label, items: [] });
    buckets.get(id).items.push(service);
  }

  /* "Other services" has no band of its own, so it sorts after every seeded
     group instead of jumping to the top of the list. */
  const baseOf = (id) => {
    if (id === "other") return Number.MAX_SAFE_INTEGER;
    const group = SERVICE_CATALOG_GROUPS.find((g) => g.id === id);
    return group ? group.base : Number.MAX_SAFE_INTEGER;
  };
  /* Inside a group the incoming order is kept: fetchServices() already
     sorted by sortOrder, which is the catalog's curated order. Alphabetical
     re-sorting would scramble it. */
  return [...buckets.values()].sort((a, b) => baseOf(a.id) - baseOf(b.id));
}

/** Filter, then arrange. The result drives every render of the list. */
export function filterAndGroupServices(services, query) {
  const matching = (Array.isArray(services) ? services : []).filter((s) =>
    s && serviceMatchesQuery(s, query)
  );
  return groupServices(matching);
}

/** Rows for a service, with 1-based numbers for `aria-posinset`. */
export function flattenOptions(groups) {
  const rows = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    rows.push({ type: "group", id: group.id, label: group.label });
    for (const service of group.items) {
      rows.push({ type: "service", id: service.serviceId, service });
    }
  }
  return rows;
}

/** How many real services a flattened row list holds (headings excluded). */
export function countServiceRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r.type === "service").length;
}

/** "8 services" / "1 service" / 'No match for "pccx"' — takes FLATTENED rows. */
export function resultsSummary(rows, query) {
  const count = countServiceRows(rows);
  if (!count) {
    const q = String(query ?? "").trim();
    return q ? 'No match for "' + q + '"' : "No services yet";
  }
  return count === 1 ? "1 service" : count + " services";
}

/** The tile glyph: the stored code, else the name's initials. */
export function serviceTile(service) {
  /* A hand-typed code can be anything, so it is squashed to two plain
     characters — "A-VERY-LONG" must not put a dash on the tile. */
  const code = String((service && service.code) || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase();
  if (code) return code;
  const fromName = String((service && service.name) || "")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase();
  return (fromName || "SV").slice(0, 2);
}

/**
 * Where the highlighted row should land, as an index into the FLATTENED
 * row list (group headings included, so Home/End feel right).
 */
export function nextActiveIndex(rows, current, delta) {
  if (!Array.isArray(rows) || !rows.length) return -1;
  const isService = (i) => rows[i] && rows[i].type === "service";
  let i = current;
  for (let step = 0; step < rows.length; step += 1) {
    i += delta;
    /* Past either end: wrap to the far end, skipping headings there too. */
    if (i < 0 || i >= rows.length) return wrapIndex(rows, delta);
    if (isService(i)) return i;
  }
  return current;
}

/** The row a wrapped arrow key lands on: the far end of the list. */
function wrapIndex(rows, delta) {
  const order = delta > 0 ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
  for (const i of order) {
    if (rows[i].type === "service") return i;
  }
  return -1;
}

/**
 * Where a `position: fixed` box has to be TOLD to sit, given where it landed.
 *
 * A `position: fixed` element is placed against its nearest *transformed*
 * ancestor rather than the viewport, so a first attempt measured against the
 * viewport can land off by that ancestor's offset. Since the rendered position
 * is `ancestorOffset + toldPosition`, the offset is `-(want - got)` and adding
 * the measured error back onto the wanted value cancels it exactly.
 *
 * @param {number} wantLeft viewport x the box should end up at
 * @param {number} wantTop  viewport y the box should end up at
 * @param {number} gotLeft  viewport x it actually ended up at
 * @param {number} gotTop   viewport y it actually ended up at
 * @returns {{left: number, top: number}|null} null when the first try was right
 */
export function fixedPlacementCorrection(wantLeft, wantTop, gotLeft, gotTop) {
  const dx = wantLeft - gotLeft;
  const dy = wantTop - gotTop;
  /* Sub-pixel noise is not worth a second style write. */
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  return { left: Math.round(wantLeft + dx), top: Math.round(wantTop + dy) };
}

/* ---------------- The control ---------------- */

let seq = 0;

/**
 * Build a service picker inside `mount`.
 * @param {HTMLElement} mount
 * @param {object} handlers
 * @param {Function} handlers.onSelect  (service|null) — the choice changed
 * @param {Function} [handlers.onOpen]  the list opened
 * @param {Function} [handlers.onCreate] (query) — the user asked to add a service
 * @returns {{setServices, setValue, getValue, open, close, focus, destroy}}
 */
export function createServicePicker(
  mount,
  { onSelect, onOpen, onCreate, inputId = "" } = {}
) {
  if (!mount) throw new Error("createServicePicker needs a mount element");

  const uid = "svc-pick-" + ++seq;
  const emit = (fn, ...args) => {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (err) {
      console.error("[trustx-ledger] service picker handler:", err);
    }
  };

  let services = [];
  let selectedId = "";
  let open = false;
  let rows = [];
  let activeIndex = -1;
  /* The box doubles as a search field, so the text in it and the text being
     searched are not the same thing: on open the box shows the chosen
     service with the text selected, while `query` is still empty and the
     list is unfiltered. A keystroke then replaces the whole name. */
  let query = "";

  /* `mousedown` outside the widget: blur must not close the list before a
     row's click has been delivered. `root` (not `mount`) is the boundary, so
     the menu counts as inside even though it is positioned on the viewport. */
  document.addEventListener("mousedown", onDocMouseDown, true);

  function onDocMouseDown(event) {
    if (!open) return;
    if (root && root.contains(event.target)) return;
    close();
  }

  function listId() {
    return uid + "-list";
  }

  function optionId(index) {
    return uid + "-opt-" + index;
  }

  function render() {
    const input = root.querySelector(".svc-pick-input");
    const list = root.querySelector(".svc-pick-list");
    const menu = root.querySelector(".svc-pick-menu");
    const count = root.querySelector(".svc-pick-count");
    const clear = root.querySelector(".svc-pick-clear");
    /* The clear button tracks whatever the box ends up showing, so it is
       synced after the value is settled rather than before. */
    const syncClear = () => {
      if (clear) clear.hidden = !input.value;
    };

    if (!open) {
      /* Closed, the box shows the CHOICE. This must be unconditional: choose()
         commits, then closes, and the blur only happens afterwards, so a
         "don't touch it while focused" guard would leave the box showing the
         search text instead of the name that was just ticked. With nothing
         chosen yet, the typed text is kept — that is the "type a new name,
         then add it" flow, and close() has stashed it in `query`. */
      const service = services.find((s) => s.serviceId === selectedId);
      input.value = service ? service.name : query || "";
      syncClear();
      menu.hidden = true;
      root.classList.remove("is-open");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }

    rows = flattenOptions(filterAndGroupServices(services, query));
    menu.hidden = false;
    root.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    reposition();

    const total = countServiceRows(rows);
    if (!total) {
      activeIndex = -1;
      list.innerHTML =
        '<div class="svc-pick-none">' +
        '<p class="muted" style="margin:0;">No match in your catalog.</p>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-svc-pick-create>Add "' +
        escapeHtml(query.trim()) +
        '" as a service</button>' +
        "</div>";
    } else {
      if (activeIndex >= rows.length || !rows[activeIndex] || rows[activeIndex].type !== "service") {
        /* Keep the highlight on the chosen service when it survived the
           filter, otherwise start at the top. */
        activeIndex = Math.max(
          0,
          rows.findIndex((r) => r.type === "service" && r.id === selectedId)
        );
      }
      let position = 0;
      list.innerHTML = rows
        .map((row, index) => {
          if (row.type === "group") {
            return (
              '<div class="svc-pick-group" role="presentation">' +
              escapeHtml(row.label) +
              "</div>"
            );
          }
          position += 1;
          const s = row.service;
          const chosen = s.serviceId === selectedId;
          return (
            '<div class="svc-pick-row' +
            (chosen ? " is-selected" : "") +
            (index === activeIndex ? " is-active" : "") +
            '" role="option" id="' +
            optionId(index) +
            '" data-svc-id="' +
            escapeHtml(s.serviceId) +
            '" data-svc-index="' +
            index +
            '" aria-selected="' +
            (chosen ? "true" : "false") +
            '" aria-posinset="' +
            position +
            '" aria-setsize="' +
            total +
            ">" +
            '<span class="svc-pick-tile">' +
            escapeHtml(serviceTile(s)) +
            "</span>" +
            '<span class="svc-pick-name">' +
            escapeHtml(s.name) +
            "</span>" +
            '<span class="svc-pick-price">' +
            /* Always show the rate, even at ₹0: a seeded service really
               is ₹0 until the shop prices it, and a dash would read as
               "unknown" instead. */
            escapeHtml(rupees(s.pricePaise)) +
            "</span>" +
            (chosen
              ? '<span class="svc-pick-tick" aria-hidden="true">&#10003;</span>'
              : "") +
            "</div>"
          );
        })
        .join("");
    }

    if (count) count.textContent = resultsSummary(rows, query);
    syncClear();
    input.setAttribute(
      "aria-activedescendant",
      activeIndex >= 0 && rows[activeIndex] ? optionId(activeIndex) : ""
    );
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const menu = root.querySelector(".svc-pick-menu");
    const el = menu && menu.querySelector(".is-active");
    if (!el) return;
    /* The MENU is the scroll container (the list inside it grows freely), and
       it is the positioned element, so offsetTop is already measured from the
       menu's top edge. Only its scrollTop is touched: scrollIntoView() would
       also scroll ancestors, dragging the dialog out from under a
       viewport-pinned menu. */
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = bottom - menu.clientHeight;
    }
  }

  function commit(service) {
    selectedId = service ? service.serviceId : "";
    emit(onSelect, service || null);
  }

  function choose(id) {
    const service = services.find((s) => s.serviceId === id);
    if (!service) return;
    commit(service);
    close();
    const input = root.querySelector(".svc-pick-input");
    input.blur();
    /* Hand focus to the quantity box: the next thing to fill in. */
    const qty = document.getElementById("qtyInput");
    if (qty) qty.focus();
    else input.focus();
  }

  function doOpen() {
    if (open) return;
    open = true;
    activeIndex = -1;
    /* Start from the unfiltered list, even when a service is already
       chosen: the box shows its name with the text selected, so the very
       first keystroke searches from scratch instead of appending to
       "Passport Photo" and matching nothing. */
    query = "";
    const input = root.querySelector(".svc-pick-input");
    if (selectedId && document.activeElement === input) input.select();
    render();
    scheduleReposition();
    emit(onOpen);
  }

  function close() {
    if (!open) return;
    open = false;
    activeIndex = -1;
    /* The last search is only worth keeping if nothing is chosen yet — that
       is the "type a new name, then add it" flow. */
    if (!selectedId) query = root.querySelector(".svc-pick-input").value;
    else query = "";
    render();
  }

  function move(delta) {
    if (!open) doOpen();
    const target = nextActiveIndex(rows, activeIndex, delta);
    if (target < 0) return;
    activeIndex = target;
    render();
  }

  function onKeyDown(event) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        if (!open) return;
        event.preventDefault();
        activeIndex = nextActiveIndex(rows, rows.length, -1);
        render();
        break;
      case "End":
        if (!open) return;
        event.preventDefault();
        activeIndex = nextActiveIndex(rows, -1, 1);
        render();
        break;
      case "Enter": {
        if (!open) return;
        const row = rows[activeIndex];
        if (!row || row.type !== "service") return;
        event.preventDefault();
        choose(row.id);
        break;
      }
      case "Escape":
        /* Closed: let the bubble reach the app's own Escape handler, which
           closes the modal. Open: the first Escape only dismisses the list. */
        if (!open) break;
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case "Tab":
        /* Tabbing away commits the highlight rather than losing the pick. */
        if (open && rows[activeIndex] && rows[activeIndex].type === "service") {
          choose(rows[activeIndex].id);
        }
        break;
      default:
        break;
    }
  }

  function onInput() {
    /* Typing re-filters, so the highlight cannot stay where it was. */
    query = root.querySelector(".svc-pick-input").value;
    activeIndex = -1;
    if (!open) open = true;
    render();
  }

  function onListMouseDown(event) {
    const createBtn = event.target.closest("[data-svc-pick-create]");
    if (createBtn) {
      event.preventDefault();
      const typed = query.trim();
      close();
      emit(onCreate, typed);
      return;
    }
    const row = event.target.closest("[data-svc-id]");
    if (!row) return;
    event.preventDefault();
    choose(row.dataset.svcId);
  }

  function onListMouseMove(event) {
    const row = event.target.closest("[data-svc-id]");
    if (!row) return;
    const index = Number(row.dataset.svcIndex);
    if (index === activeIndex) return;
    activeIndex = index;
    /* Highlight the row in place. Re-rendering the whole list on every mouse
       move would rebuild the nodes under the pointer and can lose the
       scroll position mid-list. */
    list.querySelectorAll("[data-svc-index]").forEach((el) => {
      el.classList.toggle("is-active", Number(el.dataset.svcIndex) === index);
    });
    root
      .querySelector(".svc-pick-input")
      .setAttribute("aria-activedescendant", optionId(index));
    scrollActiveIntoView();
  }

  const root = document.createElement("div");
  root.className = "svc-pick";
  root.innerHTML =
    '<div class="svc-pick-control">' +
    '<span class="svc-pick-lead" aria-hidden="true">&#9906;</span>' +
    '<input class="svc-pick-input" type="text" role="combobox" autocomplete="off" ' +
    'autocapitalize="off" spellcheck="false" enterkeyhint="go" ' +
    (inputId ? 'id="' + escapeHtml(inputId) + '" ' : "") +
    'aria-autocomplete="list" aria-expanded="false" aria-controls="' +
    listId() +
    '" placeholder="Search or pick a service" />' +
    '<span class="svc-pick-count" aria-hidden="true"></span>' +
    '<button type="button" class="svc-pick-clear" aria-label="Clear service" hidden>' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M18 6 6 18M6 6l12 12"/></svg>' +
    "</button>" +
    '<span class="svc-pick-caret" aria-hidden="true">&#9662;</span>' +
    "</div>" +
    '<div class="svc-pick-menu" hidden>' +
    '<div class="svc-pick-list" id="' +
    listId() +
    '" role="listbox" aria-label="Services"></div>' +
    "</div>";

  /* The dialog body scrolls (overflow-y:auto), which would clip and drag an
     in-flow dropdown, so the menu is pinned to the viewport and measured
     against the control.

     The measure is done in two passes on purpose. A `position: fixed` element
     is positioned against its nearest TRANSFORMED ancestor, not the viewport
     — and `.modal` animates in with `transform: translateY(12px) scale(.98)`
     over 200ms while the dialog focuses its first field after only 60ms. A
     single pass would bake that transient offset in and the list would sit
     beside the field instead of under it, until the next render (i.e. until
     the counter typed something). Reading the menu's own rect back and adding
     the measured error to the value converges in one step whatever the
     containing block turns out to be — see fixedPlacementCorrection(). */
  function reposition() {
    const menu = root.querySelector(".svc-pick-menu");
    if (!open || menu.hidden) return;
    const control = root.querySelector(".svc-pick-control");
    const box = control.getBoundingClientRect();
    const gap = 5;
    const wantLeft = Math.round(box.left);
    const wantTop = Math.round(box.bottom + gap);
    /* Only downwards: the field is the first control in the dialog, so there
       is always room, and anchoring one edge keeps the correction exact. */
    const room = Math.max(140, window.innerHeight - box.bottom - gap - 8);

    menu.style.position = "fixed";
    menu.style.left = wantLeft + "px";
    menu.style.width = Math.round(box.width) + "px";
    menu.style.maxHeight = Math.round(room) + "px";
    menu.style.top = wantTop + "px";

    const got = menu.getBoundingClientRect();
    const fix = fixedPlacementCorrection(wantLeft, wantTop, got.left, got.top);
    if (fix) {
      menu.style.left = fix.left + "px";
      menu.style.top = fix.top + "px";
    }
  }

  function onViewportChange(event) {
    if (!open) return;
    /* Scrolling the list itself does not move the control, so there is
       nothing to re-measure — and a scroll event fires per frame. */
    const menu = root.querySelector(".svc-pick-menu");
    if (event && event.target && menu.contains(event.target)) return;
    reposition();
  }

  /* The dialog animates in over 200ms, so the first measure can land while a
     transform is still on an ancestor. Re-measure once the frame is painted
     and again when the dialog's animation finishes. */
  function scheduleReposition() {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (open) reposition();
      });
    }
    const animated = root.closest(".modal, .modal-overlay");
    if (animated && typeof animated.addEventListener === "function") {
      animated.addEventListener("transitionend", onViewportChange, { once: true });
    }
  }

  const control = root.querySelector(".svc-pick-control");
  control.querySelector(".svc-pick-input").addEventListener("focus", doOpen);
  control.querySelector(".svc-pick-input").addEventListener("keydown", onKeyDown);
  control.querySelector(".svc-pick-input").addEventListener("input", onInput);
  /* Tapping anywhere on the box opens the list, like a native select does.
     mousedown rather than click, so the list is already up on mouse-up. */
  control.addEventListener("mousedown", (event) => {
    if (event.target.closest(".svc-pick-clear")) return;
    if (open) return;
    doOpen();
    const input = control.querySelector(".svc-pick-input");
    /* Keep the caret in the search box rather than losing the click. */
    input.focus();
    if (selectedId) input.select();
  });
  control.querySelector(".svc-pick-clear").addEventListener("click", () => {
    const input = root.querySelector(".svc-pick-input");
    /* Clearing empties the box, so it must also drop the choice — otherwise
       the sale would still submit a service the box no longer shows. */
    input.value = "";
    query = "";
    activeIndex = -1;
    commit(null);
    render();
    input.focus();
  });
  const list = root.querySelector(".svc-pick-list");
  list.addEventListener("mousedown", onListMouseDown);
  list.addEventListener("mousemove", onListMouseMove);

  /* Capture phase: catches the dialog body's scroll, not just the window's. */
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("scroll", onViewportChange, true);

  mount.appendChild(root);

  return {
    setServices(next) {
      services = Array.isArray(next) ? next.filter(Boolean) : [];
      /* A service that was archived or removed must not linger as the
         displayed choice. */
      if (selectedId && !services.some((s) => s.serviceId === selectedId)) {
        commit(null);
      }
      render();
    },
    /**
     * Programmatic selection — from a quick tile, a preselected sale, or
     * the host restoring a choice. Notifies onSelect like a tap does, so
     * there is one code path that fills the rate and recalculates.
     */
    setValue(id) {
      const service = services.find((s) => s.serviceId === String(id || "")) || null;
      /* A programmatic choice replaces whatever was being searched for, so the
         box shows the service rather than the abandoned search text. */
      query = "";
      commit(service);
      /* Written here too, because setValue can arrive while the list is open
         and the open branch deliberately leaves the text alone. */
      root.querySelector(".svc-pick-input").value = service ? service.name : "";
      if (open) {
        activeIndex = Math.max(
          0,
          rows.findIndex((r) => r.type === "service" && r.id === selectedId)
        );
      }
      render();
    },
    getValue() {
      return selectedId;
    },
    isOpen() {
      return open;
    },
    open: doOpen,
    close,
    focus() {
      root.querySelector(".svc-pick-input").focus();
    },
    destroy() {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      root.remove();
    },
  };
}

/* ---------------- Small local helpers ---------------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const rupees = (() => {
  const fmt = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });
  return (paise) => fmt.format(paise / 100);
})();
