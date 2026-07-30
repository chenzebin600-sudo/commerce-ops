import { Button, Dropdown, Empty, Tag } from "antd";
import type { MenuProps } from "antd";
import {
  ArrowRight,
  Ban,
  Check,
  Clock3,
  Eye,
  MoreHorizontal,
  Play,
} from "lucide-react";
import type {
  OperationTask,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "../types";

const priorityLabels: Record<TaskPriority, string> = {
  P0: "立即处理",
  P1: "高优先",
  P2: "计划处理",
  P3: "观察",
};

const typeLabels: Record<TaskType, string> = {
  STORE_ASSORTMENT_GAP: "店铺货盘缺口",
  SALES_DECLINE: "销售下滑",
  INVENTORY_RISK: "库存风险",
  NEW_PRODUCT: "新品机会",
  QUIET_ENTRY: "蓝海候选",
  CROSS_COUNTRY_CANDIDATE: "跨国候选",
  DATA_CONFIGURATION: "数据配置",
};

const statusLabels: Record<TaskStatus, string> = {
  NEW: "待确认",
  ACKNOWLEDGED: "已接收",
  IN_PROGRESS: "处理中",
  MONITORING: "观察中",
  RESOLVED: "已解决",
  BLOCKED: "已阻塞",
  DISMISSED: "已忽略",
  REOPENED: "已重开",
};

interface TaskRailProps {
  tasks: OperationTask[];
  onOpen: (task: OperationTask) => void;
  onStatusChange: (id: string, status: TaskStatus) => void | Promise<void>;
  limit?: number;
  title?: string;
}

const transitions: Record<TaskStatus, TaskStatus[]> = {
  NEW: ["ACKNOWLEDGED", "BLOCKED", "DISMISSED"],
  ACKNOWLEDGED: ["IN_PROGRESS", "BLOCKED", "DISMISSED"],
  IN_PROGRESS: ["MONITORING", "BLOCKED"],
  MONITORING: ["RESOLVED", "BLOCKED"],
  BLOCKED: ["IN_PROGRESS", "DISMISSED"],
  RESOLVED: ["REOPENED"],
  DISMISSED: ["REOPENED"],
  REOPENED: ["ACKNOWLEDGED", "IN_PROGRESS"],
};

function statusIcon(status: TaskStatus) {
  if (status === "ACKNOWLEDGED" || status === "RESOLVED") return <Check size={14} />;
  if (status === "IN_PROGRESS" || status === "REOPENED") return <Play size={14} />;
  if (status === "MONITORING") return <Eye size={14} />;
  if (status === "BLOCKED" || status === "DISMISSED") return <Ban size={14} />;
  return <Clock3 size={14} />;
}

export function TaskRail({
  tasks,
  onOpen,
  onStatusChange,
  limit = 10,
  title = "今日必须关注",
}: TaskRailProps) {
  const visibleTasks = tasks.slice(0, limit);

  return (
    <section className="task-worklist" aria-labelledby="task-worklist-heading">
      <header className="section-header">
        <div>
          <span className="section-kicker">先处理，再分析</span>
          <h2 id="task-worklist-heading">{title}</h2>
          <p>每位店长首页最多展示 10 项，所有建议都附带证据和动作边界。</p>
        </div>
        <span className="section-count">{visibleTasks.length}</span>
      </header>

      <div className="task-list">
        {visibleTasks.map((task, index) => {
          const menu: MenuProps["items"] = transitions[task.status].map((status) => ({
            key: status,
            label: statusLabels[status],
            icon: statusIcon(status),
          }));

          return (
            <article className="task-row" key={task.id}>
              <span className="task-row__rank">{index + 1}</span>
              <div className="task-row__body">
                <div className="task-row__meta">
                  <Tag className={`priority-tag priority-tag--${task.priority.toLowerCase()}`}>
                    {task.priority} · {priorityLabels[task.priority]}
                  </Tag>
                  <span>{typeLabels[task.type]}</span>
                  <span>{task.countryName} · {task.platform}</span>
                  <span>{task.manager}</span>
                </div>
                <button
                  type="button"
                  className="task-row__title"
                  onClick={() => onOpen(task)}
                >
                  {task.title}
                </button>
                <p>{task.discovery}</p>
                <div className="task-row__evidence">
                  {task.evidence.slice(0, 3).map((item) => (
                    <span key={`${task.id}-${item.label}`}>
                      <small>{item.label}</small>
                      <strong>{item.value}</strong>
                    </span>
                  ))}
                </div>
              </div>
              <div className="task-row__actions">
                <span className={`status-label status-label--${task.status.toLowerCase()}`}>
                  <Clock3 size={13} aria-hidden="true" />
                  {statusLabels[task.status]}
                </span>
                <Button
                  type="text"
                  icon={<ArrowRight size={17} />}
                  onClick={() => onOpen(task)}
                  aria-label={`查看任务：${task.title}`}
                />
                <Dropdown
                  menu={{
                    items: menu,
                    onClick: ({ key }) => onStatusChange(task.id, key as TaskStatus),
                  }}
                  trigger={["click"]}
                >
                  <Button
                    type="text"
                    icon={<MoreHorizontal size={17} />}
                    aria-label={`更新任务状态：${task.title}`}
                  />
                </Dropdown>
              </div>
            </article>
          );
        })}
        {visibleTasks.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前筛选范围没有待处理任务"
          />
        )}
      </div>
    </section>
  );
}
