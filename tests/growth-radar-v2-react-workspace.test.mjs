import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(".");
const read = (relativePath) =>
  fs.readFile(path.join(projectRoot, relativePath), "utf8");

test("Growth Radar V2.2 React workspace is task-first and fail-closed", async (t) => {
  const [app, fixtures, types, sidebar, taskRail, chart, css, api] = await Promise.all([
    read("frontend/growth-radar-v2/src/App.tsx"),
    read("frontend/growth-radar-v2/src/fixtures.ts"),
    read("frontend/growth-radar-v2/src/types.ts"),
    read("frontend/growth-radar-v2/src/components/Sidebar.tsx"),
    read("frontend/growth-radar-v2/src/components/TaskRail.tsx"),
    read("frontend/growth-radar-v2/src/components/EChart.tsx"),
    read("frontend/growth-radar-v2/src/styles.css"),
    read("frontend/growth-radar-v2/src/api.ts"),
  ]);

  await t.test("01 the workspace starts from today tasks instead of a BI report", () => {
    assert.match(app, /今日作战台/);
    assert.match(taskRail, /今日必须关注/);
    assert.match(taskRail, /limit = 10/);
    assert.match(taskRail, /所有建议都附带证据和动作边界/);
  });

  await t.test("02 all confirmed task lifecycle states are represented", () => {
    for (const status of [
      "NEW",
      "ACKNOWLEDGED",
      "IN_PROGRESS",
      "MONITORING",
      "RESOLVED",
      "BLOCKED",
      "DISMISSED",
      "REOPENED",
    ]) {
      assert.match(types, new RegExp(`"${status}"`));
    }
  });

  await t.test("03 store states are deterministic and not a black-box health score", () => {
    for (const state of ["ACTION_REQUIRED", "WATCH", "STABLE", "BLOCKED"]) {
      assert.match(types, new RegExp(`"${state}"`));
    }
    assert.match(app, /状态来自活动任务与数据阻塞，不使用黑盒健康分/);
    assert.doesNotMatch(app, /AI评分|AI 评分|健康分数/);
  });

  await t.test("04 trend semantics use current seven days versus previous seven days", () => {
    assert.match(fixtures, /current7d/);
    assert.match(fixtures, /previous7d/);
    assert.match(app, /当前 7 天与前 7 天比较/);
    assert.match(app, /INSUFFICIENT_HISTORY/);
  });

  await t.test("05 opportunity actions retain their evidence boundary", () => {
    assert.match(fixtures, /核查在线状态后/);
    assert.match(types, /CROSS_COUNTRY_CANDIDATE/);
    assert.match(app, /近期无有效订单不代表未上架/);
    assert.match(app, /不自动上架或推广|不能自动触发补货/);
    assert.doesNotMatch(app, /executeAutoListing|autoPromote|autoReplenish/);
  });

  await t.test("06 data readiness is a first-class mode and blocks unsupported conclusions", () => {
    assert.match(app, /真实数据门禁/);
    assert.match(app, /正式分析尚未达到发布条件/);
    assert.match(fixtures, /有效订单历史窗口/);
    assert.match(fixtures, /店铺身份与店长归属/);
    assert.match(fixtures, /仓库国家映射/);
    assert.match(fixtures, /预测日销量语义/);
  });

  await t.test("07 navigation covers the confirmed V2.2 information architecture", () => {
    for (const label of [
      "今日作战台",
      "我的店铺战场",
      "店铺缺口诊断",
      "货盘机会地图",
      "产品雷达",
      "货盘验证 vs 我方",
      "全部任务",
      "数据准备与映射",
    ]) {
      assert.match(sidebar, new RegExp(label));
    }
  });

  await t.test("08 visualizations are interactive, accessible and responsive", () => {
    assert.match(chart, /AriaComponent/);
    assert.match(chart, /ResizeObserver/);
    assert.match(chart, /chart\.on\("click"/);
    assert.match(app, /aria: \{ enabled: true \}/);
    assert.match(css, /@media \(max-width: 760px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.doesNotMatch(css, /font-size:\s*[^;]*vw/);
  });

  await t.test("09 mappings are editable in the frontend without claiming persistence", () => {
    assert.match(app, /仓库 → 国家映射/);
    assert.match(app, /来源店铺 → 国家 \/ 店长/);
    assert.match(app, /当前为前端原型，仅保存在本次会话，未写入正式数据库/);
  });

  await t.test("10 the real-data gate consumes the assistant API", () => {
    assert.match(api, /\/api\/growth-radar\/v2\/assistant\/workspace/);
    assert.match(api, /readinessItemsFromApi/);
    assert.match(api, /readinessTasksFromItems/);
    assert.match(app, /loadAssistantWorkspace/);
    assert.match(app, /审计快照/);
  });

  await t.test("11 configuration gaps reuse existing facts and remain write-gated", () => {
    assert.match(api, /\/api\/growth-radar\/v2\/assistant\/configuration/);
    assert.match(api, /countryMappingsFromApi/);
    assert.match(api, /shopMappingsFromApi/);
    assert.match(app, /loadAssistantConfiguration/);
    assert.match(app, /真实映射缺口只读/);
    assert.match(app, /等待写入批准/);
    assert.doesNotMatch(app, /confirmShopMapping|saveCountryMappings/);
  });

  await t.test("12 published API results replace fixtures across tasks, stores and products", () => {
    assert.match(api, /assistantWorkspaceDataFromApi/);
    assert.match(api, /operationTasks/);
    assert.match(api, /opportunityMap/);
    assert.match(app, /setLiveTasks/);
    assert.match(app, /setLiveStores/);
    assert.match(app, /setLiveProducts/);
    assert.match(app, /setLiveOpportunityCells/);
    assert.match(app, /正在展示最新已发布分析/);
  });

  await t.test("13 approved task persistence exposes lifecycle actions and event history", () => {
    assert.match(api, /\/api\/growth-radar\/v2\/tasks/);
    assert.match(api, /updateAssistantTaskStatus/);
    assert.match(app, /taskPersistenceReady/);
    assert.match(app, /任务已被其他操作更新/);
    assert.match(app, /事件历史/);
    assert.match(app, /处理原因/);
    assert.match(app, /复核时间/);
    assert.match(app, /GRV2-METRICS-1\.2\.0/);
    assert.match(taskRail, /DISMISSED/);
    assert.match(taskRail, /REOPENED/);
  });

  await t.test("14 empty readiness dimensions produce finite progress values", () => {
    assert.match(app, /if \(item\.target <= 0\) return item\.state === "READY" \? 100 : 0/);
  });

  await t.test("15 Mabang order and inventory schedules are managed inside data configuration", () => {
    assert.match(app, /马帮订单与库存同步/);
    assert.match(app, /新建订单同步/);
    assert.match(app, /新建库存同步/);
    assert.match(app, /调度器当前离线/);
    assert.match(app, /页面始终读取最新已成功入库批次/);
    assert.match(api, /\/api\/mabang\/scheduler-meta/);
    assert.match(api, /\/api\/mabang\/scheduled-tasks/);
    assert.match(api, /\/api\/mabang\/scheduled-runs\?limit=30/);
    assert.match(api, /paymentDateMode: input\.taskType === "order_export"/);
    assert.match(api, /"snapshot"/);
  });
});
