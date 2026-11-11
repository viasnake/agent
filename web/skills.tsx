import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { SkillsView } from "../src/skills.js";

export function Skills() {
  const [view, setView] = useState<SkillsView>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setError("");
    setView(undefined);
    void api<SkillsView>("/api/skills").then(
      (value) => {
        if (current) setView(value);
      },
      (e: Error) => {
        if (current) setError(e.message);
      },
    );
    return () => {
      current = false;
    };
  }, [revision]);
  return (
    <section aria-label="Skills 一覧">
      <button
        type="button"
        className="btn btn-outline-secondary"
        onClick={() => setRevision((v) => v + 1)}
      >
        再読み込み
      </button>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p role="status">読み込み中…</p>}
      {view?.errors.map((message) => (
        <p key={message} role="alert">
          {message}
        </p>
      ))}
      {view?.skills.length === 0 && <p>Skills はありません</p>}
      {view?.skills.map((skill) => (
        <article className="settings-card" key={skill.name}>
          <h2>{skill.name}</h2>
          <p>{skill.state === "ready" ? "利用可能" : "読み込みエラー"}</p>
          {skill.description && <p>{skill.description}</p>}
          {skill.compatibility && <p>互換性: {skill.compatibility}</p>}
          {skill.error && <p role="alert">{skill.error}</p>}
        </article>
      ))}
    </section>
  );
}
