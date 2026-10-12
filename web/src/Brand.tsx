import { her } from "./name.ts";
import { href, type Route } from "./route.ts";

/** The sidebar's home link (docs/ux.md §6). */
export function Brand({ userId, route, onClick }: { userId: string; route: Route; onClick?: () => void }) {
  return <a className="brand" href={href({ page: "home", userId })} aria-current={route.page === "home" ? "page" : undefined} onClick={onClick}>{her()}</a>;
}
