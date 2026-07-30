---
name: 马帮 WPS 本地同步助手
description: 面向运营人员的一键本地同步启动与 WPS 代码生成工具
colors:
  primary: "#594AB5"
  primary-hover: "#46399A"
  accent: "#0F766E"
  background: "#FFFFFF"
  surface: "#F5F6FA"
  ink: "#171823"
  muted: "#5D6172"
  border: "#D8DBE6"
  danger: "#B42318"
  warning: "#9A5B00"
typography:
  title:
    fontFamily: "Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "Segoe UI, Microsoft YaHei UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0"
rounded:
  sm: "4px"
  md: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    padding: "11px 18px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
---

# Design System: 马帮 WPS 本地同步助手

## Overview

**Creative North Star: "安静的操作台"**

界面像一张整理清楚的工作台：第一眼能看到要填写什么、当前运行到哪一步、完成后该复制什么。视觉采用纯白背景、冷静的中性层次和少量靛紫主色，强调可靠而非炫技。

系统明确拒绝黑客终端风格、密集后台管理界面、夸张渐变和装饰性动画。技术日志可以查看，但不会压过主要操作。

**Key Characteristics:**

- 单一主流程
- 清晰的阶段状态
- 明确的日期与写表模式
- 克制的品牌色
- 熟悉的 Windows 控件行为
- 可恢复的错误反馈

## Colors

主色源于 `oklch(0.50 0.16 280)` 的克制靛紫，仅用于主要操作、焦点和当前状态；成功使用青绿色，警告和失败使用独立语义色。

**The Ten Percent Rule.** 主色在任何界面中的覆盖面积不得超过 10%，它只负责引导操作，不负责装饰背景。

## Typography

**Display Font:** Segoe UI（回退 Microsoft YaHei UI）  
**Body Font:** Segoe UI（回退 Microsoft YaHei UI）

单一系统无衬线字体保证安装包无需携带额外字体，并在 Windows 中文环境中保持清晰。标题使用 24px，正文使用 14px，紧凑面板标签使用 13px；字距始终为 0。

**The Plain Language Rule.** 按钮和状态文案使用用户动作与结果，不暴露内部函数名或协议术语。

## Elevation

系统默认平面化，通过背景层级和分隔线建立结构。阴影只用于窗口级弹层或复制成功提示，模糊半径不超过 8px。

**The Flat-By-Default Rule.** 静态内容不使用悬浮阴影，只有临时反馈可以离开基础平面。

## Components

### Buttons

- 主要按钮使用靛紫填充、白色文字和 8px 圆角。
- 次要按钮使用中性背景，不与主要动作争夺注意力。
- 所有按钮具备默认、悬停、焦点、按下、禁用和加载状态。

### Inputs / Fields

- 输入框使用白色背景、清晰边框和 8px 圆角。
- 密码默认遮挡，支持短暂显示。
- 错误在字段附近说明，不只改变边框颜色。

### Date Mode

- 使用并列单选控件呈现“昨天追加”和“本月清空重建”。
- 选项文字同时说明日期范围和写表结果，避免隐藏副作用。

### Status Flow

- 阶段按“服务、数据准备、隧道、代码”排列。
- 每个阶段同时显示图标、文字和状态说明，避免只依赖颜色。
- 运行日志位于可折叠区域，默认展示最后的高信号信息。

### Code Output

- 代码区域使用等宽系统字体。
- 复制按钮位于代码区域上方，复制成功后显示明确反馈。
- 生成代码只留下 WPS 表名需要修改。

## Do's and Don'ts

### Do:

- **Do** 保持一个醒目的主按钮和明确的运行顺序。
- **Do** 用文字和颜色共同表达成功、等待、警告和失败。
- **Do** 在失败后保留账号输入和日志，允许用户直接重试。
- **Do** 将技术细节放在日志区域，不干扰主要操作。

### Don't:

- **Don't** 做黑客终端风格或让用户手工执行多条命令。
- **Don't** 使用密集后台管理界面、大量卡片或嵌套卡片。
- **Don't** 使用夸张渐变、装饰性动画或玻璃拟态。
- **Don't** 把长篇技术异常直接作为主要错误文案。
- **Don't** 使用超过 8px 的常规卡片圆角或宽模糊阴影。
