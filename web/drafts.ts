const prefix = "agent-draft-";
export function readDraft(id: string | null): string {
  try {
    return localStorage.getItem(prefix + (id ?? "new"))?.slice(0, 64000) ?? "";
  } catch {
    return "";
  }
}
export function saveDraft(id: string | null, text: string) {
  try {
    if (text)
      localStorage.setItem(prefix + (id ?? "new"), text.slice(0, 64000));
    else localStorage.removeItem(prefix + (id ?? "new"));
    return true;
  } catch {
    /* The in-memory composer remains usable when browser storage is unavailable. */
    return false;
  }
}
