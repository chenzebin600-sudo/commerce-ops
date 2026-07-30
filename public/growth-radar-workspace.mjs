import { createGrowthRadarPage as createGrowthRadarDataPage } from "./growth-radar-page.mjs?v=20260722-g1b2-1";
import { createGrowthRadarReactPage } from "./growth-radar-v2-loader.mjs?v=20260727-mainline-1";

export function createGrowthRadarWorkspace({ authorizedFetch, onStatus = () => {} }) {
  const state = {
    initialized: false,
    loaded: false,
    activeMode: "analysis",
    analysisRoute: "today",
  };
  let analysisPage = null;
  let dataPage = null;

  const root = () => document.getElementById("growthRadarRoot");

  function routeState(hash = location.hash) {
    const parts = String(hash || "")
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean);
    if (parts[0] !== "growth-radar") {
      return { mode: "analysis", route: "today" };
    }
    if (parts[1] === "data") return { mode: "data", route: "data" };
    return { mode: "analysis", route: parts[1] || "today" };
  }

  function setMode(mode, { updateRoute = true, loadContent = true } = {}) {
    state.activeMode = mode === "data" ? "data" : "analysis";
    root()?.querySelectorAll("[data-gr-workspace-mode]").forEach((button) => {
      const active = button.dataset.grWorkspaceMode === state.activeMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const analysis = document.getElementById("growthRadarV2Root");
    const data = document.getElementById("growthRadarLegacyRoot");
    if (analysis) analysis.hidden = state.activeMode !== "analysis";
    if (data) data.hidden = state.activeMode !== "data";
    if (state.activeMode === "analysis") {
      if (updateRoute) history.replaceState(null, "", `#/growth-radar/${state.analysisRoute}`);
      if (loadContent) {
        analysisPage?.load({ route: state.analysisRoute }).catch((error) => onStatus(error.message, "error"));
      }
    } else {
      if (updateRoute) history.replaceState(null, "", "#/growth-radar/data");
      if (loadContent) dataPage?.load().catch((error) => onStatus(error.message, "error"));
    }
  }

  function renderShell() {
    root().innerHTML = `
      <section class="gr-workspace">
        <header class="gr-workspace-header">
          <div>
            <span class="gr-workspace-label">Commerce Ops · Growth Radar V2.2</span>
            <h2>超级店长运营助手</h2>
            <p>每天收敛店铺异常、货盘机会与可执行任务；每条结论都附带规则和证据。</p>
          </div>
          <nav class="gr-workspace-modes" role="tablist" aria-label="Growth Radar 工作模式">
            <button type="button" role="tab" class="active" aria-selected="true" data-gr-workspace-mode="analysis">运营作战</button>
            <button type="button" role="tab" aria-selected="false" data-gr-workspace-mode="data">数据与范围</button>
          </nav>
        </header>
        <div id="growthRadarV2Root"></div>
        <div id="growthRadarLegacyRoot" hidden></div>
      </section>`;
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    renderShell();
    analysisPage = createGrowthRadarReactPage({
      authorizedFetch,
      onStatus,
      rootId: "growthRadarV2Root",
    });
    dataPage = createGrowthRadarDataPage({
      authorizedFetch,
      onStatus,
      rootId: "growthRadarLegacyRoot",
    });
    analysisPage.initialize();
    dataPage.initialize();
    root().addEventListener("click", (event) => {
      const mode = event.target.closest("[data-gr-workspace-mode]");
      if (mode) {
        setMode(mode.dataset.grWorkspaceMode);
        return;
      }
      if (event.target.closest("[data-gr-open-data]")) setMode("data");
    });
  }

  async function load({ force = false, route } = {}) {
    if (!state.initialized) initialize();
    const next = route
      ? { mode: route === "data" ? "data" : "analysis", route }
      : routeState();
    state.activeMode = next.mode;
    if (next.mode === "analysis") state.analysisRoute = next.route || "today";
    setMode(state.activeMode, { updateRoute: false, loadContent: false });
    if (state.loaded && !force && next.mode === "data") return;
    state.loaded = true;
    if (state.activeMode === "analysis") {
      await analysisPage.load({ force, route: state.analysisRoute });
    }
    else await dataPage.load({ force });
  }

  return { initialize, load };
}
