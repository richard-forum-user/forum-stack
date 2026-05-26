import { useEffect, useMemo, useState } from "react";

const PAGES = [
  { file: "manifesto.md", label: "Manifesto" },
  { file: "inside-the-kami.md", label: "Inside the Kami" },
  { file: "1.md", label: "Pack 1: Attentiveness" },
  { file: "2.md", label: "Pack 2: Responsibility" },
  { file: "3.md", label: "Pack 3: Competence" },
  { file: "4.md", label: "Pack 4: Responsiveness" },
  { file: "5.md", label: "Pack 5: Solidarity" },
  { file: "6.md", label: "Pack 6: Symbiosis" },
  { file: "measures.md", label: "Measures" },
  { file: "faq.md", label: "FAQ" },
  { file: "ai-alignment-cannot-be-top-down.md", label: "AI Alignment Cannot Be Top-Down" },
];

function civicAiAssetUrl(file) {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/?$/, "/")}civic-ai/${file}`;
}

function stripFrontmatter(markdown) {
  return String(markdown || "").replace(/^---[\s\S]*?---\s*/, "");
}

function renderMarkdownLite(markdown) {
  return stripFrontmatter(markdown)
    .split("\n")
    .map((line, index) => {
      if (!line.trim()) return <div key={index} style={{ height: 8 }} />;
      if (line.startsWith("# ")) {
        return <h2 key={index} style={{ color: "#e6edf3", fontSize: 20, margin: "10px 0" }}>{line.slice(2)}</h2>;
      }
      if (line.startsWith("## ")) {
        return <h3 key={index} style={{ color: "#e6edf3", fontSize: 15, margin: "14px 0 6px" }}>{line.slice(3)}</h3>;
      }
      if (line.startsWith("- ")) {
        return <div key={index} style={{ margin: "5px 0 5px 18px", color: "#c9d1d9" }}>- {line.slice(2)}</div>;
      }
      return <p key={index} style={{ margin: "7px 0", lineHeight: 1.65, color: "#c9d1d9" }}>{line}</p>;
    });
}

export default function CivicAiReader() {
  const [selected, setSelected] = useState(PAGES[0].file);
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState(null);

  const selectedPage = useMemo(
    () => PAGES.find((page) => page.file === selected) || PAGES[0],
    [selected]
  );

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    fetch(civicAiAssetUrl(selectedPage.file))
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load ${selectedPage.file}`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setMarkdown(text);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPage.file]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: 14, minHeight: 0, flex: 1 }}>
      <div style={{ border: "1px solid #21262d", borderRadius: 8, overflow: "hidden", background: "#0d1117" }}>
        {PAGES.map((page) => (
          <button
            key={page.file}
            type="button"
            onClick={() => setSelected(page.file)}
            style={{
              width: "100%",
              padding: "9px 10px",
              textAlign: "left",
              background: selected === page.file ? "#161b22" : "transparent",
              border: 0,
              borderBottom: "1px solid #161b22",
              color: selected === page.file ? "#e6edf3" : "#8b949e",
              fontFamily: "inherit",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {page.label}
          </button>
        ))}
      </div>
      <div style={{ border: "1px solid #21262d", borderRadius: 8, background: "#0d1117", padding: 18, overflow: "auto" }}>
        <div style={{ fontSize: 10, color: "#58a6ff", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          Civic AI / 6-Pack of Care
        </div>
        {error ? (
          <div style={{ color: "#f85149" }}>{error}</div>
        ) : (
          renderMarkdownLite(markdown)
        )}
      </div>
    </div>
  );
}
