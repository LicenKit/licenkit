import { text } from "./i18n.js";

/** Build content without interpreting product or customer values as HTML. */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "hidden" || key === "disabled") node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

export function clearError(target) {
  target.replaceChildren();
  target.hidden = true;
}

export function showError(target, error, locale = "en-US") {
  const diagnostic = [error?.code, error?.message, error?.requestId ? `Request: ${error.requestId}` : null].filter(Boolean).join("\n");
  const details = el("details", {}, el("summary", { text: text("errorDetails", locale) }), el("pre", { text: diagnostic || "SITE_REQUEST_FAILED" }));
  target.classList.add("error-panel");
  target.setAttribute("role", "alert");
  target.replaceChildren(el("strong", { text: text("errorTitle", locale) }), el("p", { text: text("errorBody", locale) }), details);
  target.hidden = false;
}
