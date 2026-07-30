const ASSET_BASE = "/assets/sales-assortment-dashboard/";
const MANIFEST_URL = `${ASSET_BASE}.vite/manifest.json`;

let bundlePromise = null;

function collectCss(manifest, entryKey, output = new Set()) {
  const entry = manifest[entryKey];
  if (!entry) return output;
  for (const file of entry.css || []) output.add(file);
  for (const importedKey of entry.imports || []) collectCss(manifest, importedKey, output);
  return output;
}

async function loadBundle() {
  if (bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const response = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`销售与货盘驾驶舱资源不可用 (${response.status})。`);
    const manifest = await response.json();
    const entryKey = Object.keys(manifest).find((key) => (
      manifest[key]?.isEntry
      && (manifest[key]?.src === "src/embed.tsx" || key.endsWith("embed.tsx"))
    ));
    if (!entryKey) throw new Error("销售与货盘驾驶舱嵌入入口不存在。");
    return {
      module: await import(`${ASSET_BASE}${manifest[entryKey].file}`),
      cssFiles: [...collectCss(manifest, entryKey)],
    };
  })();
  return bundlePromise;
}

async function attachStyles(shadowRoot, files) {
  for (const file of files) {
    if (shadowRoot.querySelector(`style[data-sales-assortment-css="${CSS.escape(file)}"]`)) continue;
    const response = await fetch(`${ASSET_BASE}${file}`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`驾驶舱样式不可用 (${response.status})。`);
    const style = document.createElement("style");
    style.dataset.salesAssortmentCss = file;
    style.textContent = await response.text();
    shadowRoot.prepend(style);
  }
}

export function createSalesAssortmentDashboard({
  authorizedFetch,
  onStatus = () => {},
  rootId = "salesAssortmentDashboardRoot",
}) {
  let initialized = false;
  let loaded = false;
  let shadowRoot = null;
  let mountElement = null;
  let popupContainer = null;

  function initialize() {
    if (initialized) return;
    const root = document.getElementById(rootId);
    if (!root) throw new Error(`Missing sales assortment dashboard root: ${rootId}`);
    initialized = true;
    const host = document.createElement("div");
    host.className = "sales-assortment-react-island";
    shadowRoot = host.attachShadow({ mode: "open" });
    mountElement = document.createElement("div");
    mountElement.id = "sales-assortment-react-root";
    popupContainer = document.createElement("div");
    popupContainer.id = "sales-assortment-popup-root";
    shadowRoot.append(mountElement, popupContainer);
    root.replaceChildren(host);
  }

  async function load({ force = false } = {}) {
    if (!initialized) initialize();
    if (loaded && !force) return;
    try {
      const bundle = await loadBundle();
      await attachStyles(shadowRoot, bundle.cssFiles);
      bundle.module.mountSalesAssortmentDashboard({
        element: mountElement,
        styleContainer: shadowRoot,
        popupContainer,
        authorizedFetch,
      });
      loaded = true;
    } catch (error) {
      onStatus(error.message || "销售与货盘驾驶舱加载失败。", "error");
      throw error;
    }
  }

  return { initialize, load };
}
