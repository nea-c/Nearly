export function breadcrumbParts(path: string, side: 'local' | 'remote') {
  let root = '', rest = path;
  if (side === 'local') {
    const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)(?:[/\\]+|$)/.exec(rest);
    const drive = /^([a-z]:)([/\\]*)/i.exec(rest);
    if (unc) { root = '\\\\' + unc[1] + '\\' + unc[2]; rest = rest.slice(unc[0].length); }
    else if (drive) { root = drive[1] + (drive[2] ? '\\' : ''); rest = rest.slice(drive[0].length); }
    else if (/^[/\\]/.test(rest)) { root = rest[0]; rest = rest.replace(/^[/\\]+/, ''); }
  } else if (rest.startsWith('/')) { root = '/'; rest = rest.replace(/^\/+/, ''); }
  const parts = rest.split(side === 'local' ? /[/\\]+/ : /\/+/).filter(Boolean);
  const filename = parts.pop() ?? '';
  return { folders: [...(root ? [root] : []), ...parts], filename };
}

export function renderBreadcrumb(element: HTMLElement, path: string, side: 'local' | 'remote', identity: string, fullLabel: string) {
  const {folders, filename} = breadcrumbParts(path, side);
  const span = (className: string, text: string) => {
    const node = document.createElement('span'); node.className = className; node.textContent = text; return node;
  };
  const separator = () => { const node = span('editor-breadcrumb-separator', '›'); node.setAttribute('aria-hidden', 'true'); return node; };
  const prefix = span('editor-breadcrumb-folders', '');
  folders.forEach((folder, i) => { if (i) prefix.append(separator()); prefix.append(span('editor-breadcrumb-folder', folder)); });
  element.replaceChildren(span('editor-breadcrumb-identity', identity));
  if (folders.length) element.append(separator(), prefix);
  if (filename) element.append(separator(), span('editor-breadcrumb-file', filename));
  element.title = fullLabel;
  element.setAttribute('aria-label', identity + ' · ' + path);
  element.setAttribute('role', 'group');
}
