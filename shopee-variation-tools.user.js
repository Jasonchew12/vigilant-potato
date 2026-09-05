// ==UserScript==
// @name         Shopee Variation Import & Export Tools
// @namespace    local.shopee.variation.tools
// @version      2.3.1
// @description  Export public Shopee variations, or import/export Seller Centre KEEP, UPDATE, and ADD changes.
// @match        https://seller.shopee.com.my/*
// @match        https://shopee.com.my/*
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (window.__shopeeVariationCsvToolsLoaded) return;
  window.__shopeeVariationCsvToolsLoaded = true;

  const VERSION = "2.3.1";
  const TOOL_ID = "shopee-variation-csv-tools";
  const MAX_VARIATIONS = 100;
  const LOG_PREFIX = "[Shopee Variation Tools]";
  const PUBLIC_VARIATION_SELECTOR = "button.product-variation, .product-variation[role='button'], button[aria-label][class*='variation'], button[aria-label][class*='selection-box'], button[aria-label][aria-disabled][class*='selection']";
  const log = (...values) => console.log(LOG_PREFIX, ...values);
  const warn = (...values) => console.warn(LOG_PREFIX, ...values);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const nameKey = (value) => normalizeText(value).toLocaleLowerCase();
  const PAGE_MODE = location.hostname === "seller.shopee.com.my"
    ? "seller"
    : /-i\.\d+\.\d+(?:$|[/?])/i.test(`${location.pathname}${location.search}`)
      ? "public"
      : "unsupported";

  if (PAGE_MODE === "unsupported") {
    log(`Userscript v${VERSION}: not a Shopee product page; no panel added`);
    return;
  }

  const state = {
    importedRows: [],
    actionByTarget: new Map(),
    detectedByName: new Map(),
    appliedFields: new Set(),
    appliedImages: new Set(),
    imageInFlight: new Set(),
    fillMode: false,
    applying: false,
    filling: false,
    observer: null,
    scheduled: false,
    expandedButtons: new WeakSet(),
    openedPublicTriggers: new WeakSet(),
    publicStockByName: new Map(),
    publicPriceByName: new Map(),
    publicScannedNames: new Set(),
    publicScanning: false,
    publicScanPromise: null,
    publicScanCancelled: false,
    lastDetectionLog: "",
    lastPanelLocation: "",
  };

  log(`Userscript v${VERSION} started in ${PAGE_MODE} mode`);
  log("Current URL:", location.href);

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (quoted) {
        if (char === '"' && next === '"') { field += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
      else field += char;
    }
    row.push(field.replace(/\r$/, ""));
    if (row.some((cell) => cell !== "")) rows.push(row);
    return rows;
  }

  function locateHeaderRow(rows) {
    const required = ["action", "current variation name", "new variation name", "price", "stock", "image url"];
    return rows.findIndex((row) => {
      const headers = row.map((cell) => normalizeText(cell).toLowerCase());
      return required.every((header) => headers.includes(header));
    });
  }

  function decimals(value) {
    const text = String(value).trim();
    const dot = text.indexOf(".");
    return dot < 0 ? 0 : text.length - dot - 1;
  }

  function validateImportedRows(csvRows) {
    const headerIndex = locateHeaderRow(csvRows);
    if (headerIndex < 0) {
      throw new Error('Required headers: Action, Current Variation Name, New Variation Name, Price, Stock, Image URL.');
    }
    const headers = csvRows[headerIndex].map((cell) => normalizeText(cell).toLowerCase());
    const column = (name) => headers.indexOf(name);
    const indexes = {
      action: column("action"), current: column("current variation name"), next: column("new variation name"),
      price: column("price"), stock: column("stock"), image: column("image url"),
    };
    const rawRows = csvRows.slice(headerIndex + 1).map((row, offset) => ({ row, sourceRow: headerIndex + offset + 2 }));
    const meaningful = rawRows.filter(({ row }) => {
      const action = normalizeText(row[indexes.action]).toUpperCase() || "KEEP";
      const other = [indexes.current, indexes.next, indexes.price, indexes.stock, indexes.image]
        .some((index) => normalizeText(row[index]) !== "");
      return other || action !== "KEEP";
    });
    if (meaningful.length > MAX_VARIATIONS) {
      throw new Error(`The file contains ${meaningful.length} used rows. Maximum is ${MAX_VARIATIONS}.`);
    }

    const seenCurrent = new Set();
    const seenTargets = new Set();
    return meaningful.map(({ row, sourceRow }) => {
      const action = normalizeText(row[indexes.action]).toUpperCase() || "KEEP";
      const currentName = normalizeText(row[indexes.current]);
      const newName = normalizeText(row[indexes.next]);
      const priceText = normalizeText(row[indexes.price]).replace(/^RM\s*/i, "");
      const stockText = normalizeText(row[indexes.stock]);
      const imageUrl = normalizeText(row[indexes.image]);
      const targetName = action === "ADD" ? newName : (newName || currentName);
      const errors = [];

      if (!["KEEP", "UPDATE", "ADD"].includes(action)) errors.push("Action must be KEEP, UPDATE, or ADD");
      if (currentName.length > 20) errors.push("Current name exceeds 20 characters");
      if (newName.length > 20) errors.push("New name exceeds 20 characters");
      if (action === "UPDATE" && !currentName) errors.push("UPDATE needs Current Variation Name");
      if (action === "ADD" && !newName) errors.push("ADD needs New Variation Name");

      if (action === "UPDATE" || action === "ADD") {
        if (priceText) {
          const price = Number(priceText);
          if (!Number.isFinite(price) || price <= 0) errors.push("Price must be greater than 0");
          else if (decimals(priceText) > 2) errors.push("Price can have at most 2 decimals");
        } else if (action === "ADD") errors.push("ADD needs Price");

        if (stockText) {
          const stock = Number(stockText);
          if (!Number.isInteger(stock) || stock < 0) errors.push("Stock must be a whole number of 0 or more");
        } else if (action === "ADD") errors.push("ADD needs Stock");

        if (imageUrl) {
          try {
            const url = new URL(imageUrl);
            if (!/^https?:$/.test(url.protocol)) errors.push("Image URL must start with http:// or https://");
          } catch { errors.push("Image URL is invalid"); }
        }

        if (currentName) {
          const key = nameKey(currentName);
          if (seenCurrent.has(key)) errors.push("Duplicate Current Variation Name");
          seenCurrent.add(key);
        }
        if (targetName) {
          const key = nameKey(targetName);
          if (seenTargets.has(key)) errors.push("Duplicate final variation name");
          seenTargets.add(key);
        }
      }

      return {
        sourceRow, action, currentName, newName, targetName,
        price: priceText && Number.isFinite(Number(priceText)) ? Number(priceText).toFixed(2) : priceText,
        stock: stockText, imageUrl, errors,
      };
    });
  }

  function getOptionRecords() {
    const inputs = document.querySelectorAll(".variation-option-panel .variation-input-item-container input[placeholder='Input']");
    const records = [];
    const seen = new Set();
    for (const input of inputs) {
      const name = normalizeText(input.value || input.getAttribute("modelvalue"));
      if (!name || seen.has(nameKey(name))) continue;
      seen.add(nameKey(name));
      records.push({ name, input, container: input.closest(".variation-input-item-container") });
    }
    return records.slice(0, MAX_VARIATIONS);
  }

  function getVariationOptionNames() {
    return getOptionRecords().map((record) => record.name);
  }

  function getPublicVariationRecords() {
    const candidates = [...document.querySelectorAll(PUBLIC_VARIATION_SELECTOR)];
    const records = [];
    const seen = new Set();
    for (const element of candidates) {
      const name = normalizeText(element.getAttribute("aria-label") || element.textContent);
      const key = nameKey(name);
      if (!name || seen.has(key)) continue;
      const classText = `${element.className || ""} ${element.parentElement?.className || ""}`;
      const selected = Boolean(
        element.getAttribute("aria-pressed") === "true" ||
        /(?:^|[\s_-])selected(?:$|[\s_-])/i.test(classText)
      );
      const disabled = Boolean(
        element.disabled ||
        element.getAttribute("aria-disabled") === "true" ||
        /(?:^|[\s_-])(disabled|sold-out|unavailable)(?:$|[\s_-])/i.test(classText) ||
        element.querySelector("[disabled],[aria-disabled='true'],[class*='disabled'],[class*='sold-out']")
      );
      seen.add(key);
      records.push({ name, disabled, selected, element });
    }
    return records.slice(0, MAX_VARIATIONS);
  }

  function findPublicVariationTrigger() {
    if (PAGE_MODE !== "public") return null;
    const candidates = document.querySelectorAll("button,[role='button'],[tabindex],div");
    for (const element of candidates) {
      const label = normalizeText(element.textContent || element.getAttribute("aria-label"));
      if (!/^\d+\s+variations?\s+available$/i.test(label)) continue;
      const nestedMatch = [...element.children].some((child) => /^\d+\s+variations?\s+available$/i.test(normalizeText(child.textContent)));
      if (!nestedMatch || element.matches("button,[role='button'],[tabindex]")) return element;
    }
    return null;
  }

  function autoOpenPublicVariationSelector(reason = "page scan") {
    if (PAGE_MODE !== "public" || getPublicVariationRecords().length) return false;
    const trigger = findPublicVariationTrigger();
    if (!trigger || state.openedPublicTriggers.has(trigger)) return false;
    state.openedPublicTriggers.add(trigger);
    trigger.click();
    log(`Automatically opened "${normalizeText(trigger.textContent)}" during ${reason}`);
    setTimeout(() => {
      if (!getPublicVariationRecords().length && trigger.isConnected) state.openedPublicTriggers.delete(trigger);
      scheduleScan();
    }, 1400);
    return true;
  }

  function findCurrentPublicStockText() {
    if (PAGE_MODE !== "public") return "";
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,div,span")];
    const quantityHeading = headings.find((element) =>
      /^quantity$/i.test(normalizeText(element.textContent)) &&
      ![...element.children].some((child) => /^quantity$/i.test(normalizeText(child.textContent)))
    );
    const quantityArea = quantityHeading?.closest("section") || quantityHeading?.parentElement;
    const scopedText = normalizeText(quantityArea?.innerText);
    const scopedMatch = scopedText.match(/\d+\s+pieces?\s+available\b/i);
    if (scopedMatch) return scopedMatch[0];
    const fallback = [...getPublicProductArea().querySelectorAll("*")].find((element) => {
      if (element.closest(`#${TOOL_ID}`)) return false;
      const text = normalizeText(element.textContent);
      if (!/^\d+\s+pieces?\s+available$/i.test(text)) return false;
      return ![...element.children].some((child) => /\d+\s+pieces?\s+available\b/i.test(normalizeText(child.textContent)));
    });
    return normalizeText(fallback?.textContent);
  }

  function currentPublicStockNumber() {
    const number = Number(findCurrentPublicStockText().match(/\d+/)?.[0]);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function getPublicProductArea() {
    const heading = document.querySelector("h1");
    const choice = document.querySelector(PUBLIC_VARIATION_SELECTOR);
    if (!heading || !choice) return document.querySelector("main") || document.body;
    let area = heading;
    while (area?.parentElement && !area.contains(choice)) area = area.parentElement;
    return area && area !== document.documentElement ? area : document.body;
  }

  function currentPublicPriceNumber() {
    if (PAGE_MODE !== "public") return null;
    const area = getPublicProductArea();
    const exactPrice = /^(?:RM|MYR)\s*([0-9][0-9,]*(?:\.\d{1,2})?)$/i;
    const firstChoice = area.querySelector(PUBLIC_VARIATION_SELECTOR);
    const candidates = [...area.querySelectorAll("*")].map((element) => {
      if (element.closest(`#${TOOL_ID}`)) return null;
      if (firstChoice && !(element.compareDocumentPosition(firstChoice) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
      const text = normalizeText(element.textContent);
      const match = text.match(exactPrice);
      if (!match) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || style.display === "none" || style.visibility === "hidden") return null;
      if (element.closest("s,del,strike") || /line-through/i.test(style.textDecorationLine || style.textDecoration || "")) return null;
      if ([...element.children].some((child) => exactPrice.test(normalizeText(child.textContent)))) return null;
      const value = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(value) || value <= 0) return null;
      const distanceFromHeading = Math.abs(rect.top - (area.querySelector("h1")?.getBoundingClientRect().bottom || 0));
      return { value, fontSize: Number.parseFloat(style.fontSize) || 0, distanceFromHeading };
    }).filter(Boolean).sort((left, right) => (right.fontSize - left.fontSize) || (left.distanceFromHeading - right.distanceFromHeading));
    return candidates[0]?.value ?? null;
  }

  async function waitForPublicSelectionToSettle(name, baselineSignature) {
    const started = Date.now();
    let selectedObserved = false;
    let previousSignature = "";
    let stableSamples = 0;
    while (Date.now() - started < 3200) {
      await sleep(180);
      const record = freshPublicRecord(name);
      if (record?.selected) selectedObserved = true;
      const stock = findCurrentPublicStockText();
      const price = currentPublicPriceNumber();
      const signature = `${stock}|${price ?? ""}`;
      stableSamples = signature === previousSignature ? stableSamples + 1 : 0;
      previousSignature = signature;
      const elapsed = Date.now() - started;
      const valuesChanged = signature !== baselineSignature;
      if (stableSamples >= 2 && ((selectedObserved && valuesChanged && elapsed >= 650) || elapsed >= 1800)) {
        return { quantity: currentPublicStockNumber(), price: currentPublicPriceNumber(), selectedObserved };
      }
    }
    return { quantity: currentPublicStockNumber(), price: currentPublicPriceNumber(), selectedObserved };
  }

  function freshPublicRecord(name) {
    const key = nameKey(name);
    return getPublicVariationRecords().find((record) => nameKey(record.name) === key) || null;
  }

  async function scanAllPublicStock() {
    if (PAGE_MODE !== "public") return true;
    if (state.publicScanPromise) return state.publicScanPromise;
    state.publicScanPromise = (async () => {
      state.publicScanning = true;
      state.publicScanCancelled = false;
      try {
        await ensureVariationListExpanded("public stock scan");
        const records = getPublicVariationRecords();
        if (!records.length) throw new Error("No public variation choices were detected. Reload the page and try again.");
        const originalSelected = records.find((record) => record.selected)?.name || "";
        log(`Starting public stock scan for ${records.length} variation(s)`);

        for (let index = 0; index < records.length; index += 1) {
          if (state.publicScanCancelled) {
            log("Public stock scan stopped by user");
            showMessage(`Stock scan stopped after ${state.publicScannedNames.size}/${records.length} variation(s).`, "error");
            return false;
          }
          const snapshot = records[index];
          const key = nameKey(snapshot.name);
          const record = freshPublicRecord(snapshot.name) || snapshot;
          showMessage(`Scanning stock ${index + 1}/${records.length}: ${snapshot.name}`, "normal");

          if (record.disabled) {
            state.publicStockByName.set(key, "0");
            state.publicPriceByName.delete(key);
            state.publicScannedNames.add(key);
            updateStatus();
            continue;
          }

          if (!record.element?.isConnected) {
            warn(`Could not click public variation: ${snapshot.name}`);
            state.publicScannedNames.add(key);
            updateStatus();
            continue;
          }

          const baselineSignature = `${findCurrentPublicStockText()}|${currentPublicPriceNumber() ?? ""}`;
          record.element.click();
          const settled = await waitForPublicSelectionToSettle(snapshot.name, baselineSignature);
          const quantity = settled.quantity;
          const price = settled.price;
          if (!settled.selectedObserved) warn(`Shopee selection state was not confirmed for "${snapshot.name}"; values were read after the timeout`);
          if (quantity !== null) {
            state.publicStockByName.set(key, String(quantity));
            log(`Public stock displayed for "${snapshot.name}": ${quantity}`);
          } else {
            state.publicStockByName.delete(key);
            log(`No exact public quantity displayed for "${snapshot.name}"`);
          }
          if (price !== null) {
            state.publicPriceByName.set(key, price.toFixed(2));
            log(`Public selling price displayed for "${snapshot.name}": ${price.toFixed(2)}`);
          } else {
            state.publicPriceByName.delete(key);
            log(`No exact public selling price detected for "${snapshot.name}"`);
          }
          state.publicScannedNames.add(key);
          updateStatus();
        }

        if (originalSelected) {
          const original = freshPublicRecord(originalSelected);
          if (original?.element?.isConnected && !original.disabled) {
            const baselineSignature = `${findCurrentPublicStockText()}|${currentPublicPriceNumber() ?? ""}`;
            original.element.click();
            await waitForPublicSelectionToSettle(originalSelected, baselineSignature);
          }
        }
        const exact = [...state.publicStockByName.values()].filter((value) => value !== "0").length;
        const prices = state.publicPriceByName.size;
        log(`Public scan finished. Exact displayed quantities: ${exact}; prices: ${prices}/${records.length}`);
        showMessage(`Scan complete: ${records.length} checked; ${exact} displayed quantities and ${prices} prices captured.`, "success");
        return true;
      } finally {
        state.publicScanning = false;
        state.publicScanPromise = null;
        updateStatus();
      }
    })();
    return state.publicScanPromise;
  }

  function stopPublicStockScan() {
    if (!state.publicScanning) {
      showMessage("No public stock scan is currently running.", "normal");
      return;
    }
    state.publicScanCancelled = true;
    showMessage("Stopping after the current variation…", "normal");
  }

  async function preparePublicExport(reason) {
    await ensureVariationListExpanded(reason);
    if (PAGE_MODE !== "public") return;
    const records = getPublicVariationRecords();
    const unscannedAvailable = records.some((record) => !record.disabled && !state.publicScannedNames.has(nameKey(record.name)));
    if (unscannedAvailable) {
      const completed = await scanAllPublicStock();
      if (!completed) throw new Error("Stock scan was stopped. Run Scan All Stock before exporting.");
    }
  }

  function getPublicProductTitle() {
    return normalizeText(document.querySelector("h1")?.textContent || document.title.replace(/\s*\|.*$/, ""));
  }

  function findPublicActionContainer() {
    if (PAGE_MODE !== "public") return null;
    const findAction = (pattern) => {
      const nodes = [...document.querySelectorAll("button,[role='button'],div,span")];
      const label = nodes.find((element) => pattern.test(normalizeText(element.textContent)) &&
        ![...element.children].some((child) => pattern.test(normalizeText(child.textContent))));
      return label?.closest("button,[role='button']") || label;
    };
    const addToCart = findAction(/^add to cart$/i);
    const buyNow = findAction(/^buy now$/i);
    if (!addToCart && !buyNow) return null;
    if (!addToCart || !buyNow) return (addToCart || buyNow)?.parentElement || null;
    let common = addToCart;
    while (common && !common.contains(buyNow)) common = common.parentElement;
    return common && common !== document.body ? common : addToCart.parentElement;
  }

  function exportFilenameStem() {
    const itemId = location.pathname.match(/-i\.\d+\.(\d+)/i)?.[1];
    return itemId ? `shopee-variations-${itemId}` : "shopee-variations";
  }

  function findViewAllButton() {
    if (PAGE_MODE !== "seller") return null;
    const buttons = document.querySelectorAll(
      ".variation-model-table-footer .show-more-button button, .variation-model-table-footer button"
    );
    return [...buttons].find((button) => /^view all\b/i.test(normalizeText(button.textContent))) || null;
  }

  function autoExpandVariationList(reason = "page scan") {
    const button = findViewAllButton();
    if (!button || button.disabled || state.expandedButtons.has(button)) return false;
    state.expandedButtons.add(button);
    const label = normalizeText(button.textContent);
    button.click();
    log(`Automatically clicked "${label}" during ${reason}`);
    setTimeout(() => {
      if (button.isConnected && /^view all\b/i.test(normalizeText(button.textContent))) {
        state.expandedButtons.delete(button);
      }
      scheduleScan();
    }, 1200);
    return true;
  }

  async function ensureVariationListExpanded(reason) {
    if (PAGE_MODE === "public") {
      if (!getPublicVariationRecords().length && autoOpenPublicVariationSelector(reason)) {
        showMessage("Opening Shopee's variation selector…", "normal");
        await sleep(1500);
        updateDetectedCache();
      }
      return;
    }
    if (findViewAllButton()) {
      autoExpandVariationList(reason);
      showMessage("Expanding the full variation list…", "normal");
      await sleep(1200);
      updateDetectedCache();
    }
  }

  function getNewOptionInput() {
    return document.querySelector(".variation-option-panel .virtual-options-item input[placeholder='Input']");
  }

  function directCellText(cell) {
    if (!cell) return "";
    const direct = [...cell.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => normalizeText(node.textContent)).filter(Boolean).join(" ");
    if (direct) return direct;
    const clone = cell.cloneNode(true);
    clone.querySelectorAll(".variation-image-manager,button,svg,img").forEach((element) => element.remove());
    return normalizeText(clone.textContent);
  }

  function modelId(element, prefix) {
    const id = element?.getAttribute("data-product-edit-field-unique-id") || "";
    return id.startsWith(prefix) ? id.slice(prefix.length) : "";
  }

  function getRenderedRows() {
    const table = document.querySelector(".variation-model-table");
    if (!table) return [];
    const bodies = [...table.querySelectorAll(".variation-model-table-body")];
    const namesBody = bodies.find((body) => body.querySelector(".first-variation-cell"));
    const valuesBody = bodies.find((body) => body.querySelector("[data-product-edit-field-unique-id^='priceModel_']"));
    if (!namesBody || !valuesBody) return [];
    const nameWrappers = [...namesBody.children].filter((child) => child.classList.contains("table-cell-wrapper"));
    const valueWrappers = [...valuesBody.children].filter((child) => child.classList.contains("table-cell-wrapper"));
    const count = Math.min(nameWrappers.length, valueWrappers.length);
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const nameWrapper = nameWrappers[index];
      const name = directCellText(nameWrapper.querySelector(".first-variation-cell"));
      const priceBox = valueWrappers[index].querySelector("[data-product-edit-field-unique-id^='priceModel_']");
      const stockBox = valueWrappers[index].querySelector("[data-product-edit-field-unique-id^='stockModel_']");
      const priceInput = priceBox?.querySelector("input");
      const stockInput = stockBox?.querySelector("input");
      if (!name || !priceInput || !stockInput) continue;
      rows.push({
        name, priceInput, stockInput,
        imageContainer: nameWrapper,
        imageInput: nameWrapper.querySelector(".variation-image-manager input[type='file']"),
        price: normalizeText(priceInput.value || priceInput.getAttribute("modelvalue")),
        stock: normalizeText(stockInput.value || stockInput.getAttribute("modelvalue")),
        paired: modelId(priceBox, "priceModel_") === modelId(stockBox, "stockModel_"),
      });
    }
    return rows;
  }

  function updateDetectedCache() {
    if (PAGE_MODE === "public") {
      const records = getPublicVariationRecords();
      const summary = `${records.length}/${records.filter((row) => row.disabled).length}`;
      if (summary !== state.lastDetectionLog) {
        state.lastDetectionLog = summary;
        log("Detected public variations / visibly out of stock:", summary);
      }
      updateStatus();
      return;
    }
    const renderedRows = getRenderedRows();
    for (const row of renderedRows) state.detectedByName.set(nameKey(row.name), { name: row.name, price: row.price, stock: row.stock });
    const summary = `${getVariationOptionNames().length}/${renderedRows.length}/${state.detectedByName.size}`;
    if (summary !== state.lastDetectionLog) {
      state.lastDetectionLog = summary;
      log("Detected variation names / rendered rows / cached rows:", summary);
    }
    updateStatus();
  }

  function setNativeInputValue(input, value) {
    if (!input || String(input.value) === String(value)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, String(value)); else input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function pageValidation() {
    const pageNames = getVariationOptionNames();
    const currentKeys = new Set(pageNames.map(nameKey));
    const errors = new Map();
    const addError = (row, message) => errors.set(row.sourceRow, [...(errors.get(row.sourceRow) || []), message]);
    const finalNames = [...pageNames];

    for (const row of state.importedRows.filter((item) => item.action === "UPDATE" && !item.errors.length)) {
      const index = finalNames.findIndex((name) => nameKey(name) === nameKey(row.currentName));
      if (!currentKeys.has(nameKey(row.currentName)) || index < 0) addError(row, "Current name not found in Shopee");
      else finalNames[index] = row.targetName;
    }
    for (const row of state.importedRows.filter((item) => item.action === "ADD" && !item.errors.length)) {
      if (finalNames.some((name) => nameKey(name) === nameKey(row.targetName))) addError(row, "ADD name already exists after updates");
      finalNames.push(row.targetName);
    }
    if (finalNames.length > MAX_VARIATIONS) {
      for (const row of state.importedRows.filter((item) => item.action === "ADD")) addError(row, `Final total would exceed ${MAX_VARIATIONS}`);
    }
    const counts = new Map();
    for (const name of finalNames) counts.set(nameKey(name), (counts.get(nameKey(name)) || 0) + 1);
    for (const row of state.importedRows.filter((item) => item.action !== "KEEP")) {
      if (row.targetName && counts.get(nameKey(row.targetName)) > 1) addError(row, "Final variation name would be duplicated");
    }
    return errors;
  }

  function fetchImageBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("Tampermonkey image permission is unavailable"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET", url, responseType: "blob", timeout: 30000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) { reject(new Error(`Image returned HTTP ${response.status}`)); return; }
          const blob = response.response;
          const contentType = blob?.type || response.responseHeaders?.match(/content-type:\s*([^;\r\n]+)/i)?.[1] || "";
          if (!blob || !String(contentType).toLowerCase().startsWith("image/")) { reject(new Error("URL did not return an image")); return; }
          resolve(blob.type ? blob : new Blob([blob], { type: contentType }));
        },
        onerror: () => reject(new Error("Image download failed")),
        ontimeout: () => reject(new Error("Image download timed out")),
      });
    });
  }

  async function uploadImage(rendered, imported) {
    const key = nameKey(imported.targetName);
    if (!imported.imageUrl || state.appliedImages.has(key) || state.imageInFlight.has(key)) return;
    if (!rendered.imageInput) { warn(`Image input not found for "${rendered.name}". Scroll it into view and try again.`); return; }
    state.imageInFlight.add(key);
    try {
      log(`Downloading imported image for "${rendered.name}"`);
      const blob = await fetchImageBlob(imported.imageUrl);
      const subtype = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
      const file = new File([blob], `shopee-${Date.now()}.${subtype}`, { type: blob.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      rendered.imageInput.files = transfer.files;
      rendered.imageInput.dispatchEvent(new Event("input", { bubbles: true }));
      rendered.imageInput.dispatchEvent(new Event("change", { bubbles: true }));
      state.appliedImages.add(key);
      log(`Image sent to Shopee uploader for "${rendered.name}"`);
    } catch (error) {
      console.error(LOG_PREFIX, `Image failed for "${rendered.name}":`, error);
      showMessage(`Image failed for "${rendered.name}": ${error.message}`, "error");
    } finally {
      state.imageInFlight.delete(key);
      updateStatus();
    }
  }

  async function removeVariationImage(rendered, imported) {
    if (imported.action !== "UPDATE" || imported.imageUrl || !state.fillMode) return;
    const key = nameKey(imported.targetName);
    if (state.appliedImages.has(key) || state.imageInFlight.has(key)) return;
    const container = rendered.imageContainer;
    if (!container?.isConnected) return;
    const imageSelector = ".variation-image-manager .shopee-image-manager__image";
    const existing = container.querySelector(imageSelector);
    if (!existing) { state.appliedImages.add(key); return; }
    const item = existing.closest(".shopee-image-manager__itembox");
    const remove = item?.querySelector(".shopee-image-manager__icon--delete");
    if (!remove || remove.closest("[disabled],[aria-disabled='true']")) {
      state.fillMode = false;
      throw new Error(`Image removal control unavailable for "${rendered.name}"`);
    }
    state.imageInFlight.add(key);
    try {
      if (!state.fillMode) return;
      remove.click();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await sleep(150);
        if (!state.fillMode) return;
        const fresh = getRenderedRows().find((row) => nameKey(row.name) === key);
        if (fresh?.imageContainer?.isConnected && !fresh.imageContainer.querySelector(imageSelector)) {
          state.appliedImages.add(key);
          log(`Removed variation image for "${rendered.name}"`);
          return;
        }
      }
      state.fillMode = false;
      throw new Error(`Image removal was not confirmed for "${rendered.name}". Review the page before continuing`);
    } finally {
      state.imageInFlight.delete(key);
    }
  }

  async function fillRenderedRows() {
    if (!state.fillMode || !state.actionByTarget.size || state.filling) return;
    state.filling = true;
    try {
      for (const rendered of getRenderedRows()) {
        if (!state.fillMode) break;
        const imported = state.actionByTarget.get(nameKey(rendered.name));
        if (!imported || imported.errors.length) continue;
        if (imported.price) setNativeInputValue(rendered.priceInput, imported.price);
        if (imported.stock !== "") setNativeInputValue(rendered.stockInput, imported.stock);
        state.appliedFields.add(nameKey(imported.targetName));
        state.detectedByName.set(nameKey(rendered.name), { name: rendered.name, price: imported.price || rendered.price, stock: imported.stock !== "" ? imported.stock : rendered.stock });
        if (imported.imageUrl) await uploadImage(rendered, imported);
        else if (imported.action === "UPDATE") await removeVariationImage(rendered, imported);
      }
    } finally {
      state.filling = false;
      updateStatus();
    }
  }

  async function renameUpdates(actionRows) {
    const renames = actionRows.filter((row) => row.action === "UPDATE" && row.newName && normalizeText(row.newName) !== normalizeText(row.currentName));
    if (!renames.length) return;
    const used = new Set(getVariationOptionNames().map(nameKey));
    for (let index = 0; index < renames.length; index += 1) {
      const row = renames[index];
      const record = getOptionRecords().find((item) => nameKey(item.name) === nameKey(row.currentName));
      if (!record) throw new Error(`Could not find "${row.currentName}" while renaming`);
      let temporary = `SVT-${Date.now().toString(36).slice(-7)}-${index}`.slice(0, 20);
      while (used.has(nameKey(temporary))) temporary = `SVT-${Math.random().toString(36).slice(2, 12)}`.slice(0, 20);
      row.temporaryName = temporary;
      setNativeInputValue(record.input, temporary);
      used.add(nameKey(temporary));
      await sleep(180);
    }
    for (const row of renames) {
      const record = getOptionRecords().find((item) => nameKey(item.name) === nameKey(row.temporaryName));
      if (!record) throw new Error(`Shopee did not accept temporary rename for "${row.currentName}"`);
      setNativeInputValue(record.input, row.newName);
      await sleep(220);
      delete row.temporaryName;
    }
    log(`Renamed ${renames.length} variation(s)`);
  }

  async function addVariations(actionRows) {
    const additions = actionRows.filter((row) => row.action === "ADD");
    for (const row of additions) {
      const before = getVariationOptionNames().length;
      const input = getNewOptionInput();
      if (!input) throw new Error(`Shopee's Add Variation input was not found for "${row.targetName}"`);
      setNativeInputValue(input, row.targetName);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      let accepted = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250);
        const names = getVariationOptionNames();
        if (names.some((name) => nameKey(name) === nameKey(row.targetName)) || names.length > before) { accepted = true; break; }
      }
      if (!accepted) throw new Error(`Shopee did not add "${row.targetName}"`);
      log(`Added variation "${row.targetName}"`);
    }
  }

  async function applyChanges() {
    if (state.applying) return;
    await ensureVariationListExpanded("Apply Changes");
    if (!state.importedRows.length) { showMessage("Import a CSV or Excel file first.", "error"); return; }
    const invalid = state.importedRows.filter((row) => row.errors.length);
    const pageErrors = pageValidation();
    if (invalid.length || pageErrors.size) {
      showMessage(`Cannot apply: ${invalid.length + pageErrors.size} row(s) need correction. Open Preview.`, "error");
      renderPreview();
      return;
    }
    const actions = state.importedRows.filter((row) => row.action === "UPDATE" || row.action === "ADD");
    if (!actions.length) { showMessage("Nothing to apply: every used row is KEEP.", "success"); return; }
    const updates = actions.filter((row) => row.action === "UPDATE").length;
    const adds = actions.filter((row) => row.action === "ADD").length;
    const images = actions.filter((row) => row.imageUrl).length;
    const removals = actions.filter((row) => row.action === "UPDATE" && !row.imageUrl).length;
    const confirmed = window.confirm(
      `Apply ${updates} UPDATE and ${adds} ADD action(s)?\n\n` +
      `${images} image(s) will be downloaded from the imported links and sent to Shopee as their rows appear.\n\n` +
      `Existing images will be removed for ${removals} UPDATE row(s) with blank Image URL.\n\n` +
      "The script will NOT click Shopee Save. Review everything and save manually."
    );
    if (!confirmed) { log("Apply cancelled by user"); return; }

    state.applying = true;
    state.fillMode = false;
    state.appliedFields.clear();
    state.appliedImages.clear();
    showMessage("Applying names and additions…", "normal");
    try {
      await renameUpdates(actions);
      await addVariations(actions);
      await sleep(1000);
      state.actionByTarget = new Map(actions.map((row) => [nameKey(row.targetName), row]));
      state.fillMode = true;
      await fillRenderedRows();
      log("Apply mode active. Scroll through the variation table to process all rows.");
      showMessage("Apply mode is active. Slowly scroll through the full variation table. Review all changes, then click Shopee Save manually.", "success");
      renderPreview();
    } catch (error) {
      console.error(LOG_PREFIX, "Apply failed:", error);
      state.fillMode = false;
      showMessage(`Apply stopped: ${error.message}. Review the page before saving.`, "error");
    } finally {
      state.applying = false;
      updateStatus();
    }
  }

  function stopApply() {
    state.fillMode = false;
    log(`Apply mode stopped. Fields: ${state.appliedFields.size}; images: ${state.appliedImages.size}`);
    showMessage("Apply mode stopped. Review the page before using Shopee Save.", "success");
    updateStatus();
  }

  function collectExportData() {
    updateDetectedCache();
    if (PAGE_MODE === "public") {
      const records = getPublicVariationRecords();
      if (!records.length) throw new Error("No public variation choices were detected. Open the 'Variations Available' selector once, then try export again.");
      const selectedQuantity = currentPublicStockNumber();
      const selectedPrice = currentPublicPriceNumber();
      const rows = records.map((record) => [
        "KEEP", record.name, "",
        record.disabled ? "" : state.publicPriceByName.get(nameKey(record.name)) ?? (record.selected && selectedPrice !== null ? selectedPrice.toFixed(2) : ""),
        record.disabled
          ? "0"
          : state.publicStockByName.get(nameKey(record.name)) ?? (record.selected && selectedQuantity !== null ? String(selectedQuantity) : ""),
        "",
      ]);
      return { rows, count: rows.length, outOfStock: records.filter((record) => record.disabled).length };
    }
    const optionNames = getVariationOptionNames();
    const names = optionNames.length ? optionNames : [...state.detectedByName.values()].map((row) => row.name);
    if (!names.length) throw new Error("No Shopee variations were detected on this page");
    const rows = names.map((name) => {
      const detected = state.detectedByName.get(nameKey(name));
      return ["KEEP", name, "", detected?.price ?? "", detected?.stock ?? "", ""];
    });
    return { rows, count: rows.length, outOfStock: rows.filter((row) => row[4] === "0").length };
  }

  function buildExportCsv() {
    const data = collectExportData();
    const lines = [["Action", "Current Variation Name", "New Variation Name", "Price", "Stock", "Image URL"], ...data.rows];
    return { csv: `\uFEFF${lines.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`, count: data.count, outOfStock: data.outOfStock };
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadText(filename, text, type) {
    downloadBlob(filename, new Blob([text], { type }));
  }

  async function exportCsv() {
    try {
      await preparePublicExport("CSV export");
      const { csv, count, outOfStock } = buildExportCsv();
      downloadText(`${exportFilenameStem()}-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv;charset=utf-8");
      log(`Exported ${count} variation(s). Existing images were intentionally not exported.`);
      showMessage(PAGE_MODE === "public"
        ? `Exported ${count} public variation(s) after scanning price and stock; ${outOfStock} unavailable choice(s) were marked Stock 0. Undisclosed values stay blank.`
        : `Exported ${count} variation(s). Image URL is blank by design. Scroll through the table first to capture more price/stock values.`, "success");
    } catch (error) { showMessage(error.message, "error"); }
  }

  async function copyCsv() {
    try {
      await preparePublicExport("Copy CSV");
      const { csv, count, outOfStock } = buildExportCsv();
      await navigator.clipboard.writeText(csv.replace(/^\uFEFF/, ""));
      log(`Copied ${count} variation(s) as CSV`);
      showMessage(PAGE_MODE === "public"
        ? `Copied ${count} scanned public variation(s) with detected prices and stock; ${outOfStock} unavailable choice(s) are Stock 0.`
        : `Copied ${count} variation(s) to the clipboard. Existing images were not copied.`, "success");
    } catch (error) { showMessage(`Copy failed: ${error.message}`, "error"); }
  }

  async function exportExcel() {
    try {
      await preparePublicExport("Excel export");
      if (typeof ExcelJS === "undefined") throw new Error("Excel support did not load. Check the internet connection and reload the page.");
      const { rows, count, outOfStock } = collectExportData();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Shopee Variation Tools";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet("Variations", { views: [{ state: "frozen", ySplit: 5 }] });
      sheet.properties.defaultRowHeight = 21;
      sheet.columns = [
        { key: "action", width: 13 }, { key: "current", width: 27 }, { key: "next", width: 27 },
        { key: "price", width: 13 }, { key: "stock", width: 13 }, { key: "image", width: 45 },
      ];
      sheet.mergeCells("A1:F1");
      sheet.getCell("A1").value = PAGE_MODE === "public" ? "Shopee Public Variation Export" : "Shopee Variation Import Template";
      sheet.getCell("A1").style = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEE4D2D" } }, font: { bold: true, color: { argb: "FFFFFFFF" }, size: 16 }, alignment: { horizontal: "center", vertical: "middle" } };
      sheet.getRow(1).height = 30;
      sheet.mergeCells("A2:F2");
      sheet.getCell("A2").value = PAGE_MODE === "public"
        ? `Public scan: current selling prices and displayed quantities were captured; ${outOfStock} unavailable choice(s) are Stock 0; undisclosed values remain blank.`
        : "Maximum 100 final variations. Action defaults to KEEP. The script never clicks Shopee Save.";
      sheet.getCell("A2").style = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3EF" } }, font: { italic: true, color: { argb: "FF7A2E1C" } }, alignment: { vertical: "middle" } };
      sheet.getRow(2).height = 24;
      sheet.getRow(3).values = ["KEEP, UPDATE, or ADD", "Existing name for UPDATE; max 20 characters", "Required for ADD; optional rename for UPDATE; max 20 characters", "ADD: required. UPDATE: blank keeps current. Greater than 0; max 2 decimals", "ADD: required. UPDATE: blank keeps current. Whole number; 0 or higher", "UPDATE: blank REMOVES existing image; URL uploads image. ADD: optional URL. KEEP: unchanged. Export leaves blank"];
      sheet.getRow(3).height = 70;
      sheet.getRow(3).eachCell((cell) => { cell.style = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF8F5" } }, font: { color: { argb: "FF6B4A42" }, size: 9 }, alignment: { wrapText: true, vertical: "middle" } }; });
      sheet.getRow(5).values = ["Action", "Current Variation Name", "New Variation Name", "Price", "Stock", "Image URL"];
      sheet.getRow(5).height = 30;
      sheet.getRow(5).eachCell((cell) => { cell.style = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF333333" } }, font: { bold: true, color: { argb: "FFFFFFFF" } }, alignment: { horizontal: "center", vertical: "middle", wrapText: true } }; });

      for (let index = 0; index < MAX_VARIATIONS; index += 1) {
        const rowNumber = index + 6;
        const values = rows[index] || ["KEEP", "", "", "", "", ""];
        const row = sheet.getRow(rowNumber);
        row.values = values;
        row.getCell(1).dataValidation = { type: "list", allowBlank: false, formulae: ['"KEEP,UPDATE,ADD"'], showErrorMessage: true, errorTitle: "Invalid action", error: "Choose KEEP, UPDATE, or ADD." };
        row.getCell(2).dataValidation = { type: "custom", allowBlank: true, formulae: [`AND(LEN(B${rowNumber})<=20,OR($A${rowNumber}<>"UPDATE",B${rowNumber}<>""))`], showErrorMessage: true, errorTitle: "Invalid current name", error: "UPDATE needs the existing name, maximum 20 characters." };
        row.getCell(3).dataValidation = { type: "custom", allowBlank: true, formulae: [`AND(LEN(C${rowNumber})<=20,OR($A${rowNumber}<>"ADD",C${rowNumber}<>""))`], showErrorMessage: true, errorTitle: "Invalid new name", error: "ADD needs a new name, maximum 20 characters." };
        row.getCell(4).dataValidation = { type: "custom", allowBlank: true, formulae: [`OR(AND($A${rowNumber}<>"ADD",D${rowNumber}=""),AND(ISNUMBER(D${rowNumber}),D${rowNumber}>0,ROUND(D${rowNumber},2)=D${rowNumber}))`], showErrorMessage: true, errorTitle: "Invalid price", error: "ADD needs a price. Price must be greater than 0 with at most 2 decimals." };
        row.getCell(5).dataValidation = { type: "custom", allowBlank: true, formulae: [`OR(AND($A${rowNumber}<>"ADD",E${rowNumber}=""),AND(ISNUMBER(E${rowNumber}),E${rowNumber}>=0,MOD(E${rowNumber},1)=0))`], showErrorMessage: true, errorTitle: "Invalid stock", error: "ADD needs stock. Stock must be a whole number of 0 or more." };
        row.getCell(4).numFmt = "0.00";
        row.getCell(5).numFmt = "0";
        row.eachCell({ includeEmpty: true }, (cell) => { cell.border = { bottom: { style: "thin", color: { argb: "FFE7E7E7" } } }; cell.alignment = { vertical: "middle" }; });
      }
      sheet.autoFilter = "A5:F105";
      const buffer = await workbook.xlsx.writeBuffer();
      downloadBlob(`${exportFilenameStem()}-${new Date().toISOString().slice(0, 10)}.xlsx`, new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      log(`Exported ${count} variation(s) to Excel with Action dropdowns`);
      showMessage(PAGE_MODE === "public"
        ? `Exported ${count} scanned public variation(s) to Excel; ${outOfStock} unavailable choice(s) were marked Stock 0.`
        : `Exported ${count} variation(s) to Excel. Edit and import the same .xlsx file—no CSV conversion needed.`, "success");
    } catch (error) {
      console.error(LOG_PREFIX, "Excel export failed:", error);
      showMessage(`Excel export failed: ${error.message}`, "error");
    }
  }

  function excelCellText(cell) {
    const value = cell?.value;
    if (value == null) return "";
    if (typeof value === "object") {
      if (value.result != null) return String(value.result);
      if (value.text != null) return String(value.text);
      if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    }
    return String(value);
  }

  function loadImportedRows(rows, sourceLabel) {
    state.importedRows = rows;
    state.actionByTarget.clear();
    state.appliedFields.clear();
    state.appliedImages.clear();
    state.fillMode = false;
    const invalid = rows.filter((row) => row.errors.length).length;
    const counts = Object.fromEntries(["KEEP", "UPDATE", "ADD"].map((action) => [action, rows.filter((row) => row.action === action).length]));
    log(`Imported ${sourceLabel}`, { rows: rows.length, invalid, ...counts });
    showMessage(`Imported ${rows.length} used row(s) from ${sourceLabel}: ${counts.KEEP} KEEP, ${counts.UPDATE} UPDATE, ${counts.ADD} ADD. ${invalid ? `${invalid} invalid.` : "File format is valid."}`, invalid ? "error" : "success");
    renderPreview();
    updateStatus();
  }

  async function importCsvFile(file) {
    const rows = validateImportedRows(parseCsv((await file.text()).replace(/^\uFEFF/, "")));
    loadImportedRows(rows, "CSV");
  }

  async function importExcelFile(file) {
    if (typeof ExcelJS === "undefined") throw new Error("Excel support did not load. Check the internet connection and reload the page.");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("The Excel file has no worksheet");
    const matrix = [];
    const lastRow = Math.max(sheet.rowCount, 5);
    for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
      const row = [];
      for (let column = 1; column <= 6; column += 1) row.push(excelCellText(sheet.getRow(rowNumber).getCell(column)));
      matrix.push(row);
    }
    loadImportedRows(validateImportedRows(matrix), "Excel");
  }

  function renderPreview() {
    const area = document.querySelector(`#${TOOL_ID} .svt-preview`);
    if (!area) return;
    area.replaceChildren();
    if (!state.importedRows.length) { area.hidden = true; return; }
    const pageErrors = pageValidation();
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Action</th><th>Current</th><th>New</th><th>Price</th><th>Stock</th><th>Image</th><th>Status</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const row of state.importedRows) {
      const errors = [...row.errors, ...(pageErrors.get(row.sourceRow) || [])];
      let status = "No change";
      if (row.action === "UPDATE" && !errors.length) status = "Ready to update";
      if (row.action === "ADD" && !errors.length) status = "Ready to add";
      if (errors.length) status = errors.join("; ");
      const tr = document.createElement("tr");
      if (errors.length) tr.className = "svt-row-error";
      for (const value of [row.action, row.currentName, row.newName, row.price, row.stock, row.action === "KEEP" ? "Keep image" : row.imageUrl ? "Upload URL" : row.action === "UPDATE" ? "REMOVE image" : "No image", status]) {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); area.append(table); area.hidden = false;
  }

  function showMessage(message, kind = "normal") {
    const element = document.querySelector(`#${TOOL_ID} .svt-message`);
    if (!element) return;
    element.textContent = message; element.dataset.kind = kind;
  }

  function updateStatus() {
    const element = document.querySelector(`#${TOOL_ID} .svt-status`);
    if (!element) return;
    if (PAGE_MODE === "public") {
      const records = getPublicVariationRecords();
      const selectedStock = findCurrentPublicStockText();
      const exactCount = [...state.publicStockByName.values()].filter((value) => value !== "0").length;
      element.textContent = `Public variations: ${records.length} | Out of stock: ${records.filter((row) => row.disabled).length} | Scanned: ${state.publicScannedNames.size}/${records.length} | Stock shown: ${exactCount} | Prices: ${state.publicPriceByName.size}${state.publicScanning ? " | SCANNING…" : ""}${selectedStock ? ` | Selected: ${selectedStock}` : ""}`;
      return;
    }
    const actionCount = state.importedRows.filter((row) => row.action === "UPDATE" || row.action === "ADD").length;
    element.textContent = `Shopee names: ${getVariationOptionNames().length} | Actions: ${actionCount} | Rows processed: ${state.appliedFields.size}/${actionCount} | Images: ${state.appliedImages.size} | Apply mode: ${state.fillMode ? "ON" : "OFF"}`;
  }

  function panelMarkup() {
    if (PAGE_MODE === "public") {
      return `
        <div class="svt-title">Shopee Public Variation Export <span>v${VERSION}</span></div>
        <div class="svt-product-title"></div>
        <div class="svt-actions">
          <button type="button" data-action="scan-stock" class="svt-primary">Scan Price &amp; Stock</button>
          <button type="button" data-action="stop-scan">Stop Scan</button>
          <button type="button" data-action="export-excel" class="svt-primary">Export Excel</button>
          <button type="button" data-action="export-csv">Export CSV</button>
          <button type="button" data-action="copy">Copy CSV</button>
        </div>
        <input class="svt-file" type="file" hidden>
        <div class="svt-status"></div>
        <div class="svt-message">Scan Price &amp; Stock selects each available variation in turn. The current selling price and displayed quantity are captured; unavailable choices become Stock 0.</div>`;
    }
    return `
      <div class="svt-title">Shopee Variation Tools <span>v${VERSION}</span></div>
      <div class="svt-actions">
        <button type="button" data-action="export-excel" class="svt-primary">Export Excel</button>
        <button type="button" data-action="export-csv">Export CSV</button>
        <button type="button" data-action="copy">Copy CSV</button>
        <button type="button" data-action="import">Import CSV/Excel</button>
        <button type="button" data-action="preview">Preview</button>
        <button type="button" data-action="apply" class="svt-primary">Apply Changes</button>
        <button type="button" data-action="stop">Stop</button>
      </div>
      <input class="svt-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      <div class="svt-status"></div>
      <div class="svt-message">UPDATE + blank Image URL REMOVES the existing image. KEEP leaves it unchanged. Excel and CSV are supported; deleting variations is not supported.</div>
      <div class="svt-preview" hidden></div>`;
  }

  function attachPanelEvents(panel) {
    const fileInput = panel.querySelector(".svt-file");
    panel.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "scan-stock") void scanAllPublicStock().catch((error) => {
        console.error(LOG_PREFIX, "Public stock scan failed:", error);
        showMessage(`Stock scan failed: ${error.message}`, "error");
      });
      if (action === "stop-scan") stopPublicStockScan();
      if (action === "export-excel") void exportExcel();
      if (action === "export-csv") void exportCsv();
      if (action === "copy") void copyCsv();
      if (action === "import") fileInput.click();
      if (action === "preview") renderPreview();
      if (action === "apply") void applyChanges();
      if (action === "stop") stopApply();
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        if (/\.xlsx$/i.test(file.name)) await importExcelFile(file);
        else if (/\.csv$/i.test(file.name)) await importCsvFile(file);
        else throw new Error("Choose a .csv or .xlsx file");
      }
      catch (error) { console.error(LOG_PREFIX, "File import failed:", error); showMessage(`Import failed: ${error.message}`, "error"); }
      finally { fileInput.value = ""; }
    });
  }

  function addStyles() {
    if (document.querySelector(`#${TOOL_ID}-styles`)) return;
    const style = document.createElement("style");
    style.id = `${TOOL_ID}-styles`;
    style.textContent = `
      #${TOOL_ID}{box-sizing:border-box;margin:16px 0;padding:14px;border:2px solid #ee4d2d;border-radius:8px;background:#fff;box-shadow:0 3px 12px rgba(0,0,0,.12);color:#222;font:14px/1.4 Arial,sans-serif;position:relative;z-index:1000}
      #${TOOL_ID}.svt-floating{position:fixed;right:18px;bottom:18px;width:680px;max-width:calc(100vw - 36px);max-height:72vh;overflow:auto;z-index:999999}
      #${TOOL_ID} .svt-title{font-size:17px;font-weight:700;color:#ee4d2d;margin-bottom:10px}
      #${TOOL_ID} .svt-title span{font-size:11px;color:#777;font-weight:400}
      #${TOOL_ID} .svt-product-title{margin:-4px 0 10px;color:#555;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${TOOL_ID} .svt-actions{display:flex;flex-wrap:wrap;gap:7px}
      #${TOOL_ID} button{border:1px solid #ee4d2d;border-radius:5px;background:#fff;color:#ee4d2d;padding:7px 11px;font-weight:600;cursor:pointer}
      #${TOOL_ID} button:hover{background:#fff3ef} #${TOOL_ID} button.svt-primary{background:#ee4d2d;color:#fff}
      #${TOOL_ID} .svt-status{margin-top:10px;padding:7px;background:#f6f6f6;border-radius:4px;font-size:12px}
      #${TOOL_ID} .svt-message{margin-top:8px;color:#555} #${TOOL_ID} .svt-message[data-kind="error"]{color:#b42318} #${TOOL_ID} .svt-message[data-kind="success"]{color:#067647}
      #${TOOL_ID} .svt-preview{margin-top:10px;max-height:330px;overflow:auto;border:1px solid #ddd}
      #${TOOL_ID} table{width:100%;border-collapse:collapse;font-size:12px} #${TOOL_ID} th{position:sticky;top:0;background:#333;color:#fff;text-align:left}
      #${TOOL_ID} th,#${TOOL_ID} td{padding:6px;border-bottom:1px solid #e8e8e8;vertical-align:top;white-space:normal} #${TOOL_ID} .svt-row-error{background:#fde8e7;color:#8a1c13}`;
    document.head.append(style);
  }

  function ensurePanel() {
    addStyles();
    let panel = document.getElementById(TOOL_ID);
    const publicActions = findPublicActionContainer();
    const anchor = PAGE_MODE === "seller" && (document.querySelector(".batch-edit-row[data-auto-scroll-key='multiModelStockScroll']") ||
      [...document.querySelectorAll(".edit-row")].find((element) => normalizeText(element.querySelector(".edit-label")?.textContent) === "Variation List"));
    if (!panel) {
      panel = document.createElement("section"); panel.id = TOOL_ID; panel.innerHTML = panelMarkup(); attachPanelEvents(panel);
      const productTitle = panel.querySelector(".svt-product-title");
      if (productTitle) productTitle.textContent = getPublicProductTitle();
    }
    if (publicActions?.parentElement) {
      panel.classList.remove("svt-floating");
      if (publicActions.nextElementSibling !== panel) publicActions.parentElement.insertBefore(panel, publicActions.nextSibling);
      if (state.lastPanelLocation !== "public-actions") {
        state.lastPanelLocation = "public-actions";
        log("Public export panel inserted below Add to Cart / Buy Now");
      }
    } else if (anchor?.parentElement) {
      panel.classList.remove("svt-floating");
      if (panel.nextElementSibling !== anchor) anchor.parentElement.insertBefore(panel, anchor);
      if (state.lastPanelLocation !== "variation-list") { state.lastPanelLocation = "variation-list"; log("Panel inserted above Shopee Variation List"); }
    } else if (!panel.isConnected) {
      panel.classList.add("svt-floating"); document.body.append(panel); state.lastPanelLocation = "floating";
      if (PAGE_MODE === "public") log("Public variation export panel shown at bottom-right");
      else warn("Variation List not found yet; showing fallback panel at bottom-right");
    }
    updateStatus();
  }

  function scheduleScan() {
    if (state.scheduled) return;
    state.scheduled = true;
    setTimeout(() => {
      state.scheduled = false;
      ensurePanel(); autoExpandVariationList(); autoOpenPublicVariationSelector(); updateDetectedCache(); void fillRenderedRows().catch((error) => {
        state.fillMode = false;
        console.error(LOG_PREFIX, error);
        showMessage(`Apply stopped: ${error.message}`, "error");
      });
    }, 180);
  }

  ensurePanel();
  autoExpandVariationList("initial page load");
  autoOpenPublicVariationSelector("initial page load");
  updateDetectedCache();
  state.observer = new MutationObserver(scheduleScan);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("scroll", scheduleScan, true);
  log("DOM observer installed; script is running. Open DevTools Console to see these logs.");
})();
