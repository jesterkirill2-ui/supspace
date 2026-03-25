// Shared date and duration helpers for SUP dashboards
function parseDate(s) {
  if (!s || !s.trim()) return null;
  const m = s.trim().match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
}

function parseHistoryDate(s) {
  if (!s || !s.trim()) return null;
  const m = s.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
}

function fmtDate(d) {
  if (!d) return null;
  return d.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function diffMs(d1, d2) {
  return !d1 || !d2 || d2 - d1 < 0 ? null : d2 - d1;
}

function diffHours(d1, d2) {
  const ms = diffMs(d1, d2);
  return ms === null ? null : ms / 3600000;
}

function fmtDur(ms) {
  if (ms === null || ms === undefined) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} хв`;
  const hrs = +(ms / 3600000).toFixed(1);
  if (hrs < 24) return `${hrs} год`;
  return `${+(hrs / 24).toFixed(1)} д`;
}

function fmtDurCompact(ms) {
  if (ms === null || ms === undefined) return "—";
  const mins = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  if (!hours) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function fmtDurH(h) {
  return h === null ? null : fmtDur(h * 3600000);
}

function fmtShortDate(d) {
  if (!d) return "—";
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
}
