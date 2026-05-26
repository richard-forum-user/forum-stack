import sqlite3, os, sys, hashlib, re, json
from cryptography.fernet import Fernet
import requests
from concurrent.futures import ThreadPoolExecutor

# CONFIGURATION
DB_PATH = '/home/forum-user1/Desktop/forum-ai/database_syncs/forum_inbound.db'
OLLAMA_URL = os.environ.get("OLLAMA_GENERATE_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "smart-analyst")
BATCH_SIZE = int(os.environ.get("ANALYSIS_BATCH_SIZE", "5"))
MAX_WORKERS = int(os.environ.get("ANALYSIS_WORKERS", "1"))

def call_ollama(system, prompt):
    payload = {
        "model": OLLAMA_MODEL,
        "system": system,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.0, "num_ctx": 4096}
    }
    try:
        r = requests.post(OLLAMA_URL, json=payload, timeout=90)
        return r.json().get('response', '').strip()
    except Exception: return ""

def setup_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS civic_sentiment_v2 (
            msg_hash TEXT PRIMARY KEY,
            tier_1_id INTEGER,
            tier_2_id INTEGER,
            tier_3_id INTEGER,
            valence REAL,
            activation REAL,
            sanitized_summary TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.close()

def process_batch(rows, fernet):
    results = []
    for row in rows:
        _, encrypted_msg = row
        try:
            msg = fernet.decrypt(encrypted_msg.encode()).decode()
            msg_hash = hashlib.sha256(msg.encode()).hexdigest()

            # Pass 1: Need ID (Maslow)
            p1_sys = "You are a rigid classification engine. Return ONLY the Tier 3 ID number (1=Physiological, 2=Safety, 3=Belonging, 4=Esteem). No text."
            t3_raw = call_ollama(p1_sys, msg)
            t3 = int(re.search(r'[1-4]', t3_raw).group()) if re.search(r'[1-4]', t3_raw) else 1

            # Pass 2: Sentiment Tuple (Wilcox)
            p2_sys = "You are a mechanical sentiment analyzer. Return ONLY a 4-point array [Tier_1_ID, Tier_2_ID, Valence, Activation]. No text."
            p2_raw = call_ollama(p2_sys, msg)
            nums = re.findall(r'-?\d+\.?\d*', p2_raw)
            t1, t2, v, a = (int(nums[0]), int(nums[1]), float(nums[2]), float(nums[3])) if len(nums) >= 4 else (0,0,0,0)

            # Pass 3: Distillation (Zero-Knowledge)
            p3_sys = "You are a privacy-enforcing municipal data extractor. Extract the physical municipal failure described. Remove all names, addresses, and identifying narratives. Output ONLY a sterile, factual summary."
            payload = f"Text: {msg}\nNeed: {t3}\nVector: [{v},{a}]"
            sanitized = call_ollama(p3_sys, payload)

            results.append((msg_hash, t1, t2, t3, v, a, sanitized))
            print(f"Distilled: {msg_hash[:8]}... | T3: {t3} | V: {v}")
            
            # RAM FLUSH: Destroy decrypted text from local scope
            del msg 
        except Exception: continue
    return results

def run():
    key = os.environ.get('FERNET_KEY')
    if not key: sys.exit("ERROR: FERNET_KEY missing.")
    setup_db()
    fernet = Fernet(key.encode())
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT zip_code, message FROM forum_inbound").fetchall()
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as exc:
        batches = [rows[i:i+BATCH_SIZE] for i in range(0, len(rows), BATCH_SIZE)]
        all_res = list(exc.map(lambda b: process_batch(b, fernet), batches))
    
    flat = [item for sublist in all_res for item in sublist]
    conn.executemany("INSERT OR IGNORE INTO civic_sentiment_v2 VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)", flat)
    conn.commit()
    conn.close()

if __name__ == "__main__": run()