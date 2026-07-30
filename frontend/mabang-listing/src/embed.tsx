import { createRoot, type Root } from "react-dom/client";
import { ListingDashboard } from "./ListingDashboard";
import "./styles.css";

type AuthorizedFetch = typeof fetch;

type MountOptions = {
  element: HTMLElement;
  authorizedFetch: AuthorizedFetch;
};

let mountedRoot: Root | null = null;
let mountedElement: HTMLElement | null = null;

export function mountMabangListing({
  element,
  authorizedFetch,
}: MountOptions) {
  if (mountedElement !== element) {
    mountedRoot?.unmount();
    mountedRoot = createRoot(element);
    mountedElement = element;
  }
  mountedRoot?.render(
    <ListingDashboard
      authorizedFetch={authorizedFetch}
      embedded
    />,
  );
}
