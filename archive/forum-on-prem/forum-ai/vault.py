import sys, os, base64, sqlite3, json, hashlib
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.fernet import Fernet

PRIVATE_KEY_PATH = "/home/forum-user1/Desktop/forum-ai/private.pem"
DB_PATH = "/home/forum-user1/Desktop/forum-ai/database_syncs/forum_inbound.db"
INIT_SQL = "/home/forum-user1/Desktop/forum-ai/database_syncs/init_schema.sql"


def ensure_schema(conn):
    if os.path.exists(INIT_SQL):
        conn.executescript(open(INIT_SQL).read())
    else:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS forum_inbound (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hashed_email TEXT,
                message TEXT NOT NULL,
                zip_code TEXT,
                receipt_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)


def ingest_civic_v1(payload, conn, fernet):
    """Pod ingress: base64 JSON with type CIVIC_FEEDBACK_V1 (Fernet at rest on node)."""
    hashed = hashlib.sha256(
        f"{payload['receipt_id']}:{payload['zip_code']}".encode()
    ).hexdigest()
    comment = payload["comment"]
    cat = payload.get("category_id")
    if cat is not None:
        comment = f"[category:{cat}] {comment}"
    vault_blob = fernet.encrypt(comment.encode())
    conn.execute(
        "INSERT INTO forum_inbound (hashed_email, message, zip_code, receipt_id) VALUES (?, ?, ?, ?)",
        (hashed, vault_blob.decode(), payload["zip_code"], payload["receipt_id"]),
    )


def ingest_rsa_vault(payload, conn, fernet, private_key):
    hashed_email = payload["hashed_email"]
    c = conn.cursor()
    c.execute(
        "SELECT id FROM forum_inbound WHERE hashed_email = ? AND created_at > datetime('now', '-1 day')",
        (hashed_email,),
    )
    if c.fetchone():
        print("Cooldown active.")
        return False

    encrypted_bytes = base64.b64decode(payload["encrypted_comment"])
    decrypted_msg = private_key.decrypt(
        encrypted_bytes,
        padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    vault_blob = fernet.encrypt(decrypted_msg)
    conn.execute(
        "INSERT INTO forum_inbound (hashed_email, message, zip_code, receipt_id) VALUES (?, ?, ?, ?)",
        (hashed_email, vault_blob.decode(), payload["zip_code"], payload["receipt_id"]),
    )
    return True


def process_ingress():
    if "FERNET_KEY" not in os.environ:
        sys.stderr.write("Error: FERNET_KEY missing from environment\n")
        sys.exit(1)

    fernet = Fernet(os.environ["FERNET_KEY"].encode())
    raw_b64 = sys.argv[1]
    payload = json.loads(base64.b64decode(raw_b64))

    conn = sqlite3.connect(DB_PATH)
    ensure_schema(conn)

    if payload.get("type") == "CIVIC_FEEDBACK_V1":
        ingest_civic_v1(payload, conn, fernet)
    else:
        if not os.path.exists(PRIVATE_KEY_PATH):
            sys.stderr.write(f"Error: Key not found at {PRIVATE_KEY_PATH}\n")
            sys.exit(1)
        with open(PRIVATE_KEY_PATH, "rb") as k:
            private_key = serialization.load_pem_private_key(k.read(), password=None)
        if not ingest_rsa_vault(payload, conn, fernet, private_key):
            conn.close()
            sys.exit(0)

    conn.commit()
    conn.close()
    print("Sync Successful")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        process_ingress()
