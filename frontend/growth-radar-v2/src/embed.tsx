import { StyleProvider } from "@ant-design/cssinjs";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import {
  configureGrowthRadarApi,
  type GrowthRadarFetch,
} from "./api";
import "./styles.css";

interface GrowthRadarMountOptions {
  element: HTMLElement;
  styleContainer: ShadowRoot;
  popupContainer: HTMLElement;
  authorizedFetch: GrowthRadarFetch;
  initialView?: string;
  onViewChange?: (view: string) => void;
}

const roots = new WeakMap<HTMLElement, Root>();

export function mountGrowthRadarV2({
  element,
  styleContainer,
  popupContainer,
  authorizedFetch,
  initialView = "today",
  onViewChange,
}: GrowthRadarMountOptions) {
  configureGrowthRadarApi({ fetchImpl: authorizedFetch });
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  root.render(
    <StyleProvider container={styleContainer}>
      <App
        embedded
        initialView={initialView}
        onViewChange={onViewChange}
        popupContainer={popupContainer}
      />
    </StyleProvider>,
  );
}

export function unmountGrowthRadarV2(element: HTMLElement) {
  const root = roots.get(element);
  if (!root) return;
  root.unmount();
  roots.delete(element);
}
