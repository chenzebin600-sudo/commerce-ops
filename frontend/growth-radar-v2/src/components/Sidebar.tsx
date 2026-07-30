import {
  Activity,
  BadgeCheck,
  Boxes,
  Building2,
  ClipboardList,
  Crosshair,
  DatabaseZap,
  Gauge,
  Globe2,
  Map,
  Radar,
  Settings2,
  Store,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavigationItem {
  key: string;
  label: string;
  icon: LucideIcon;
}

interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

const groups: NavigationGroup[] = [
  {
    label: "雷达总览",
    items: [
      { key: "today", label: "今日作战台", icon: Gauge },
      { key: "stores", label: "我的店铺战场", icon: Store },
      { key: "gaps", label: "店铺缺口诊断", icon: Building2 },
    ],
  },
  {
    label: "机会雷达",
    items: [
      { key: "map", label: "货盘机会地图", icon: Map },
      { key: "products", label: "产品雷达", icon: Boxes },
      { key: "comparison", label: "货盘验证 vs 我方", icon: Crosshair },
    ],
  },
  {
    label: "任务中心",
    items: [
      { key: "tasks", label: "全部任务", icon: ClipboardList },
      { key: "monitoring", label: "我的观察项", icon: Activity },
      { key: "resolved", label: "已完成任务", icon: BadgeCheck },
    ],
  },
  {
    label: "系统配置",
    items: [
      { key: "settings", label: "数据准备与映射", icon: Settings2 },
    ],
  },
];

interface SidebarProps {
  activeKey: string;
  onNavigate: (key: string) => void;
  compact?: boolean;
}

export function Sidebar({ activeKey, onNavigate, compact = false }: SidebarProps) {
  return (
    <aside className={`app-sidebar ${compact ? "app-sidebar--compact" : ""}`}>
      <div className="brand-block">
        <span className="brand-mark" aria-hidden="true">
          <Radar size={24} strokeWidth={1.8} />
        </span>
        <div>
          <strong>Growth Radar</strong>
          <span>超级店长运营助手</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label="Growth Radar 主导航">
        {groups.map((group) => (
          <section className="nav-group" key={group.label}>
            <span className="nav-group__label">{group.label}</span>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.key}
                  className={activeKey === item.key ? "is-active" : ""}
                  onClick={() => onNavigate(item.key)}
                  aria-current={activeKey === item.key ? "page" : undefined}
                >
                  <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </section>
        ))}
      </nav>

      <div className="sidebar-scope">
        <DatabaseZap size={15} aria-hidden="true" />
        <div>
          <span>数据模式</span>
          <strong>确定性规则 · 人工确认</strong>
        </div>
        <Globe2 size={15} aria-hidden="true" />
      </div>
    </aside>
  );
}
