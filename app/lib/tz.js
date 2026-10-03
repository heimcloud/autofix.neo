/**
 * Display time zone of the admin UI: OPS_TIME_ZONE (the Nix module passes
 * the host's time.timeZone), else TZ, else UTC. Invalid names fall back to UTC.
 */
function pick() {
  for (const z of [process.env.OPS_TIME_ZONE, process.env.TZ, "UTC"]) {
    const v = String(z || "").trim().replace(/^:/, "");
    if (!v) continue;
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: v });
      return v;
    } catch {
      /* next */
    }
  }
  return "UTC";
}

export const TIME_ZONE = pick();

/** Short label for the UI: "Europe/Berlin" → "Berlin", "UTC" → "UTC". */
export const TZ_LABEL = TIME_ZONE.split("/").pop().replace(/_/g, " ");
