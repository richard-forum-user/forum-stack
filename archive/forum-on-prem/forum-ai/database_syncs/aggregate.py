import sqlite3, json, os
from collections import Counter
from datetime import datetime

DB_PATH = '/home/forum-user1/Desktop/forum-ai/database_syncs/forum_inbound.db'
EGRESS_DIR = '/home/forum-user1/Desktop/forum-egress'

CATEGORY_LABELS = {
    1: "Physiological / Physical Infrastructure",
    2: "Safety & Services",
    3: "Community & Belonging",
    4: "Civic / Governance",
}

def fmt_number(value):
    if value is None:
        return "n/a"
    return f"{float(value):.2f}".rstrip("0").rstrip(".")

def build_category_report(category_id, count, avg_valence, avg_activation, evidence_rows):
    label = CATEGORY_LABELS.get(category_id, f"Category {category_id}")
    summaries = [row[0].strip() for row in evidence_rows if row[0] and row[0].strip()]
    summary_counts = Counter(summaries)
    evidence_lines = [
        f"- {text} (observed {n} time{'s' if n != 1 else ''})"
        for text, n in summary_counts.most_common(8)
    ]
    if not evidence_lines:
        evidence_lines = ["- No sanitized evidence rows available for this category."]

    return f"""### Category {category_id}: {label}
Total reports: {count}
Average valence: {fmt_number(avg_valence)}
Average activation: {fmt_number(avg_activation)}

Factual summary:
This category contains {count} sanitized report{'s' if count != 1 else ''}. The evidence below is copied from privacy-preserving summaries in the local analysis database. No raw quotes or inferred resident statements are included.

Sanitized evidence counts:
{chr(10).join(evidence_lines)}"""

def run_aggregation():
    conn = sqlite3.connect(DB_PATH)

    opt_in_row = conn.execute(
        "SELECT COUNT(*) FROM forum_inbound WHERE consent_opt_in = 1"
    ).fetchone()
    opt_in_count = opt_in_row[0] if opt_in_row else 0

    all_reports = []
    total_volume = 0
    
    for t3 in [1, 2, 3, 4]:
        res = conn.execute("""
            SELECT COUNT(*), AVG(valence), AVG(activation) 
            FROM civic_sentiment_v2 WHERE tier_3_id = ?
        """, (t3,)).fetchone()
        
        if res[0] > 0:
            ev = conn.execute("""
                SELECT sanitized_summary FROM civic_sentiment_v2 
                WHERE tier_3_id = ? ORDER BY sanitized_summary
            """, (t3,)).fetchall()

            all_reports.append(build_category_report(t3, res[0], res[1], res[2], ev))
            total_volume += res[0]
            print(f"Processed Category {t3}")

    # Once the loop is done, save everything to a single file
    if all_reports:
        combined_report_text = "\n\n".join(all_reports)
        
        output = {
            "metadata": {
                "project": "The Forum Initiative",
                "timestamp": datetime.now().isoformat(),
                "volume": total_volume,
                "opt_in_count": opt_in_count,
                "policy_version": "coop-data-policy/2026-05-01",
                "status": "review",
                "formation_pilot": True,
                "disclaimer": (
                    "This report aggregates only opt-in civic submissions. "
                    "It is not a census of all residents. Raw contributions are deleted after aggregation per cooperative articles."
                ),
            },
            "report": combined_report_text
        }
        
        os.makedirs(EGRESS_DIR, exist_ok=True)
        with open(f"{EGRESS_DIR}/report.json", "w") as f: 
            json.dump(output, f)
        print("Master report containing all categories egressed successfully.")
    else:
        print("No comments found. Skipping.")

if __name__ == "__main__": run_aggregation()