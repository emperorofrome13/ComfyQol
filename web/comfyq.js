import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const state = {
  info: null,
  panel: null,
  downloads: new Map(),
};

const MODEL_WIDGET_FOLDERS = {
  ckpt_name: "checkpoints",
  unet_name: "diffusion_models",
  vae_name: "vae",
  lora_name: "loras",
  control_net_name: "controlnet",
  controlnet_name: "controlnet",
  upscale_model_name: "upscale_models",
  clip_vision_name: "clip_vision",
  style_model_name: "style_models",
};

const FOLDER_ICON_SIZE = 18;
const FOLDER_ICON_MARGIN = 8;
const PANEL_POSITION_KEY = "comfyQ.panelPosition";
const ADVANCED_OPEN_KEY = "comfyQ.advancedOpen";
const LAUNCHER_POSITION_KEY = "comfyQ.launcherPosition";
const DRAG_THRESHOLD = 4;
const DASHBOARD_POSITION_KEY = "comfyQ.dashboardPosition";
const DASHBOARD_SIZE_KEY = "comfyQ.dashboardSize";
const DASHBOARD_OPEN_KEY = "comfyQ.dashboardOpen";
const DASHBOARD_COLLAPSED_KEY = "comfyQ.dashboardCollapsed";
const OUTPUTS_POSITION_KEY = "comfyQ.outputsPosition";
const OUTPUTS_SIZE_KEY = "comfyQ.outputsSize";
const OUTPUT_MANAGER_KEY = "comfyQ.outputManager";
const OUTPUT_PAGE = 120;

function $(selector, root = document) {
  return root.querySelector(selector);
}

function setElementPosition(element, key, left, top, save = true) {
  const bounds = element.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - bounds.width);
  const maxTop = Math.max(0, window.innerHeight - bounds.height);
  const position = {
    left: Math.min(maxLeft, Math.max(0, left)),
    top: Math.min(maxTop, Math.max(0, top)),
  };
  element.style.left = `${position.left}px`;
  element.style.top = `${position.top}px`;
  element.style.right = "auto";
  element.style.bottom = "auto";
  if (save) {
    try { localStorage.setItem(key, JSON.stringify(position)); } catch {}
  }
}

function restoreElementPosition(element, key) {
  try {
    const position = JSON.parse(localStorage.getItem(key) || "null");
    if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
      setElementPosition(element, key, position.left, position.top, false);
    }
  } catch {}
}

// Drag `element` by `handle` (pointer or arrow keys) and remember where it was left.
// A press that moves less than DRAG_THRESHOLD stays a normal click, so the launcher still opens the panel.
function makeMovable(element, handle, key) {
  handle.tabIndex = 0;
  handle.addEventListener("keydown", (event) => {
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    const step = event.shiftKey ? 48 : 16;
    setElementPosition(
      element,
      key,
      bounds.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      bounds.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
    );
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target !== handle && event.target.closest("button"))) return;
    const bounds = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const onMove = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      const dx = pointerEvent.clientX - startX;
      const dy = pointerEvent.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        handle.classList.add("dragging");
      }
      setElementPosition(element, key, bounds.left + dx, bounds.top + dy, false);
    };
    const onEnd = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (!dragging) return;
      handle.classList.remove("dragging");
      const end = element.getBoundingClientRect();
      setElementPosition(element, key, end.left, end.top);
      // Swallow the click that follows a drag.
      handle.addEventListener("click", (click) => { click.stopImmediatePropagation(); click.preventDefault(); }, { capture: true, once: true });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  });
}

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function rememberSize(element, key) {
  const size = readStorage(key, null);
  if (size) Object.assign(element.style, { width: `${size.width}px`, height: `${size.height}px` });
  new ResizeObserver(() => {
    if (element.classList.contains("open")) writeStorage(key, { width: element.offsetWidth, height: element.offsetHeight });
  }).observe(element);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

async function comfyQFetch(path, options = {}) {
  const response = await api.fetchApi(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

function toast(message, isError = false) {
  const toasts = app.extensionManager?.toast;
  if (toasts?.add) {
    toasts.add({ severity: isError ? "error" : "success", summary: "comfyQol", detail: message, life: isError ? 8000 : 4000 });
  } else if (app.ui?.dialog?.show) {
    app.ui.dialog.show(message);
  } else {
    console[isError ? "error" : "log"](`[comfyQol] ${message}`);
  }
}

async function loadInfo(force = false) {
  if (!state.info || force) state.info = await comfyQFetch("/comfyq/info");
  return state.info;
}

async function openFolder(payload) {
  const result = await comfyQFetch("/comfyq/open-folder", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  toast(`Opened: ${result.path}`);
}

function inferFolderFromNode(node) {
  const haystack = `${node?.type || ""} ${node?.title || ""} ${node?.constructor?.comfyClass || ""}`.toLowerCase();
  if (haystack.includes("lora")) return "loras";
  if (haystack.includes("vae")) return "vae";
  if (haystack.includes("control")) return "controlnet";
  if (haystack.includes("upscale")) return "upscale_models";
  if (haystack.includes("clip") || haystack.includes("text encoder")) return "text_encoders";
  if (haystack.includes("unet") || haystack.includes("diffusion")) return "diffusion_models";
  return "checkpoints";
}

function folderForWidget(node, widget) {
  const name = widget?.name || "";
  if (MODEL_WIDGET_FOLDERS[name]) return MODEL_WIDGET_FOLDERS[name];
  if (/^clip_name\d*$/.test(name)) {
    return node?.constructor?.comfyClass === "CLIPVisionLoader" ? "clip_vision" : "text_encoders";
  }
  if (/^vae_name\d*$/.test(name)) return "vae";
  if (/^unet_name\d*$/.test(name)) return "diffusion_models";
  return null;
}

function widgetLooksLikeModel(widget) {
  if (!widget || typeof widget.value !== "string") return false;
  const value = widget.value.trim();
  if (!value || value === "undefined" || value === "null") return false;
  return /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft|pkl)$/i.test(value);
}

function getModelWidgets(node) {
  return (node?.widgets || []).filter((widget) => widgetLooksLikeModel(widget) || folderForWidget(node, widget));
}

function getFolderWidgets(node) {
  return (node?.widgets || [])
    .map((widget) => ({ widget, folder: folderForWidget(node, widget) }))
    .filter((entry) => entry.folder);
}

function isSubgraphNode(node) {
  if (typeof node.isSubgraphNode === "function") return node.isSubgraphNode();
  return node.isSubgraphNode === true || Boolean(node.subgraph);
}

// Model widgets on the node itself (including promoted subgraph widgets) and on every node nested inside it.
function getModelEntries(node) {
  const entries = [];
  const seen = new Set();
  const visit = (current) => {
    for (const widget of getModelWidgets(current)) {
      const folder = folderForWidget(current, widget) || inferFolderFromNode(current);
      const key = `${folder}|${widget.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ widget, folder });
    }
    if (isSubgraphNode(current)) (current.subgraph?.nodes || []).forEach(visit);
  };
  visit(node);
  return entries;
}

async function openModelFoldersForNode(node) {
  const entries = getModelEntries(node);
  if (!entries.length) {
    toast("No model-looking widgets found on this node.", true);
    return;
  }
  for (const { widget, folder } of entries) {
    await openFolder({ folder, filename: widget.value });
  }
}

async function openWidgetFolder(node, widget, folder) {
  await openFolder({
    folder,
    filename: typeof widget.value === "string" ? widget.value : undefined,
  });
}

function widgetIsMissing(widget) {
  const values = widget.options?.values;
  return Array.isArray(values) && typeof widget.value === "string" && widget.value !== "" && !values.includes(widget.value);
}

function workflowNodes() {
  const graph = app.graph?.rootGraph || app.graph;
  if (!graph) return [];
  return [...graph._nodes, ...[...(graph.subgraphs?.values() || [])].flatMap((subgraph) => subgraph.nodes || [])];
}

// Workflows (including the built-in templates) list download links per loader in node.properties.models.
function modelSources() {
  const sources = new Map();
  for (const node of workflowNodes()) {
    for (const model of node.properties?.models || []) {
      if (model?.name && model.url) sources.set(model.name, model);
    }
  }
  return sources;
}

function missingModel(widget, folder, sources) {
  if (!widgetIsMissing(widget)) return null;
  const source = sources.get(widget.value) || sources.get(widget.value.split(/[\\/]/).pop());
  return { name: widget.value, folder: source?.directory || folder, url: source?.url || "" };
}

function findMissingModels() {
  const sources = modelSources();
  const missing = new Map();
  for (const node of workflowNodes()) {
    for (const widget of getModelWidgets(node)) {
      const entry = missingModel(widget, folderForWidget(node, widget) || inferFolderFromNode(node), sources);
      if (entry && !missing.has(`${entry.folder}|${entry.name}`)) missing.set(`${entry.folder}|${entry.name}`, entry);
    }
  }
  return [...missing.values()];
}

function missingModelsForNode(node) {
  const sources = modelSources();
  return getModelEntries(node).map(({ widget, folder }) => missingModel(widget, folder, sources)).filter(Boolean);
}

function activeJobFor(entry) {
  return [...state.downloads.values()].find((job) => job.url === entry.url && ["queued", "downloading"].includes(job.status));
}

// Starts the download when the workflow knows the URL; otherwise opens the panel with everything but the URL filled in.
async function downloadModel(entry) {
  const parts = entry.name.split(/[\\/]/);
  const filename = parts.pop();
  const subfolder = parts.join("/");
  if (!entry.url) {
    await togglePanel({ folder: entry.folder, filename, subfolder, needUrl: entry.name });
    return;
  }
  await togglePanel();
  if (activeJobFor(entry)) return;
  await startJob({ folder: entry.folder, subfolder, url: entry.url, filename });
}

function downloadModels(entries) {
  return entries.reduce((chain, entry) => chain.then(() => downloadModel(entry)), Promise.resolve())
    .catch((error) => setPanelStatus(error.message, true));
}

function drawDownloadGlyph(ctx, x, y, size) {
  ctx.save();
  ctx.fillStyle = "#2f8f5f";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y + 3);
  ctx.lineTo(x + size / 2, y + size - 6);
  ctx.moveTo(x + size / 2 - 4, y + size - 9);
  ctx.lineTo(x + size / 2, y + size - 5);
  ctx.lineTo(x + size / 2 + 4, y + size - 9);
  ctx.moveTo(x + 4, y + size - 3);
  ctx.lineTo(x + size - 4, y + size - 3);
  ctx.stroke();
  ctx.restore();
}

function drawFolderGlyph(ctx, x, y, size, active = false) {
  const tabHeight = Math.max(4, Math.round(size * 0.28));
  const radius = 3;
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = active ? "#ffffff" : "#d9d4b0";
  ctx.fillStyle = active ? "#b5862e" : "#8c6b2f";
  ctx.beginPath();
  ctx.roundRect(x, y + tabHeight, size, size - tabHeight, radius);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 2, y + tabHeight + 1);
  ctx.lineTo(x + 2, y + 3);
  ctx.lineTo(x + size * 0.42, y + 3);
  ctx.lineTo(x + size * 0.55, y + tabHeight + 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function pointInRect(pos, rect) {
  return pos?.[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
}

// Canvas (classic LiteGraph) rendering. Installed on every node because subgraph nodes
// gain their promoted model widgets after nodeCreated.
function installFolderIcons(node) {
  if (!node || node.__comfyqFolderIconsInstalled) return;
  node.__comfyqFolderIconsInstalled = true;

  const originalDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function comfyQDrawFolderIcons(ctx, ...args) {
    // Reserve space outside the combo's draw and click bounds for its folder icon.
    const widgets = getFolderWidgets(this);
    for (const { widget } of widgets) {
      const icons = widgetIsMissing(widget) ? 2 : 1;
      widget.width = Math.max(60, this.size[0] - icons * (FOLDER_ICON_SIZE + 4) - 6);
    }
    originalDrawForeground?.apply(this, [ctx, ...args]);
    this.__comfyqFolderIconRects = [];
    if (this.flags?.collapsed) return;

    for (const { widget, folder } of widgets) {
      if (widget.hidden || widget.type === "hidden" || typeof widget.y !== "number") continue;
      const height = widget.computedHeight || widget.computeSize?.(this.size[0])?.[1] || 20;
      const x = Math.max(6, this.size[0] - FOLDER_ICON_SIZE - FOLDER_ICON_MARGIN);
      const y = widget.y + Math.max(1, (height - FOLDER_ICON_SIZE) / 2);
      this.__comfyqFolderIconRects.push({ x, y, w: FOLDER_ICON_SIZE, h: FOLDER_ICON_SIZE, widget, folder, action: "open" });
      drawFolderGlyph(ctx, x, y, FOLDER_ICON_SIZE, false);
      if (widgetIsMissing(widget)) {
        const dx = x - FOLDER_ICON_SIZE - 4;
        this.__comfyqFolderIconRects.push({ x: dx, y, w: FOLDER_ICON_SIZE, h: FOLDER_ICON_SIZE, widget, folder, action: "download" });
        drawDownloadGlyph(ctx, dx, y, FOLDER_ICON_SIZE);
      }
    }
  };

  const originalMouseDown = node.onMouseDown;
  node.onMouseDown = function comfyQFolderIconMouseDown(event, pos, ...args) {
    const rects = this.__comfyqFolderIconRects || [];
    const hit = rects.find((rect) => pointInRect(pos, rect));
    if (hit) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const run = hit.action === "download"
        ? downloadModels([missingModel(hit.widget, hit.folder, modelSources())].filter(Boolean))
        : openWidgetFolder(this, hit.widget, hit.folder);
      run.catch((error) => toast(error.message, true));
      return true;
    }
    return originalMouseDown?.apply(this, [event, pos, ...args]);
  };
}

const DOWNLOAD_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="#2f8f5f"/><path d="M8 3v7M4.5 7 8 10.5 11.5 7M4 13h8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const FOLDER_SVG = `<svg viewBox="0 0 16 14" width="14" height="12" aria-hidden="true"><path d="M1 3V1.5h5l1.5 1.5H15v10H1z" fill="#8c6b2f" stroke="#d9d4b0" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

// Vue node rendering (Nodes 2.0) draws widgets as DOM, so the canvas icons never appear there.
// Prepend a folder button to each model widget label; Vue may re-render labels, so this re-runs on DOM changes.
function syncVueFolderIcons() {
  const graph = app.canvas?.graph;
  if (!graph) return;
  for (const labelEl of document.querySelectorAll('.lg-node [data-testid="widget-layout-field-label"]')) {
    const node = graph.getNodeById(labelEl.closest("[data-node-id]")?.dataset.nodeId);
    const label = labelEl.textContent.trim();
    const widget = node?.widgets?.find((w) => (w.label || w.name) === label);
    const folder = widget && folderForWidget(node, widget);
    if (!folder) continue;
    const downloadButton = labelEl.querySelector(".comfyq-vue-download");
    if (widgetIsMissing(widget) && !downloadButton) {
      labelEl.prepend(
        el("button", {
          class: "comfyq-vue-download",
          title: `comfyQol: download missing ${widget.value} into ${folder}`,
          html: DOWNLOAD_SVG,
          onpointerdown: (event) => event.stopPropagation(),
          onclick: (event) => {
            event.stopPropagation();
            downloadModels([missingModel(widget, folder, modelSources())].filter(Boolean));
          },
        }),
      );
    } else if (!widgetIsMissing(widget) && downloadButton) {
      downloadButton.remove();
    }
    if (labelEl.querySelector(".comfyq-vue-folder")) continue;
    labelEl.prepend(
      el("button", {
        class: "comfyq-vue-folder",
        title: `comfyQol: open ${folder} folder`,
        html: FOLDER_SVG,
        onpointerdown: (event) => event.stopPropagation(),
        onclick: (event) => {
          event.stopPropagation();
          openWidgetFolder(node, widget, folder).catch((error) => toast(error.message, true));
        },
      }),
    );
  }
}

function watchVueNodes() {
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      syncVueFolderIcons();
    });
  }).observe(document.body, { childList: true, subtree: true });
  syncVueFolderIcons();
}

function rootGraphForEdit() {
  const graph = app.graph?.rootGraph || app.graph;
  if (graph && app.canvas?.graph !== graph) app.canvas?.setGraph(graph);
  return graph;
}

// Flatten every subgraph (including nested ones) back into the root workflow, keeping all nodes and links.
function unpackAllSubgraphs() {
  const graph = rootGraphForEdit();
  if (!graph) return;
  const failed = new Set();
  let unpacked = 0;
  graph.beforeChange?.();
  let candidates;
  while ((candidates = graph._nodes.filter((node) => isSubgraphNode(node) && !failed.has(node))).length) {
    for (const node of candidates) {
      graph.unpackSubgraph(node);
      if (graph._nodes.includes(node)) failed.add(node);
      else unpacked += 1;
    }
  }
  graph.setDirtyCanvas(true, true);
  graph.afterChange?.();
  toast(failed.size
    ? `Unpacked ${unpacked} subgraph(s); ${failed.size} could not be unpacked (missing node types?).`
    : `Unpacked ${unpacked} subgraph(s).`);
}

function removeAllSubgraphs() {
  const graph = rootGraphForEdit();
  if (!graph) return;
  const candidates = graph._nodes.filter(isSubgraphNode);

  graph.beforeChange?.();
  for (const node of candidates) graph.remove(node);

  let definitionCount = 0;
  if (graph.subgraphs instanceof Map) {
    definitionCount += graph.subgraphs.size;
    graph.subgraphs.clear();
  }
  if (graph.extra?.groupNodes && typeof graph.extra.groupNodes === "object") {
    definitionCount = Object.keys(graph.extra.groupNodes).length;
    graph.extra.groupNodes = {};
  }
  if (graph.extra?.subgraphs && typeof graph.extra.subgraphs === "object") {
    definitionCount += Object.keys(graph.extra.subgraphs).length;
    graph.extra.subgraphs = {};
  }

  graph.setDirtyCanvas(true, true);
  graph.afterChange?.();
  toast(`Removed ${candidates.length} subgraph node(s) and ${definitionCount} embedded definition(s).`);
}

function selectedModelNames() {
  const selected = Object.values(app.canvas?.selected_nodes || {});
  return [...new Set(selected.flatMap((node) => getModelEntries(node).map(({ widget }) => widget.value)))];
}

async function copySelectedModelNames() {
  const names = selectedModelNames();
  if (!names.length) {
    toast("Select one or more model loader nodes first.", true);
    return;
  }
  await navigator.clipboard.writeText(names.join("\n"));
  toast(`Copied ${names.length} model name(s).`);
}

function ensurePanel() {
  if (state.panel) return state.panel;

  const folderSelect = el("select", { class: "comfyq-select" });
  const pathSelect = el("select", { class: "comfyq-select" });
  const urlInput = el("input", {
    class: "comfyq-input",
    placeholder: "https://.../model.safetensors",
  });
  const filenameInput = el("input", {
    class: "comfyq-input",
    placeholder: "optional filename",
  });
  const subfolderInput = el("input", {
    class: "comfyq-input",
    placeholder: "optional subfolder",
  });
  const status = el("div", { class: "comfyq-status" });
  const downloads = el("div", { class: "comfyq-downloads" });
  const missingSection = el("div", { class: "comfyq-missing" });
  state.downloadsEl = downloads;
  state.missingEl = missingSection;

  function refreshPathOptions() {
    const folder = state.info?.model_folders?.find((item) => item.name === folderSelect.value);
    pathSelect.replaceChildren();
    for (const [index, path] of (folder?.folders || []).entries()) {
      pathSelect.append(el("option", { value: index, text: `${index}: ${path}` }));
    }
  }

  async function refreshInfo() {
    await loadInfo(true);
    const previous = folderSelect.value;
    folderSelect.replaceChildren();
    for (const folder of state.info.model_folders) {
      folderSelect.append(el("option", { value: folder.name, text: folder.name }));
    }
    folderSelect.value = previous || "checkpoints";
    refreshPathOptions();
  }

  async function startDownload() {
    try {
      await startJob({
        folder: folderSelect.value,
        path_index: Number(pathSelect.value || 0),
        subfolder: subfolderInput.value.trim(),
        url: urlInput.value.trim(),
        filename: filenameInput.value.trim(),
      });
      urlInput.classList.remove("comfyq-needs-url");
    } catch (error) {
      setPanelStatus(error.message, true);
    }
  }

  const outputToggle = el("input", { type: "checkbox" });
  outputToggle.checked = outputManagerEnabled();
  outputToggle.addEventListener("change", () => setOutputManager(outputToggle.checked));
  state.outputsButton = el("button", { text: "Outputs", title: "Browse, download and save output images", onclick: () => toggleOutputs(true) });
  state.outputsButton.hidden = !outputManagerEnabled();
  state.vramEl = el("span", { class: "comfyq-muted comfyq-vram" });
  const tools = el("div", { class: "comfyq-row" }, [
    el("button", { text: "Dashboard", title: "Prompt, model and sampler controls in one window", onclick: () => toggleDashboard(true) }),
    state.outputsButton,
    el("span", { class: "comfyq-spacer" }),
    state.vramEl,
    el("button", { text: "Free VRAM", title: "Unload all models and clear ComfyUI's cache", onclick: () => freeVram().catch((error) => toast(error.message, true)) }),
  ]);

  const advanced = el("details", { class: "comfyq-advanced" }, [
    el("summary", { text: "Advanced" }),
    el("div", { class: "comfyq-advanced-body" }, [
      el("label", { class: "comfyq-check" }, [outputToggle, "Output manager: gallery with multi-file download, and Save As when you right-click an output image"]),
      el("label", { text: "Open folder" }),
      el("div", { class: "comfyq-row" }, [
        el("button", { text: "Input", onclick: () => openFolder({ special: "input" }) }),
        el("button", { text: "Output", onclick: () => openFolder({ special: "output" }) }),
        el("button", { text: "Custom Nodes", onclick: () => openFolder({ special: "custom_nodes" }) }),
      ]),
      el("label", { text: "Model folder" }),
      folderSelect,
      pathSelect,
      el("div", { class: "comfyq-row" }, [
        el("button", { text: "Open Folder", onclick: () => openFolder({ folder: folderSelect.value, path_index: Number(pathSelect.value || 0) }) }),
        el("button", { text: "Refresh Models", onclick: () => refreshComfyModels().catch((error) => setPanelStatus(error.message, true)) }),
      ]),
      el("label", { text: "Download from a URL into the model folder above" }),
      urlInput,
      filenameInput,
      subfolderInput,
      el("button", { class: "comfyq-primary", text: "Download to Selected Folder", onclick: startDownload }),
      el("label", { text: "Workflow" }),
      el("div", { class: "comfyq-row" }, [
        el("button", { text: "Unpack Subgraphs", title: "Flatten all subgraphs into the workflow, keeping their nodes", onclick: unpackAllSubgraphs }),
        el("button", { text: "Remove Subgraphs", title: "Delete subgraph nodes and their contents", onclick: removeAllSubgraphs }),
      ]),
      el("button", { text: "Copy Selected Models", onclick: copySelectedModelNames }),
    ]),
  ]);
  try { advanced.open = localStorage.getItem(ADVANCED_OPEN_KEY) === "true"; } catch {}
  advanced.addEventListener("toggle", () => {
    try { localStorage.setItem(ADVANCED_OPEN_KEY, String(advanced.open)); } catch {}
  });

  const panel = el("div", { class: "comfyq-panel" }, [
    el("div", { class: "comfyq-header" }, [
      el("strong", { text: "comfyQol" }),
      el("button", { class: "comfyq-icon", title: "Close", text: "x", onclick: () => panel.classList.remove("open") }),
    ]),
    tools,
    missingSection,
    downloads,
    status,
    advanced,
  ]);

  const header = $(".comfyq-header", panel);
  header.title = "Drag to move comfyQol; use arrow keys when focused";
  header.setAttribute("aria-label", "Move comfyQol panel");
  makeMovable(panel, header, PANEL_POSITION_KEY);
  folderSelect.addEventListener("change", refreshPathOptions);
  document.body.append(panel);
  state.panel = panel;
  renderDownloads();
  refreshInfo().catch((error) => setPanelStatus(error.message, true));
  return panel;
}

async function togglePanel(prefill = {}) {
  await loadInfo();
  const panel = ensurePanel();
  panel.classList.toggle("open", true);
  restoreElementPosition(panel, PANEL_POSITION_KEY);
  if (prefill.folder) {
    const select = $(".comfyq-select", panel);
    // Populate first: opening from a node can precede the panel's initial refresh.
    if (!select.options.length) {
      for (const folder of state.info.model_folders) {
        select.append(el("option", { value: folder.name, text: folder.name }));
      }
    }
    select.value = prefill.folder;
    select.dispatchEvent(new Event("change"));
  }
  const [urlInput, filenameInput, subfolderInput] = panel.querySelectorAll(".comfyq-input");
  if (prefill.filename) filenameInput.value = prefill.filename;
  if (prefill.subfolder !== undefined) subfolderInput.value = prefill.subfolder;
  urlInput.classList.toggle("comfyq-needs-url", Boolean(prefill.needUrl));
  urlInput.placeholder = prefill.needUrl ? `Paste a download URL for ${prefill.needUrl}` : "https://.../model.safetensors";
  if (prefill.needUrl || prefill.folder) $(".comfyq-advanced", panel).open = true;
  if (prefill.needUrl) {
    urlInput.value = "";
    urlInput.scrollIntoView({ block: "center" });
    urlInput.focus();
    setPanelStatus(`No download link in this workflow for ${prefill.needUrl}. Paste one under Advanced, then click Download to Selected Folder.`, true);
  }
  renderMissingModels(true);
  updateVram(true);
}

function setPanelStatus(message, error = false) {
  const status = state.panel && $(".comfyq-status", state.panel);
  if (!status) return;
  status.hidden = !message;
  status.textContent = message;
  status.dataset.error = error ? "true" : "false";
}

async function startJob(body) {
  const job = await comfyQFetch("/comfyq/download", { method: "POST", body: JSON.stringify(body) });
  state.downloads.set(job.id, job);
  setPanelStatus("");
  renderDownloads();
  renderMissingModels(true);
  pollDownload(job.id);
}

// Panel list of models this workflow needs but are not installed. Re-rendered only when the list changes.
function renderMissingModels(force = false) {
  const container = state.missingEl;
  if (!container || !state.panel?.classList.contains("open")) return;
  const missing = findMissingModels();
  const signature = JSON.stringify(missing.map((entry) => [entry.name, entry.folder, entry.url, Boolean(activeJobFor(entry))]));
  if (!force && container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  if (!missing.length) {
    container.replaceChildren(el("div", { class: "comfyq-ok", text: "All models in this workflow are installed." }));
    return;
  }
  const withUrl = missing.filter((entry) => entry.url && !activeJobFor(entry));
  container.replaceChildren(
    el("div", { class: "comfyq-missing-head" }, [
      el("strong", { text: `Missing models (${missing.length})` }),
      withUrl.length > 1 ? el("button", { class: "comfyq-primary", text: `Download all (${withUrl.length})`, onclick: () => downloadModels(withUrl) }) : null,
    ]),
    ...missing.map((entry) => el("div", { class: "comfyq-missing-row" }, [
      el("div", { class: "comfyq-missing-name" }, [
        el("span", { text: entry.name, title: entry.url || "No download link in this workflow" }),
        el("small", { text: entry.folder }),
      ]),
      activeJobFor(entry)
        ? el("span", { class: "comfyq-muted", text: "downloading" })
        : el("button", {
          class: entry.url ? "comfyq-primary" : "",
          text: entry.url ? "Download" : "Add URL",
          title: entry.url || "No download link in this workflow; paste one below",
          onclick: () => downloadModels([entry]),
        }),
    ])),
  );
}

function updateLauncher() {
  const launcher = state.launcher;
  if (!launcher) return;
  const count = findMissingModels().length;
  launcher.textContent = count ? `comfyQol · ${count} missing` : `comfyQol v${state.info?.version || ""}`;
  launcher.classList.toggle("comfyq-has-missing", count > 0);
  renderMissingModels();
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function jobIsActive(job) {
  return ["queued", "downloading"].includes(job.status);
}

function renderDownloads() {
  const container = state.downloadsEl;
  if (!container) return;
  const jobs = [...state.downloads.values()].reverse();
  container.hidden = !jobs.length;
  const finished = jobs.filter((job) => !jobIsActive(job));
  container.replaceChildren(
    el("div", { class: "comfyq-missing-head" }, [
      el("strong", { text: "Downloads" }),
      finished.length ? el("button", { text: "Clear finished", onclick: () => {
        for (const job of finished) state.downloads.delete(job.id);
        renderDownloads();
      } }) : null,
    ]),
    ...jobs.map((job) => {
      const total = job.total_bytes || 0;
      const pct = total ? Math.min(100, (job.bytes_downloaded / total) * 100) : 0;
      let detail;
      if (job.status === "complete") detail = `Done · ${formatBytes(job.bytes_downloaded)}`;
      else if (job.status === "error") detail = job.error || "Download failed";
      else if (job.status === "queued") detail = "Starting...";
      else {
        const size = total ? `${formatBytes(job.bytes_downloaded)} of ${formatBytes(total)}` : formatBytes(job.bytes_downloaded);
        const speed = job.speed ? ` · ${formatBytes(job.speed)}/s` : "";
        detail = `${total ? `${Math.floor(pct)}% · ` : ""}${size}${speed}`;
      }
      return el("div", { class: "comfyq-job", "data-status": job.status }, [
        el("div", { class: "comfyq-job-name", text: job.filename, title: job.destination }),
        el("div", { class: "comfyq-bar" }, [
          el("div", { style: { width: `${job.status === "complete" ? 100 : pct}%` }, class: total || job.status !== "downloading" ? "" : "comfyq-bar-unknown" }),
        ]),
        el("div", { class: "comfyq-job-detail", text: detail }),
      ]);
    }),
  );
}

// ComfyUI's own "Refresh Node Definitions" (the R key): reloads model lists and re-runs its
// missing-model check, clearing those errors, without reloading the page.
async function refreshComfyModels() {
  const command = app.extensionManager?.command;
  if (command?.commands?.some((item) => item.id === "Comfy.RefreshNodeDefinitions")) {
    await command.execute("Comfy.RefreshNodeDefinitions");
  } else {
    await app.refreshComboInNodes();
  }
  updateLauncher();
  syncVueFolderIcons();
}

async function pollDownload(id) {
  let previous = null;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await comfyQFetch(`/comfyq/downloads/${id}`);
    const now = performance.now();
    if (previous && job.bytes_downloaded > previous.bytes) {
      const speed = ((job.bytes_downloaded - previous.bytes) / (now - previous.time)) * 1000;
      job.speed = previous.speed ? previous.speed * 0.7 + speed * 0.3 : speed;
    } else {
      job.speed = previous?.speed;
    }
    previous = { bytes: job.bytes_downloaded, time: now, speed: job.speed };
    state.downloads.set(id, job);
    renderDownloads();
    if (jobIsActive(job)) continue;

    if (job.status === "complete") {
      state.refreshPending = true;
      await app.refreshComboInNodes();
      if (!state.panel?.classList.contains("open")) toast(`Downloaded ${job.filename}`);
    } else {
      toast(`${job.filename}: ${job.error || "Download failed"}`, true);
    }
    // Once the queue is empty, run ComfyUI's full model refresh a single time.
    if (state.refreshPending && ![...state.downloads.values()].some(jobIsActive)) {
      state.refreshPending = false;
      await refreshComfyModels();
      toast("Downloads finished; models refreshed.");
    }
    updateLauncher();
    renderMissingModels(true);
    return;
  }
}

function formatGB(bytes) {
  return (bytes / 1073741824).toFixed(1);
}

async function gpuStats() {
  const stats = await comfyQFetch("/system_stats");
  return stats.devices?.find((device) => device.type !== "cpu");
}

async function updateVram(force = false) {
  if (!state.vramEl || !state.panel?.classList.contains("open")) return;
  if (!force && Date.now() - (state.vramCheckedAt || 0) < 4000) return;
  state.vramCheckedAt = Date.now();
  const device = await gpuStats().catch(() => null);
  state.vramEl.textContent = device ? `VRAM ${formatGB(device.vram_total - device.vram_free)} / ${formatGB(device.vram_total)} GB` : "";
  state.vramEl.title = device?.name || "";
}

// ComfyUI's /free route: once idle, the prompt worker unloads every model and drops cached
// node outputs, which also releases the models held in RAM. The next run loads them again.
async function freeVram() {
  const queue = await comfyQFetch("/queue");
  const response = await api.fetchApi("/free", { method: "POST", body: JSON.stringify({ unload_models: true, free_memory: true }) });
  if (!response.ok) throw new Error(`Free VRAM failed: ${response.status} ${response.statusText}`);
  if (queue.queue_running?.length) {
    toast("VRAM will be freed when the current run finishes.");
    return;
  }
  await sleep(1500);
  const device = await gpuStats();
  toast(device ? `Models unloaded. VRAM in use: ${formatGB(device.vram_total - device.vram_free)} of ${formatGB(device.vram_total)} GB.` : "Models unloaded.");
  updateVram(true);
}

const DASHBOARD_SECTIONS = ["Prompt", "Models", "Sampling", "Generation", "Refinement", "Output"];
const PROMPT_WIDGETS = /^(text|prompt|positive|negative|text_[gl]|clip_[gl]|t5xxl|user_prompt|system_prompt)$/;
const SAMPLING_WIDGETS = /^(steps|cfg|sampler_name|scheduler|guidance|shift|max_shift|base_shift|start_at_step|end_at_step)$/;
const GENERATION_WIDGETS = /^(seed|noise_seed|control_after_generate|width|height|batch_size|length)$/;
const REFINEMENT_WIDGETS = /^(denoise|upscale_method|upscale_model_name|scale_by|upscale_by|guide_size|bbox_threshold|feather)$/;
const OUTPUT_WIDGETS = /^(filename_prefix|format|file_format|output_format|extension|quality|codec|crf|lossless|output_path)$/;

function nodeIsActive(node) {
  return node.mode !== 2 && node.mode !== 4;
}

// Nodes that will run: the root graph plus each used subgraph's contents, with the subgraph titles leading to them.
function activeWorkflowNodes() {
  const found = [];
  const visited = new Set();
  const visit = (nodes, path) => {
    for (const node of nodes || []) {
      if (!nodeIsActive(node)) continue;
      if (!isSubgraphNode(node)) found.push({ node, path });
      else if (node.subgraph && !visited.has(node.subgraph)) {
        visited.add(node.subgraph);
        visit(node.subgraph.nodes, [...path, node.title]);
      }
    }
  };
  visit((app.graph?.rootGraph || app.graph)?._nodes, []);
  return found;
}

function widgetIsLinked(node, widget) {
  return (node.inputs || []).some((input) => input.widget?.name === widget.name && input.link != null);
}

function dashboardSection(node, widget) {
  const name = widget.name || "";
  const type = node.comfyClass || node.type || "";
  if (!name || widget.type === "button" || widget.hidden || widget.options?.hidden || /note/i.test(type) || widgetIsLinked(node, widget)) return null;
  if (REFINEMENT_WIDGETS.test(name)) return "Refinement";
  if (/detailer|upscale|hires/i.test(type) && (SAMPLING_WIDGETS.test(name) || GENERATION_WIDGETS.test(name))) return "Refinement";
  if (typeof widget.value === "string" && (PROMPT_WIDGETS.test(name) || widget.options?.multiline || (/^PrimitiveString/.test(type) && name === "value"))) return "Prompt";
  if (/style/i.test(name) && !folderForWidget(node, widget)) return "Prompt";
  if (folderForWidget(node, widget) || widgetLooksLikeModel(widget)) return "Models";
  if (/lora/i.test(type) && /strength|weight/.test(name)) return "Models";
  if (SAMPLING_WIDGETS.test(name)) return "Sampling";
  if (GENERATION_WIDGETS.test(name)) return "Generation";
  if (OUTPUT_WIDGETS.test(name) && (node.constructor?.nodeData?.output_node || /save/i.test(type))) return "Output";
  return null;
}

function linkTargets(node) {
  const graph = node.graph;
  return (node.outputs || []).flatMap((output) => (output.links || []).map((id) => {
    const link = graph?.links?.get?.(id) ?? graph?.links?.[id];
    const target = link && graph.getNodeById(link.target_id);
    return target ? { target, input: target.inputs?.[link.target_slot]?.name || "" } : null;
  }).filter(Boolean));
}

// Follow a text encoder's output (through guidance or conditioning nodes) to the sampler input it feeds.
function promptRole(node, depth = 0) {
  const targets = linkTargets(node);
  for (const { input } of targets) {
    if (/negative/i.test(input)) return "Negative";
    if (/positive/i.test(input)) return "Positive";
  }
  if (depth < 3) {
    for (const { target } of targets) {
      const role = promptRole(target, depth + 1);
      if (role) return role;
    }
  }
  if (depth === 0) {
    if (/negative/i.test(node.title)) return "Negative";
    if (/positive/i.test(node.title)) return "Positive";
  }
  return null;
}

function dashboardGroups() {
  const sections = new Map(DASHBOARD_SECTIONS.map((name) => [name, []]));
  for (const { node, path } of activeWorkflowNodes()) {
    const bySection = new Map();
    for (const widget of node.widgets || []) {
      const section = dashboardSection(node, widget);
      if (!section) continue;
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push(widget);
    }
    for (const [section, widgets] of bySection) {
      sections.get(section).push({ node, widgets, role: section === "Prompt" ? promptRole(node) : null, title: [...path, node.title].join(" › ") });
    }
  }
  const order = { Positive: 0, Negative: 1 };
  sections.get("Prompt").sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2));
  return [...sections].filter(([, groups]) => groups.length);
}

function dashboardSignature(groups) {
  return JSON.stringify(groups.map(([section, list]) => [section, list.map(({ node, widgets, role, title }) => [node.id, title, role, widgets.map((widget) => [widget.name, widget.options?.values?.length])])]));
}

function numberStep(widget) {
  const { step2, step, precision } = widget.options || {};
  if (step2 !== undefined) return step2;
  if (precision >= 0) return Number((10 ** -precision).toFixed(precision));
  return step > 10 ? step / 10 : "any";
}

function setWidgetValue(node, widget, value) {
  const previous = widget.value;
  widget.value = value;
  widget.callback?.(value, app.canvas, node);
  node.onWidgetChanged?.(widget.name, value, previous, widget);
  app.canvas?.setDirty?.(true, true);
}

function comboValues(node, widget) {
  const values = widget.options?.values;
  return typeof values === "function" ? values(widget, node) : values;
}

function syncControl({ input, widget }) {
  if (input === document.activeElement) return;
  if (input.type === "checkbox") input.checked = Boolean(widget.value);
  else if (input.value !== String(widget.value ?? "")) {
    input.value = widget.value ?? "";
    // A combo value that is not in its option list cannot be shown; rebuild to add it.
    if (input.tagName === "SELECT" && input.value !== String(widget.value)) state.dashboardSignature = null;
  }
}

function widgetControl(node, widget, multiline) {
  const values = comboValues(node, widget);
  const set = (value) => setWidgetValue(node, widget, value);
  let input;
  if (Array.isArray(values)) {
    input = el("select", { class: "comfyq-select" }, values.map((value) => el("option", { value, text: value })));
    if (!values.includes(widget.value)) input.prepend(el("option", { value: widget.value, text: `${widget.value} (missing)` }));
    input.addEventListener("change", () => set(input.value));
  } else if (typeof widget.value === "boolean") {
    input = el("input", { type: "checkbox" });
    input.addEventListener("change", () => set(input.checked));
  } else if (typeof widget.value === "number") {
    const { min, max, precision } = widget.options || {};
    input = el("input", { class: "comfyq-input", type: "number", step: numberStep(widget), min, max });
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (input.value !== "" && Number.isFinite(value)) set(precision === 0 ? Math.round(value) : value);
    });
  } else if (typeof widget.value === "string") {
    input = el(multiline ? "textarea" : "input", { class: "comfyq-input", rows: multiline ? 4 : undefined, spellcheck: "false" });
    input.addEventListener("input", () => set(input.value));
  } else {
    return null;
  }
  const control = { input, widget };
  syncControl(control);
  state.dashboardControls.push(control);
  return input;
}

function dashboardField(node, widget, multiline) {
  const input = widgetControl(node, widget, multiline);
  if (!input) return null;
  const extra = /^(seed|noise_seed)$/.test(widget.name)
    ? el("button", {
      class: "comfyq-icon",
      title: "Random seed",
      text: "🎲",
      onclick: () => {
        setWidgetValue(node, widget, Math.floor(Math.random() * Math.min(widget.options?.max ?? 2 ** 32, 2 ** 48)));
        renderDashboard();
      },
    })
    : null;
  return el("div", { class: `comfyq-field${multiline ? " wide" : ""}` }, [
    el("span", { text: (widget.label || widget.name).replace(/_/g, " "), title: widget.name }),
    input,
    extra,
  ]);
}

function showNode(node) {
  if (app.canvas?.graph !== node.graph) return;
  app.canvas.centerOnNode?.(node);
  app.canvas.selectNode?.(node);
}

function renderDashboard(force = false) {
  const body = state.dashboardBody;
  if (!body || !state.dashboard.classList.contains("open")) return;
  const groups = dashboardGroups();
  const signature = dashboardSignature(groups);
  if (!force && signature === state.dashboardSignature) {
    state.dashboardControls.forEach(syncControl);
    return;
  }
  state.dashboardSignature = signature;
  state.dashboardControls = [];
  if (!groups.length) {
    body.replaceChildren(el("div", { class: "comfyq-ok", text: "No prompt, model or sampler controls found in this workflow." }));
    return;
  }
  const collapsed = readStorage(DASHBOARD_COLLAPSED_KEY, {});
  body.replaceChildren(...groups.map(([section, list]) => {
    const details = el("details", { class: "comfyq-section" }, [
      el("summary", { text: section }),
      ...list.map((group) => el("div", { class: "comfyq-group" }, [
        el("div", {
          class: "comfyq-group-title",
          text: group.role ? `${group.role} · ${group.title}` : group.title,
          title: "Show this node on the canvas",
          onclick: () => showNode(group.node),
        }),
        ...group.widgets.map((widget) => dashboardField(group.node, widget, section === "Prompt")),
      ])),
    ]);
    details.open = !collapsed[section];
    details.addEventListener("toggle", () => writeStorage(DASHBOARD_COLLAPSED_KEY, { ...readStorage(DASHBOARD_COLLAPSED_KEY, {}), [section]: !details.open }));
    return details;
  }));
}

async function queueWorkflow() {
  const command = app.extensionManager?.command;
  if (command?.commands?.some((item) => item.id === "Comfy.QueuePrompt")) await command.execute("Comfy.QueuePrompt");
  else await app.queuePrompt(0, 1);
}

function ensureDashboard() {
  if (state.dashboard) return state.dashboard;
  const header = el("div", { class: "comfyq-header", title: "Drag to move" }, [
    el("strong", { text: "comfyQol Dashboard" }),
    el("div", { class: "comfyq-row" }, [
      el("button", { class: "comfyq-primary", text: "Run", title: "Queue this workflow", onclick: () => queueWorkflow().catch((error) => toast(error.message, true)) }),
      el("button", { text: "Free VRAM", title: "Unload all models and clear ComfyUI's cache", onclick: () => freeVram().catch((error) => toast(error.message, true)) }),
      el("button", { class: "comfyq-icon", title: "Close", text: "x", onclick: () => toggleDashboard(false) }),
    ]),
  ]);
  state.dashboardBody = el("div", { class: "comfyq-window-body" });
  state.dashboardControls = [];
  state.dashboard = el("div", { class: "comfyq-window comfyq-dashboard" }, [header, state.dashboardBody]);
  makeMovable(state.dashboard, header, DASHBOARD_POSITION_KEY);
  rememberSize(state.dashboard, DASHBOARD_SIZE_KEY);
  document.body.append(state.dashboard);
  return state.dashboard;
}

function toggleDashboard(open = !state.dashboard?.classList.contains("open")) {
  const dashboard = ensureDashboard();
  dashboard.classList.toggle("open", open);
  writeStorage(DASHBOARD_OPEN_KEY, open);
  if (!open) return;
  restoreElementPosition(dashboard, DASHBOARD_POSITION_KEY);
  renderDashboard(true);
}

const OUTPUT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

function outputManagerEnabled() {
  return readStorage(OUTPUT_MANAGER_KEY, false) === true;
}

function setOutputManager(enabled) {
  writeStorage(OUTPUT_MANAGER_KEY, enabled);
  if (state.outputsButton) state.outputsButton.hidden = !enabled;
  if (!enabled) state.outputs?.classList.remove("open");
  toast(enabled ? "Output manager on: click Outputs in the comfyQol panel, or right-click an output image." : "Output manager off.");
}

function viewUrl(file) {
  return api.apiURL(`/view?${new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" })}`);
}

function thumbUrl(file) {
  return api.apiURL(`/comfyq/thumb?${new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", t: file.mtime })}`);
}

// ComfyUI shows images through /view; keep only what names the file, so saving gets the original rather than a preview.
function fileFromViewUrl(src) {
  const url = new URL(src, location.href);
  if (!url.pathname.endsWith("/view") || !url.searchParams.get("filename")) return null;
  return { filename: url.searchParams.get("filename"), subfolder: url.searchParams.get("subfolder") || "", type: url.searchParams.get("type") || "output" };
}

function fileKey(file) {
  return `${file.type}/${file.subfolder}/${file.filename}`;
}

function fileExtension(file) {
  return file.filename.split(".").pop().toLowerCase();
}

async function fetchFile(file) {
  const response = await fetch(viewUrl(file));
  if (!response.ok) throw new Error(`Could not read ${file.filename}`);
  return response.blob();
}

async function writeToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function reportUnlessCancelled(error) {
  if (error?.name !== "AbortError") toast(error.message, true);
}

function downloadFile(file, name = file.filename) {
  const link = el("a", { href: viewUrl(file), download: name });
  document.body.append(link);
  link.click();
  link.remove();
}

async function downloadFiles(files) {
  for (const file of files) {
    downloadFile(file);
    await sleep(300);
  }
  toast(`Downloading ${files.length} file(s). If the browser asks, allow multiple downloads.`);
}

// The save dialogs need a secure page (localhost); over --listen on a LAN address the browser download is used instead.
async function saveFileAs(file) {
  if (!window.showSaveFilePicker) {
    const name = window.prompt("Save as", file.filename);
    if (name) downloadFile(file, name);
    return;
  }
  const extension = fileExtension(file);
  const type = OUTPUT_TYPES[extension];
  const handle = await window.showSaveFilePicker({
    id: "comfyq-save",
    suggestedName: file.filename,
    types: type ? [{ description: extension.toUpperCase(), accept: { [type]: [`.${extension}`] } }] : undefined,
  });
  await writeToHandle(handle, await fetchFile(file));
  toast(`Saved ${handle.name}`);
}

async function saveFilesToFolder(files) {
  if (!window.showDirectoryPicker) {
    await downloadFiles(files);
    return;
  }
  const folder = await window.showDirectoryPicker({ id: "comfyq-outputs", mode: "readwrite" });
  for (const file of files) {
    await writeToHandle(await folder.getFileHandle(file.filename, { create: true }), await fetchFile(file));
  }
  toast(`Saved ${files.length} file(s) to ${folder.name}.`);
}

function closeMenu() {
  state.menu?.remove();
  state.menu = null;
}

function showMenu(x, y, items) {
  closeMenu();
  state.menu = el("div", { class: "comfyq-menu" }, items.map(([text, action]) => el("button", {
    text,
    onclick: () => {
      closeMenu();
      Promise.resolve().then(action).catch(reportUnlessCancelled);
    },
  })));
  document.body.append(state.menu);
  const bounds = state.menu.getBoundingClientRect();
  state.menu.style.left = `${Math.min(x, window.innerWidth - bounds.width - 4)}px`;
  state.menu.style.top = `${Math.min(y, window.innerHeight - bounds.height - 4)}px`;
}

function selectedOutputs() {
  return (state.outputFiles || []).filter((file) => state.outputSelected.has(fileKey(file)));
}

// Right-click on any output image (node previews, the queue, the comfyQol gallery) offers Save As. Shift+right-click keeps the browser menu.
function watchOutputImages() {
  document.addEventListener("contextmenu", (event) => {
    if (!outputManagerEnabled() || event.shiftKey) return;
    // Image grids wrap each thumbnail in a button, so the click can land on the button instead of the image.
    const media = event.target.closest?.("img, video, [data-comfyq-file]") || event.target.closest?.("button")?.querySelector("img, video");
    const file = media && (media.dataset.comfyqFile ? JSON.parse(media.dataset.comfyqFile) : fileFromViewUrl(media.currentSrc || media.src || ""));
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [["Save As…", () => saveFileAs(file)], ["Open in New Tab", () => window.open(viewUrl(file), "_blank")]];
    const selected = media.closest(".comfyq-outputs") ? selectedOutputs() : [];
    if (selected.length > 1) {
      items.push([`Download ${selected.length} selected`, () => downloadFiles(selected)]);
      items.push([`Save ${selected.length} selected to folder…`, () => saveFilesToFolder(selected)]);
    }
    showMenu(event.clientX, event.clientY, items);
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (state.menu && !state.menu.contains(event.target)) closeMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
}

function nodeOutputFiles(node) {
  return (app.nodeOutputs?.[node.id]?.images || [])
    .filter((image) => image.filename)
    .map(({ filename, subfolder, type }) => ({ filename, subfolder: subfolder || "", type: type || "output" }));
}

function updateOutputsToolbar() {
  const selected = selectedOutputs().length;
  state.outputCount.textContent = `${selected} selected · ${state.outputFiles.length} of ${state.outputTotal}`;
  for (const button of state.outputActions) button.disabled = !selected;
  state.outputMore.hidden = state.outputFiles.length >= state.outputTotal;
}

function renderOutputs() {
  state.outputGrid.replaceChildren(...state.outputFiles.map((file) => {
    const key = fileKey(file);
    const data = JSON.stringify(file);
    const preview = OUTPUT_TYPES[fileExtension(file)]?.startsWith("video")
      ? el("div", { class: "comfyq-video", text: "▶", "data-comfyq-file": data })
      : el("img", { loading: "lazy", src: thumbUrl(file), alt: file.filename, "data-comfyq-file": data });
    const tile = el("div", {
      class: `comfyq-tile${state.outputSelected.has(key) ? " selected" : ""}`,
      title: `${file.subfolder ? `${file.subfolder}/` : ""}${file.filename}`,
      ondblclick: () => window.open(viewUrl(file), "_blank"),
    }, [preview, el("span", { class: "comfyq-tile-name", text: file.filename })]);
    tile.addEventListener("click", () => {
      if (state.outputSelected.has(key)) state.outputSelected.delete(key);
      else state.outputSelected.add(key);
      tile.classList.toggle("selected", state.outputSelected.has(key));
      updateOutputsToolbar();
    });
    return tile;
  }));
  updateOutputsToolbar();
}

async function loadOutputs(limit = Math.max(OUTPUT_PAGE, state.outputFiles.length)) {
  const result = await comfyQFetch(`/comfyq/outputs?limit=${limit}`);
  state.outputFiles = result.files;
  state.outputTotal = result.total;
  const keys = new Set(result.files.map(fileKey));
  for (const key of state.outputSelected) if (!keys.has(key)) state.outputSelected.delete(key);
  renderOutputs();
}

function ensureOutputs() {
  if (state.outputs) return state.outputs;
  state.outputFiles = [];
  state.outputTotal = 0;
  state.outputSelected = new Set();
  state.outputGrid = el("div", { class: "comfyq-grid" });
  state.outputCount = el("span", { class: "comfyq-muted" });
  state.outputMore = el("button", { text: "Show more", onclick: () => loadOutputs(state.outputFiles.length + OUTPUT_PAGE).catch((error) => toast(error.message, true)) });
  state.outputActions = [
    el("button", { class: "comfyq-primary", text: "Download", title: "Download each selected file separately (no ZIP)", onclick: () => downloadFiles(selectedOutputs()) }),
  ];
  if (window.showDirectoryPicker) {
    state.outputActions.push(el("button", { text: "Save to Folder…", title: "Choose a folder and save the selected files into it", onclick: () => saveFilesToFolder(selectedOutputs()).catch(reportUnlessCancelled) }));
  }
  const header = el("div", { class: "comfyq-header", title: "Drag to move" }, [
    el("strong", { text: "Outputs" }),
    el("div", { class: "comfyq-row" }, [
      el("button", { text: "Refresh", onclick: () => loadOutputs().catch((error) => toast(error.message, true)) }),
      el("button", { text: "Open Folder", onclick: () => openFolder({ special: "output" }).catch((error) => toast(error.message, true)) }),
      el("button", { class: "comfyq-icon", title: "Close", text: "x", onclick: () => toggleOutputs(false) }),
    ]),
  ]);
  state.outputs = el("div", { class: "comfyq-window comfyq-outputs" }, [
    header,
    el("div", { class: "comfyq-row comfyq-wrap" }, [
      el("button", { text: "Select All", onclick: () => {
        state.outputFiles.forEach((file) => state.outputSelected.add(fileKey(file)));
        renderOutputs();
      } }),
      el("button", { text: "Clear", onclick: () => {
        state.outputSelected.clear();
        renderOutputs();
      } }),
      state.outputCount,
      el("span", { class: "comfyq-spacer" }),
      ...state.outputActions,
    ]),
    el("div", { class: "comfyq-window-body" }, [state.outputGrid, state.outputMore]),
    el("div", { class: "comfyq-muted comfyq-hint", text: "Click to select · double-click to open · right-click for Save As" }),
  ]);
  makeMovable(state.outputs, header, OUTPUTS_POSITION_KEY);
  rememberSize(state.outputs, OUTPUTS_SIZE_KEY);
  document.body.append(state.outputs);
  api.addEventListener("executed", () => {
    if (!state.outputs.classList.contains("open")) return;
    clearTimeout(state.outputsReload);
    state.outputsReload = setTimeout(() => loadOutputs().catch(() => {}), 800);
  });
  return state.outputs;
}

function toggleOutputs(open = true) {
  if (open && !outputManagerEnabled()) {
    toast("Turn on the output manager under Advanced in the comfyQol panel first.", true);
    return;
  }
  const outputs = ensureOutputs();
  outputs.classList.toggle("open", open);
  if (!open) return;
  restoreElementPosition(outputs, OUTPUTS_POSITION_KEY);
  loadOutputs().catch((error) => toast(error.message, true));
}

function injectStyles() {
  if ($("#comfyq-style")) return;
  document.head.append(
    el("style", {
      id: "comfyq-style",
      text: `
        .comfyq-launcher {
          position: fixed; right: 18px; bottom: 76px; z-index: 9999; touch-action: none;
          border: 1px solid var(--border-color, #555); background: var(--comfy-menu-bg, #222);
          color: var(--fg-color, #eee); border-radius: 6px; padding: 8px 10px; cursor: pointer;
          box-shadow: 0 8px 24px rgba(0,0,0,.25);
        }
        .comfyq-panel {
          position: fixed; right: 18px; bottom: 122px; width: min(380px, calc(100vw - 32px));
          display: none; z-index: 9999; padding: 12px; gap: 8px; flex-direction: column;
          color: var(--fg-color, #eee); background: var(--comfy-menu-bg, #242424);
          border: 1px solid var(--border-color, #555); border-radius: 8px;
          box-shadow: 0 12px 34px rgba(0,0,0,.35); font-size: 14px;
          max-height: calc(100vh - 140px); overflow-y: auto;
        }
        .comfyq-panel.open { display: flex; }
        .comfyq-header, .comfyq-row { display: flex; align-items: center; gap: 8px; }
        .comfyq-header { cursor: grab; touch-action: none; user-select: none; }
        .comfyq-header.dragging { cursor: grabbing; }
        .comfyq-header { justify-content: space-between; }
        .comfyq-panel button, .comfyq-window button, .comfyq-input, .comfyq-select {
          min-height: 30px; border-radius: 6px; border: 1px solid var(--border-color, #555);
          background: var(--comfy-input-bg, #111); color: var(--fg-color, #eee);
        }
        .comfyq-panel button, .comfyq-window button { cursor: pointer; padding: 4px 8px; white-space: nowrap; }
        .comfyq-panel button:disabled, .comfyq-window button:disabled { opacity: .45; cursor: default; }
        .comfyq-primary { background: #2f6f55 !important; }
        .comfyq-icon { width: 28px; }
        .comfyq-input, .comfyq-select { width: 100%; padding: 4px 7px; box-sizing: border-box; }
        .comfyq-status[data-error="true"] { color: #ff8e8e; }
        .comfyq-downloads, .comfyq-advanced-body { display: flex; flex-direction: column; gap: 8px; }
        .comfyq-downloads { padding: 8px; border-radius: 6px; background: rgba(127,127,127,.12); }
        .comfyq-job { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
        .comfyq-job-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
        .comfyq-job-detail { opacity: .7; }
        .comfyq-job[data-status="error"] .comfyq-job-detail { color: #ff8e8e; opacity: 1; }
        .comfyq-bar { height: 6px; border-radius: 3px; background: rgba(127,127,127,.25); overflow: hidden; }
        .comfyq-bar > div { height: 100%; background: #3fb27a; transition: width .4s; }
        .comfyq-job[data-status="error"] .comfyq-bar > div { background: #c45; }
        .comfyq-bar-unknown { width: 30% !important; animation: comfyq-slide 1.2s linear infinite; }
        @keyframes comfyq-slide { from { margin-left: -30%; } to { margin-left: 100%; } }
        .comfyq-advanced summary { cursor: pointer; opacity: .8; padding: 2px 0; }
        .comfyq-advanced[open] summary { margin-bottom: 8px; }
        .comfyq-advanced label { font-size: 12px; opacity: .75; }
        .comfyq-status:empty, .comfyq-panel [hidden], .comfyq-window [hidden] { display: none !important; }
        .comfyq-launcher.dragging { cursor: grabbing; opacity: .85; }
        .comfyq-launcher.comfyq-has-missing { background: #2f6f55; border-color: #5fbf8f; color: #fff; }
        .comfyq-missing { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 6px; background: rgba(127,127,127,.12); }
        .comfyq-missing-head, .comfyq-missing-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .comfyq-missing-name { display: flex; flex-direction: column; min-width: 0; }
        .comfyq-missing-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .comfyq-missing-name small, .comfyq-muted { opacity: .65; font-size: 12px; }
        .comfyq-ok { font-size: 12px; opacity: .75; }
        .comfyq-needs-url { border-color: #e0a040 !important; box-shadow: 0 0 0 2px rgba(224,160,64,.35); }
        .comfyq-vue-folder, .comfyq-vue-download {
          display: inline-flex; align-items: center; vertical-align: middle; margin-right: 4px;
          padding: 0; border: 0; background: none; cursor: pointer; pointer-events: auto;
        }
        .comfyq-spacer { flex: 1; }
        .comfyq-wrap { flex-wrap: wrap; }
        .comfyq-vram { font-size: 12px; white-space: nowrap; }
        .comfyq-advanced label.comfyq-check { display: flex; align-items: flex-start; gap: 6px; cursor: pointer; font-size: 13px; opacity: 1; }
        .comfyq-window {
          position: fixed; top: 96px; left: 64px; z-index: 9998; display: none; flex-direction: column; gap: 8px;
          padding: 10px 12px; box-sizing: border-box; resize: both; overflow: hidden; min-width: 300px; min-height: 220px;
          max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); font-size: 14px;
          color: var(--fg-color, #eee); background: var(--comfy-menu-bg, #242424);
          border: 1px solid var(--border-color, #555); border-radius: 8px; box-shadow: 0 12px 34px rgba(0,0,0,.35);
        }
        .comfyq-window.open { display: flex; }
        .comfyq-dashboard { width: 400px; height: 70vh; }
        .comfyq-outputs { width: 620px; height: 65vh; left: auto; right: 18px; }
        .comfyq-window-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
        .comfyq-section { padding: 4px 8px 8px; border-radius: 6px; background: rgba(127,127,127,.12); }
        .comfyq-section > summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
        .comfyq-group { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
        .comfyq-group-title { font-size: 12px; opacity: .7; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .comfyq-field { display: grid; grid-template-columns: 105px minmax(0, 1fr) auto; gap: 6px; align-items: center; font-size: 13px; }
        .comfyq-field.wide { grid-template-columns: minmax(0, 1fr); }
        .comfyq-field > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
        .comfyq-field textarea { resize: vertical; min-height: 72px; font-family: inherit; line-height: 1.35; }
        .comfyq-field input[type="checkbox"] { justify-self: start; }
        .comfyq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
        .comfyq-tile { position: relative; aspect-ratio: 1; display: flex; overflow: hidden; cursor: pointer; border-radius: 6px; border: 2px solid transparent; background: rgba(127,127,127,.15); }
        .comfyq-tile img, .comfyq-video { width: 100%; height: 100%; object-fit: cover; }
        .comfyq-video { display: flex; align-items: center; justify-content: center; font-size: 28px; }
        .comfyq-tile.selected { border-color: #3fb27a; }
        .comfyq-tile.selected::after {
          content: "✓"; position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center; font-size: 12px; background: #2f8f5f; color: #fff;
        }
        .comfyq-tile-name { position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 4px; font-size: 11px; color: #fff; background: rgba(0,0,0,.55); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .comfyq-hint { font-size: 11px; }
        .comfyq-menu {
          position: fixed; z-index: 10000; display: flex; flex-direction: column; min-width: 190px; padding: 4px;
          color: var(--fg-color, #eee); background: var(--comfy-menu-bg, #242424); font-size: 14px;
          border: 1px solid var(--border-color, #555); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
        }
        .comfyq-menu button { text-align: left; padding: 6px 10px; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
        .comfyq-menu button:hover { background: rgba(127,127,127,.25); }
        .comfyq-vue-folder:hover svg path { fill: #b5862e; stroke: #fff; }
        .comfyq-vue-download:hover svg rect { fill: #3fb27a; }
      `,
    }),
  );
}

function resetPositions() {
  const windows = [
    [state.launcher, LAUNCHER_POSITION_KEY],
    [state.panel, PANEL_POSITION_KEY],
    [state.dashboard, DASHBOARD_POSITION_KEY, DASHBOARD_SIZE_KEY],
    [state.outputs, OUTPUTS_POSITION_KEY, OUTPUTS_SIZE_KEY],
  ];
  for (const [element, ...keys] of windows) {
    for (const key of keys) {
      try { localStorage.removeItem(key); } catch {}
    }
    if (element) for (const side of ["left", "top", "right", "bottom", "width", "height"]) element.style[side] = "";
  }
}

app.registerExtension({
  name: "comfyQ.QualityOfLife",
  commands: [
    { id: "comfyQ.openPanel", label: "comfyQol: Open Panel", function: () => togglePanel() },
    { id: "comfyQ.downloadMissing", label: "comfyQol: Download Missing Models", function: () => downloadModels(findMissingModels().filter((entry) => entry.url)) },
    { id: "comfyQ.dashboard", label: "comfyQol: Dashboard", function: () => toggleDashboard() },
    { id: "comfyQ.freeVram", label: "comfyQol: Free VRAM", function: () => freeVram().catch((error) => toast(error.message, true)) },
    { id: "comfyQ.outputs", label: "comfyQol: Outputs", function: () => toggleOutputs(true) },
    { id: "comfyQ.resetPosition", label: "comfyQol: Reset Button Position", function: resetPositions },
  ],
  menuCommands: [
    { path: ["Extensions", "comfyQol"], commands: ["comfyQ.openPanel", "comfyQ.dashboard", "comfyQ.downloadMissing", "comfyQ.freeVram", "comfyQ.outputs", "comfyQ.resetPosition"] },
  ],
  async setup() {
    injectStyles();
    watchVueNodes();
    watchOutputImages();
    await loadInfo();
    state.launcher = el("button", {
      class: "comfyq-launcher",
      title: "Open comfyQol (drag to move)",
      text: `comfyQol v${state.info.version}`,
      onclick: () => togglePanel(),
    });
    document.body.append(state.launcher);
    makeMovable(state.launcher, state.launcher, LAUNCHER_POSITION_KEY);
    restoreElementPosition(state.launcher, LAUNCHER_POSITION_KEY);
    setInterval(() => {
      updateLauncher();
      syncVueFolderIcons();
      updateVram();
    }, 2000);
    setInterval(renderDashboard, 1000);
    if (readStorage(DASHBOARD_OPEN_KEY, false)) toggleDashboard(true);
  },
  nodeCreated(node) {
    installFolderIcons(node);
  },
  getCanvasMenuItems() {
    return [
      null,
      { content: "comfyQol: Open Panel", callback: () => togglePanel() },
      { content: "comfyQol: Dashboard", callback: () => toggleDashboard(true) },
      { content: "comfyQol: Free VRAM", callback: () => freeVram().catch((error) => toast(error.message, true)) },
      ...(outputManagerEnabled() ? [{ content: "comfyQol: Outputs", callback: () => toggleOutputs(true) }] : []),
      { content: "comfyQol: Download Missing Models", callback: () => downloadModels(findMissingModels().filter((entry) => entry.url)) },
      { content: "comfyQol: Unpack All Subgraphs", callback: unpackAllSubgraphs },
      { content: "comfyQol: Remove All Subgraphs", callback: removeAllSubgraphs },
      { content: "comfyQol: Copy Selected Model Names", callback: copySelectedModelNames },
      { content: "comfyQol: Open Output Folder", callback: () => openFolder({ special: "output" }) },
    ];
  },
  getNodeMenuItems(node) {
    const items = [];
    const entries = getModelEntries(node);
    if (entries.length) {
      items.push({
        content: "comfyQol: Open Model Folder",
        callback: () => openModelFoldersForNode(node),
      });
      const missing = missingModelsForNode(node);
      items.push(missing.length
        ? { content: `comfyQol: Download Missing Model${missing.length === 1 ? "" : "s"} (${missing.length})`, callback: () => downloadModels(missing) }
        : { content: "comfyQol: Download Model Here", callback: () => togglePanel({ folder: entries[0].folder }) });
    }
    const files = outputManagerEnabled() ? nodeOutputFiles(node) : [];
    if (files.length) {
      items.push({ content: "comfyQol: Save Image As…", callback: () => saveFileAs(files[node.imageIndex ?? 0] || files[0]).catch(reportUnlessCancelled) });
      if (files.length > 1) items.push({ content: `comfyQol: Save All ${files.length} Images to Folder…`, callback: () => saveFilesToFolder(files).catch(reportUnlessCancelled) });
    }
    return items;
  },
});
