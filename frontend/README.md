# Commerce Ops 前端规范

## 唯一活动前端

`frontend/commerce-ops-vue` 是 Commerce Ops 唯一活动前端，技术栈固定为：

- Vue 3 Composition API 与 `<script setup lang="ts">`
- TypeScript
- Vue Router
- Pinia
- Element Plus
- ECharts / vue-echarts
- Lucide Vue 图标
- Vite

所有新增模块必须在 `frontend/commerce-ops-vue/src/pages` 创建 Vue 页面，在路由和侧边栏登记；共享请求放入 `src/services`，跨页面状态放入 `src/stores`，可复用界面放入 `src/components`。

## 禁止事项

- 不新增 React、ReactDOM、JSX 或 TSX。
- 不为新模块创建独立前端工程。
- 不通过 iframe 接入主工作台。
- 不在页面组件中复制认证、错误处理或底层 fetch 逻辑。
- 不在浏览器中直接处理大体量 Excel 数据。

## 历史前端

以下目录冻结为迁移期回退源码，不参与默认构建：

- `frontend/growth-radar-v2`
- `frontend/mabang-listing`
- `frontend/sales-assortment-dashboard`

需要验证历史页面时使用 `npm run build:legacy`。禁止继续在这些目录开发新功能；新功能必须实现于 Vue 工作台。

## 门禁

运行 `npm run check:frontend`。该门禁会阻止活动 Vue 工程引入 React、阻止新增独立前端工作区，并确保默认构建只发布 Vue。
