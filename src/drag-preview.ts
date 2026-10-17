const title = (window as Window & {__NEARLY_DRAG_TITLE__?: string}).__NEARLY_DRAG_TITLE__ ?? new URLSearchParams(location.search).get("title");
document.querySelector("#label")!.textContent = title?.slice(0,160) || "Nearly";
