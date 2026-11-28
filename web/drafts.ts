const prefix = "agent-draft-";
export function readDraft(id: string | null): string {
  try {
    const key = prefix + (id ?? "new");
    const current = localStorage.getItem(key);
    if (current || id) return current?.slice(0, 64000) ?? "";
    const older = localStorage.getItem(prefix + "new-project");
    if (!older) return "";
    localStorage.setItem(key, older);
    localStorage.removeItem(prefix + "new-project");
    return older.slice(0, 64000);
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
