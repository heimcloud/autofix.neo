/**
 * Admin "Feature / bug request" composer. Trusted input (authenticated admin,
 * same-origin guard like every admin POST): the request goes through the
 * normal loop (fix job → Hermes codes it → lab test → PR → review rounds).
 * The markdown reaches Hermes verbatim: stored in incidents.request_body,
 * carried unredacted by every job of the incident (queue.js REQUEST_KEYS,
 * worker carried()) and written to the prompt file (no argv / size limits).
 * What leaves the host (commits, PR text) still passes the redaction gates;
 * the target allowlist and the protected-path rules apply as usual.
 */
import { escapeHtml as esc } from "./layout.js";

export const COMPOSER_LIMITS = { title: 200, body: 64 * 1024 };

/** @returns {{ ok: true, value } | { ok: false, error }} */
export function validateRequest(body, allowlist) {
  const title = String(body?.title ?? "").replace(/\s+/g, " ").trim();
  const text = String(body?.body ?? "").replace(/\r\n/g, "\n");
  const type = body?.type === "feature" ? "feature" : body?.type === "bug" ? "bug" : "";
  const target = String(body?.target ?? "").trim();
  if (!title) return { ok: false, error: "Give the request a title." };
  if (title.length > COMPOSER_LIMITS.title) return { ok: false, error: `Title max ${COMPOSER_LIMITS.title} characters.` };
  if (!text.trim()) return { ok: false, error: "Describe the request." };
  if (text.length > COMPOSER_LIMITS.body) return { ok: false, error: `Request max ${COMPOSER_LIMITS.body} characters (it is passed to Hermes in full).` };
  if (!type) return { ok: false, error: "Pick feature or bug." };
  const hit = allowlist.find((r) => r.toLowerCase() === target.toLowerCase());
  if (!hit) return { ok: false, error: "Pick a target from the configured targets." };
  return { ok: true, value: { title, body: text, type, target: hit } };
}

export function renderComposer({ base, allowlist, values = {}, error = "", fixEnabled = true, readOnly = false }) {
  const v = (k) => esc(String(values[k] ?? ""));
  const opts = allowlist.map((r) => `<option value="${esc(r)}"${values.target === r ? " selected" : ""}>${esc(r)}</option>`).join("");
  return `<div class="board-wrap cmp-wrap">
  <p><a href="${esc(base)}/">← Board</a></p>
  <section class="cmp-card">
    <h2>Feature / bug request</h2>
    <p class="pub-small">Creates an incident and queues a fix job right away: Hermes implements it on a branch of the target fork, then the usual lab test, PR and review rounds follow. The text below reaches Hermes verbatim (no redaction, no truncation, max ${COMPOSER_LIMITS.body / 1024} KiB). Commits and PR text still go through the redaction gates, and protected paths still need your approval.</p>
    ${error ? `<p class="pub-flash err">${esc(error)}</p>` : ""}
    ${!fixEnabled ? `<p class="pub-flash err">Autofix fix is not enabled on this host: the request would be stored but no worker would pick it up.</p>` : ""}
    <form class="cmp-form" method="post" action="${esc(base)}/request">
      <div class="pub-row">
        <label class="pub-field pub-grow">Title<input name="title" required maxlength="${COMPOSER_LIMITS.title}" value="${v("title")}" placeholder="e.g. Fix a typo in the README" /></label>
        <label class="pub-field">Type<select name="type">
          <option value="feature"${values.type === "bug" ? "" : " selected"}>Feature</option>
          <option value="bug"${values.type === "bug" ? " selected" : ""}>Bug</option>
        </select></label>
        <label class="pub-field">Target<select name="target" required>${opts}</select></label>
      </div>
      <div class="cmp-split">
        <label class="pub-field cmp-body">Request (markdown)<textarea id="cmp-body" name="body" required maxlength="${COMPOSER_LIMITS.body}" spellcheck="true" placeholder="What should change, where, acceptance criteria…">${v("body")}</textarea>
          <span class="cmp-meta"><span id="cmp-count">0</span> / ${COMPOSER_LIMITS.body} characters</span></label>
        <div class="pub-field">Preview<div id="cmp-preview" class="cmp-preview" aria-live="polite"><p class="pub-small">Preview appears while you type (needs JavaScript).</p></div></div>
      </div>
      <div><button class="kbtn primary kbtn-lg" type="submit"${readOnly ? " disabled" : ""}>Create request and queue the fix</button></div>
    </form>
  </section>
</div>
<script src="/js/composer.js" defer></script>`;
}
