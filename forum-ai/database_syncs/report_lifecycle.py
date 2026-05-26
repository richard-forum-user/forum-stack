#!/usr/bin/env python3
"""Articles Art VII: review period, publish gate, raw wipe, participant registry."""
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

DB_PATH = "/home/forum-user1/Desktop/forum-ai/database_syncs/forum_inbound.db"
REPORT_PATH = "/home/forum-user1/Desktop/forum-egress/report.json"
REVIEW_DAYS = 7


def ensure_tables(conn):
    init_sql = os.path.join(os.path.dirname(__file__), "init_schema.sql")
    if os.path.exists(init_sql):
        conn.executescript(open(init_sql, encoding="utf-8").read())


def register_report_from_aggregate():
    if not os.path.exists(REPORT_PATH):
        print("SKIP lifecycle: no report.json")
        return
    with open(REPORT_PATH, encoding="utf-8") as f:
        data = json.load(f)
    meta = data.get("metadata", {})
    report_id = meta.get("timestamp", datetime.now(timezone.utc).isoformat())
    review_ends = (datetime.now(timezone.utc) + timedelta(days=REVIEW_DAYS)).isoformat()
    opt_in = meta.get("opt_in_count", meta.get("volume", 0))
    policy = meta.get("policy_version", "coop-data-policy/2026-05-01")

    conn = sqlite3.connect(DB_PATH)
    ensure_tables(conn)
    conn.execute(
        """INSERT OR REPLACE INTO report_lifecycle
           (report_id, status, review_ends_at, opt_in_count, policy_version)
           VALUES (?, 'review', ?, ?, ?)""",
        (report_id, review_ends, opt_in, policy),
    )
    conn.commit()

    rows = conn.execute(
        "SELECT receipt_id, web_id FROM forum_inbound WHERE consent_opt_in = 1 AND wiped_at IS NULL"
    ).fetchall()
    for receipt_id, web_id in rows:
        hashed = None
        if web_id:
            import hashlib
            hashed = hashlib.sha256(web_id.encode()).hexdigest()[:16]
        conn.execute(
            """INSERT OR IGNORE INTO report_participants (report_id, receipt_id, web_id, hashed_participant)
               VALUES (?, ?, ?, ?)""",
            (report_id, receipt_id, web_id, hashed),
        )
    conn.commit()
    conn.close()
    print(f"Report {report_id} in review until {review_ends}")


def publish_ready_reports():
    conn = sqlite3.connect(DB_PATH)
    ensure_tables(conn)
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        """SELECT report_id FROM report_lifecycle
           WHERE status = 'review' AND review_ends_at <= ?""",
        (now,),
    )
    ids = [r[0] for r in cur.fetchall()]
    for rid in ids:
        conn.execute(
            "UPDATE report_lifecycle SET status = 'published', published_at = ? WHERE report_id = ?",
            (now, rid),
        )
    conn.commit()
    conn.close()
    return ids


def wipe_raw_after_publish():
    conn = sqlite3.connect(DB_PATH)
    ensure_tables(conn)
    published = conn.execute(
        "SELECT report_id FROM report_lifecycle WHERE status = 'published' AND published_at IS NOT NULL"
    ).fetchall()
    wiped = 0
    for (report_id,) in published:
        receipts = conn.execute(
            "SELECT receipt_id FROM report_participants WHERE report_id = ?",
            (report_id,),
        ).fetchall()
        for (receipt_id,) in receipts:
            conn.execute(
                "UPDATE forum_inbound SET message = '[wiped]', wiped_at = ? WHERE receipt_id = ? AND wiped_at IS NULL",
                (datetime.now(timezone.utc).isoformat(), receipt_id),
            )
            wiped += conn.total_changes
    conn.commit()
    conn.close()
    print(f"Wipe pass complete (rows touched: {wiped})")


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "register"
    if cmd == "register":
        register_report_from_aggregate()
    elif cmd == "publish":
        ids = publish_ready_reports()
        print(f"Published reports: {ids}")
        wipe_raw_after_publish()
    else:
        print("Usage: report_lifecycle.py [register|publish]")
