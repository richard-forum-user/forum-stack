import json
import os
import sqlite3
from datetime import datetime, timezone

import requests

REPORT_PATH = "/home/forum-user1/Desktop/forum-egress/report.json"
LIFECYCLE_DB = "/home/forum-user1/Desktop/forum-ai/database_syncs/forum_inbound.db"
WORKER_URL = os.environ.get("FORUM_EGRESS_URL", "").strip()
SECRET = os.environ.get("FORUM_SECRET", "").strip()


def may_publish():
    if not os.path.exists(REPORT_PATH):
        return False, "no report file"
    with open(REPORT_PATH, encoding="utf-8") as f:
        data = json.load(f)
    report_id = data.get("metadata", {}).get("timestamp")
    if not report_id or not os.path.exists(LIFECYCLE_DB):
        return True, "no lifecycle db"
    conn = sqlite3.connect(LIFECYCLE_DB)
    row = conn.execute(
        "SELECT status, review_ends_at FROM report_lifecycle WHERE report_id = ?",
        (report_id,),
    ).fetchone()
    conn.close()
    if not row:
        return True, "no lifecycle row"
    status, review_ends = row
    if status == "published":
        return True, "published"
    if review_ends and review_ends <= datetime.now(timezone.utc).isoformat():
        return True, "review elapsed"
    return False, f"report in review until {review_ends}"


def push_to_cloudflare():
    if not WORKER_URL:
        print("SKIP: FORUM_EGRESS_URL not set (local report.json only).")
        return
    if not SECRET:
        print("ERROR: FORUM_SECRET not set.")
        return
    if not os.path.exists(REPORT_PATH):
        print(f"ERROR: {REPORT_PATH} not found. Run aggregate first.")
        return

    ok, reason = may_publish()
    if not ok:
        print(f"SKIP egress push: {reason}")
        data = json.load(open(REPORT_PATH, encoding="utf-8"))
        data["metadata"]["status"] = "review"
        data["metadata"]["publish_blocked_reason"] = reason
        with open(REPORT_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return

    with open(REPORT_PATH, encoding="utf-8") as f:
        data = json.load(f)
    data["metadata"]["status"] = "published"

    headers = {
        "Content-Type": "application/json",
        "X-Forum-Secret": SECRET,
    }

    print(f"--- Pushing to {WORKER_URL} ---")
    try:
        response = requests.post(WORKER_URL, json=data, headers=headers, timeout=60)
        if response.status_code == 200:
            print("SUCCESS: Report cleared egress.")
        else:
            print(f"FAILED: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"CONNECTION ERROR: {e}")


if __name__ == "__main__":
    push_to_cloudflare()
