import { StyleProvider } from "@ant-design/cssinjs";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import { configureApi } from "./api";
import type { AuthorizedFetch } from "./types";
import "./styles.css";

const roots = new WeakMap<HTMLElement, Root>();

export function mountSalesAssortmentDashboard({
  element,
  styleContainer,
  popupContainer,
  authorizedFetch
}: {
  element: HTMLElement;
  styleContainer: ShadowRoot;
  popupContainer: HTMLElement;
  authorizedFetch: AuthorizedFetch;
}) {
  configureApi(authorizedFetch);
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  root.render(
    <StyleProvider container={styleContainer}>
      <App popupContainer={popupContainer} />
    </StyleProvider>
  );
}
