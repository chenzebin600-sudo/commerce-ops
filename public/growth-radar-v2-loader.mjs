const ASSET_BASE = "/assets/growth-radar-v2/";
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
    const response = await fetch(MANIFEST_URL, {
      headers: { accept: "application/json" },
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new Error(`Growth Radar React manifest unavailable (${response.status}).`);
    }
    const manifest = await response.json();
    const entryKey = Object.keys(manifest).find((key) => (
      manifest[key]?.isEntry
      && (manifest[key]?.src === "src/embed.tsx" || key.endsWith("embed.tsx"))
    ));
    if (!entryKey) throw new Error("Growth Radar React embedded entry was not found.");
    const entry = manifest[entryKey];
    const module = await import(`${ASSET_BASE}${entry.file}`);
    return {
      module,
      cssFiles: [...collectCss(manifest, entryKey)],
    };
  })();
  return bundlePromise;
}

async function attachStyles(shadowRoot, files) {
  for (const file of files) {
    if (shadowRoot.querySelector(`style[data-grv2-css="${CSS.escape(file)}"]`)) continue;
    const response = await fetch(`${ASSET_BASE}${file}`, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Growth Radar stylesheet unavailable (${response.status}).`);
    }
    const style = document.createElement("style");
    style.dataset.grv2Css = file;
    style.textContent = await response.text();
    shadowRoot.prepend(style);
  }
}

function renderLoading(root) {
  root.innerHTML = `
    <section class="growth-radar-loading" aria-busy="true">
      <span class="growth-radar-kicker">GROWTH RADAR V2.2</span>
      <h2>正在加载超级店长运营助手</h2>
      <p>读取最新已发布分析与数据门禁。</p>
    </section>`;
}

function renderFailure(root, error) {
  const section = document.createElement("section");
  section.className = "growth-radar-loading";
  section.setAttribute("role", "alert");
  const kicker = document.createElement("span");
  kicker.className = "growth-radar-kicker";
  kicker.textContent = "MODULE UNAVAILABLE";
  const heading = document.createElement("h2");
  heading.textContent = "Growth Radar V2.2 暂时不可用";
  const detail = document.createElement("p");
  detail.textContent = String(
    error?.message || error || "React bundle failed to load.",
  );
  section.append(kicker, heading, detail);
  root.replaceChildren(section);
}

export function createGrowthRadarReactPage({
  authorizedFetch,
  onStatus = () => {},
  rootId = "growthRadarV2Root",
}) {
  const state = {
    initialized: false,
    route: "today",
  };
  let host = null;
  let shadowRoot = null;
  let mountElement = null;
  let popupContainer = null;

  function initialize() {
    if (state.initialized) return;
    const root = document.getElementById(rootId);
    if (!root) throw new Error(`Missing Growth Radar root: ${rootId}`);
    state.initialized = true;
    renderLoading(root);
    host = document.createElement("div");
    host.className = "growth-radar-react-island";
    shadowRoot = host.attachShadow({ mode: "open" });
    mountElement = document.createElement("div");
    mountElement.id = "growth-radar-v2-react-root";
    popupContainer = document.createElement("div");
    popupContainer.id = "growth-radar-v2-popup-root";
    shadowRoot.append(mountElement, popupContainer);
    root.replaceChildren(host);
  }

  async function load({ route = state.route } = {}) {
    if (!state.initialized) initialize();
    state.route = route || "today";
    try {
      const bundle = await loadBundle();
      await attachStyles(shadowRoot, bundle.cssFiles);
      bundle.module.mountGrowthRadarV2({
        element: mountElement,
        styleContainer: shadowRoot,
        popupContainer,
        authorizedFetch,
        initialView: state.route,
        onViewChange: (view) => {
          state.route = view;
          history.replaceState(null, "", `#/growth-radar/${view}`);
        },
      });
    } catch (error) {
      const root = document.getElementById(rootId);
      if (root) renderFailure(root, error);
      onStatus(error.message || "Growth Radar V2.2 加载失败。", "error");
      throw error;
    }
  }

  return { initialize, load };
}
