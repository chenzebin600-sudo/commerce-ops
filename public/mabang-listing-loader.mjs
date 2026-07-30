const ASSET_BASE = "/assets/mabang-listing/";
const MANIFEST_URL = `${ASSET_BASE}.vite/manifest.json`;

let bundlePromise = null;

function collectCss(manifest, entryKey, output = new Set()) {
  const entry = manifest[entryKey];
  if (!entry) return output;
  for (const file of entry.css || []) output.add(file);
  for (const importedKey of entry.imports || []) {
    collectCss(manifest, importedKey, output);
  }
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
      throw new Error(
        `马帮刊登工作台资源不可用 (${response.status})。`,
      );
    }
    const manifest = await response.json();
    const entryKey = Object.keys(manifest).find((key) => (
      manifest[key]?.isEntry
      && (manifest[key]?.src === "src/embed.tsx"
        || key.endsWith("embed.tsx"))
    ));
    if (!entryKey) throw new Error("未找到马帮工作台嵌入入口。");
    const entry = manifest[entryKey];
    return {
      module: await import(`${ASSET_BASE}${entry.file}`),
      cssFiles: [...collectCss(manifest, entryKey)],
    };
  })();
  return bundlePromise;
}

async function attachStyles(shadowRoot, files) {
  for (const file of files) {
    if (
      shadowRoot.querySelector(
        `style[data-mabang-listing-css="${CSS.escape(file)}"]`,
      )
    ) continue;
    const response = await fetch(`${ASSET_BASE}${file}`, {
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new Error(
        `马帮刊登工作台样式不可用 (${response.status})。`,
      );
    }
    const style = document.createElement("style");
    style.dataset.mabangListingCss = file;
    style.textContent = await response.text();
    shadowRoot.prepend(style);
  }
}

function renderLoading(root) {
  root.innerHTML = `
    <section class="module-loading" aria-busy="true">
      <span class="page-context">MABANG PUBLISHING</span>
      <h2>正在连接马帮刊登工作台</h2>
      <p>首次打开会按需启动本机桥接服务。</p>
    </section>`;
}

function renderFailure(root, error) {
  const section = document.createElement("section");
  section.className = "module-loading";
  section.setAttribute("role", "alert");
  const context = document.createElement("span");
  context.className = "page-context";
  context.textContent = "MODULE UNAVAILABLE";
  const heading = document.createElement("h2");
  heading.textContent = "马帮刊登工作台暂时不可用";
  const detail = document.createElement("p");
  detail.textContent = String(error?.message || error || "模块加载失败。");
  section.append(context, heading, detail);
  root.replaceChildren(section);
}

export function createMabangListingPage({
  authorizedFetch,
  onStatus = () => {},
  rootId = "mabangListingRoot",
}) {
  let initialized = false;
  let mounted = false;
  let shadowRoot = null;
  let mountElement = null;

  function initialize() {
    if (initialized) return;
    const root = document.getElementById(rootId);
    if (!root) throw new Error(`Missing Mabang listing root: ${rootId}`);
    initialized = true;
    renderLoading(root);
    const host = document.createElement("div");
    host.className = "mabang-listing-react-island";
    shadowRoot = host.attachShadow({ mode: "open" });
    mountElement = document.createElement("div");
    mountElement.id = "mabang-listing-react-root";
    shadowRoot.append(mountElement);
    root.replaceChildren(host);
  }

  async function load({ force = false } = {}) {
    if (!initialized) initialize();
    if (mounted && !force) return;
    try {
      const bundle = await loadBundle();
      await attachStyles(shadowRoot, bundle.cssFiles);
      bundle.module.mountMabangListing({
        element: mountElement,
        authorizedFetch,
      });
      mounted = true;
    } catch (error) {
      const root = document.getElementById(rootId);
      if (root) renderFailure(root, error);
      onStatus(error.message || "马帮刊登工作台加载失败。", "error");
      throw error;
    }
  }

  return { initialize, load };
}
