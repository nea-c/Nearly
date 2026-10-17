// Suppress WebView's page menu after application handlers have had a chance
// to show their own menus. Do not stop propagation or intercept edit shortcuts.
document.addEventListener("contextmenu", event => event.preventDefault());
