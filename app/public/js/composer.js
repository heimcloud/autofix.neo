// Composer preview: tiny markdown subset, escape first (no raw HTML ever).
(() => {
  const ta = document.getElementById("cmp-body");
  const out = document.getElementById("cmp-preview");
  const count = document.getElementById("cmp-count");
  if (!ta || !out) return;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
  function render(md) {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let list = null;
    let code = null;
    const close = () => { if (list) { html.push(`</${list}>`); list = null; } };
    for (const l of lines) {
      if (code !== null) {
        if (/^```/.test(l)) { html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; } else code.push(l);
        continue;
      }
      if (/^```/.test(l)) { close(); code = []; continue; }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { close(); html.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); continue; }
      if ((m = /^\s*[-*]\s+(.*)$/.exec(l))) { if (list !== "ul") { close(); html.push("<ul>"); list = "ul"; } html.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = /^\s*\d+\.\s+(.*)$/.exec(l))) { if (list !== "ol") { close(); html.push("<ol>"); list = "ol"; } html.push(`<li>${inline(m[1])}</li>`); continue; }
      close();
      if (l.trim()) html.push(`<p>${inline(l)}</p>`);
    }
    if (code !== null) html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    close();
    return html.join("");
  }
  let t = 0;
  const update = () => { out.innerHTML = ta.value.trim() ? render(ta.value) : '<p class="pub-small">Nothing to preview yet.</p>'; if (count) count.textContent = String(ta.value.length); };
  ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(update, 120); });
  update();
})();
