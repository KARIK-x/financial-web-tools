"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = localStorage.getItem("finance-tracker-theme");
    const initial = stored === "dark" ? "dark" : "light";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("finance-tracker-theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      <span className="theme-toggle-track">
        <span className={`theme-toggle-thumb ${theme === "dark" ? "is-dark" : ""}`} />
      </span>
      <span className="tiny">{theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
