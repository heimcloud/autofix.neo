export function adminLayout({ title, body, basePath = "/admin", readOnly = false, lang = "en", wide = false, head = "" }) {
  const base = String(basePath || "/admin").replace(/\/$/, "") || "/admin";
  const ro = readOnly
    ? `<span class="example-tag" title="Mutating forms disabled">read-only</span>`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Autofix Admin</title>
  <meta name="color-scheme" content="${wide ? "dark light" : "dark"}" />
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="/css/ops.css" />
  ${head}
</head>
<body${wide ? ` class="wide"` : ""}>
  <header class="site-header">
    <a class="logo" href="${base}/">Autofix</a>
    <nav>
      <a href="${base}/">Incidents</a>
      <a href="${base}/request">New request</a>
      <a href="/health">Health</a>
      ${ro}
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <p>Ops admin · Tinyauth at edge · Ingest via shared secret · No auto-merge</p>
  </footer>
</body>
</html>`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Public page: same look as the admin board (board.css on body.wide). */
export function publicLayout({ title, body, adminPath = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="color-scheme" content="dark light" />
  <meta name="robots" content="noindex" />
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="/css/ops.css" />
  <link rel="stylesheet" href="/css/board.css" />
</head>
<body class="wide pub">
  <header class="site-header">
    <a class="logo" href="/">Autofix</a>
    <nav>${adminPath ? `<a href="${escapeHtml(adminPath)}/">Admin</a>` : ""}<a href="/health">Health</a></nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}
