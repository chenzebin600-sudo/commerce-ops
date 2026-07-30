import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(".");
const read = (filename) => fs.readFile(path.join(projectRoot, filename), "utf8");

test("Growth Radar V2.2 React island is integrated into the Commerce Ops shell", async (t) => {
  const [
    workspace,
    loader,
    app,
    html,
    embed,
    reactApp,
    styles,
    vite,
    packageJson,
  ] = await Promise.all([
    read("public/growth-radar-workspace.mjs"),
    read("public/growth-radar-v2-loader.mjs"),
    read("public/app.js"),
    read("public/index.html"),
    read("frontend/growth-radar-v2/src/embed.tsx"),
    read("frontend/growth-radar-v2/src/App.tsx"),
    read("frontend/growth-radar-v2/src/styles.css"),
    read("frontend/growth-radar-v2/vite.config.ts"),
    read("package.json"),
  ]);

  await t.test("01 the unified workspace keeps React operations and A2 data modes", () => {
    assert.match(workspace, /createGrowthRadarReactPage/);
    assert.match(workspace, /createGrowthRadarDataPage/);
    assert.match(workspace, /运营作战/);
    assert.match(workspace, /数据与范围/);
    assert.doesNotMatch(workspace, /createGrowthRadarV2Page/);
  });

  await t.test("02 the React island uses the production manifest without an iframe", () => {
    assert.match(loader, /ASSET_BASE = "\/assets\/growth-radar-v2\/"/);
    assert.match(loader, /\.vite\/manifest\.json/);
    assert.match(loader, /attachShadow\(\{ mode: "open" \}\)/);
    assert.match(loader, /mountGrowthRadarV2/);
    assert.match(loader, /authorizedFetch/);
    assert.doesNotMatch(loader, /iframe/i);
  });

  await t.test("03 Ant and Tailwind styles remain inside the shadow root", () => {
    assert.match(embed, /StyleProvider/);
    assert.match(embed, /container=\{styleContainer\}/);
    assert.match(reactApp, /getPopupContainer/);
    assert.match(styles, /:host/);
    assert.match(styles, /\.growth-radar-app\.is-embedded/);
  });

  await t.test("04 the embedded app has no second shell navigation or demo default", () => {
    assert.match(reactApp, /embedded \? "READINESS" : "DEMO"/);
    assert.match(reactApp, /!embedded && <Sidebar/);
    assert.match(reactApp, /embedded-navigation/);
    assert.match(reactApp, /正式数据 \/ 门禁/);
  });

  await t.test("05 hash routes preserve main-shell navigation", () => {
    assert.match(app, /pageFromHash/);
    assert.match(app, /growthRadarRouteFromHash/);
    assert.match(workspace, /#\/growth-radar\/data/);
    assert.match(workspace, /#\/growth-radar\/\$\{state\.analysisRoute\}/);
    assert.equal((html.match(/data-page="growth-radar"/g) || []).length, 1);
  });

  await t.test("06 Vite builds a dedicated embedded entry into public assets", () => {
    assert.match(vite, /src\/embed\.tsx/);
    assert.match(vite, /public\/assets\/growth-radar-v2/);
    assert.match(vite, /manifest: true/);
    assert.match(packageJson, /build:growth-radar:v2/);
  });

  await t.test("07 the formal 1.2.0 semantics are visible", () => {
    assert.match(reactApp, /GRV2-METRICS-1\.2\.0/);
    assert.match(reactApp, /已发货、待处理、配货中、已完成/);
    assert.match(reactApp, /货盘验证 vs 我方承接/);
    assert.doesNotMatch(reactApp, /GRV2-METRICS-1\.1\.0/);
  });
});
