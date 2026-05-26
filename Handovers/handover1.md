Project Handover Document
1. Core Architecture
ForumAI is now a local-first personal civic data pod with an Android packaging path.

The architecture has three main layers:

Personal Pod
The pod lives in:

/home/forum-user1/Desktop/forum-pod
It is a Vite + React app that runs locally in the browser or inside an Android WebView via Capacitor.

Core features:

Local-first civic submissions.
Durable browser/app storage using IndexedDB.
DuckDB-WASM as the local SQL/query engine.
AI Agent chat that can generate SQL, run read-only SQL locally, and summarize row results in chat.
WebLLM support when WebGPU is available.
Ollama fallback for local desktop/browser development.
Local Data Model
Civic submissions are stored first in IndexedDB, then hydrated into DuckDB tables on startup.

Main local tables:

civic_categories
civic_submissions
civic_submissions includes:

receipt_id
zip_code
category_id
category_label
comment
egress_status
vault_status
sync_attempts
last_error
submitted_at
This fixes the earlier issue where submissions disappeared after refresh. DuckDB is still in-memory, but it is repopulated from IndexedDB every time the pod starts.

Cooperative Server Path
The cooperative server path is:

Forum Pod / Android app
→ /api/civic/submit
→ forum-airlock listener
→ forum-ai/vault.py
→ encrypted forum_inbound.db
→ analysis pipeline
→ forum-egress/report.json
→ optional Cloudflare egress worker
Server-side components:

/home/forum-user1/Desktop/forum-airlock
/home/forum-user1/Desktop/forum-ai
/home/forum-user1/Desktop/forum-egress
The server listener receives civic submissions, verifies AIRLOCK_SECRET, records the payload, and calls vault.py, which writes encrypted rows into:

/home/forum-user1/Desktop/forum-ai/database_syncs/forum_inbound.db
2. Current Exact Project State
The project has been converted from a browser-only prototype into a local-first pod with Android packaging support.

Current state:

PWA/local browser build works.
Local civic submissions persist after refresh through IndexedDB.
DuckDB hydrates from local storage on startup.
AI Agent chat can run generated read-only SQL automatically and summarize rows directly in chat.
Android packaging has been added using Capacitor.
The Android build flow was moved away from Capacitor 8 because Capacitor 8 required Node 22.
The project was pinned toward a Node 20 + Java 17 compatible Capacitor setup.
The Android SDK was installed under:
/home/forum-user1/android-sdk
Java 17 is available via Temurin:
/home/forum-user1/.sdkman/candidates/java/17.0.12-tem
Important note: the last terminal output shown in this chat still had an Android build failure from a Java 21/Capacitor mismatch:

error: invalid source release: 21
The fix applied after that was to update the build script to force Capacitor 6:

npm install @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 --save-dev --save-exact
The next chat should verify whether the final clean build now produces:

/home/forum-user1/Desktop/forum-pod/android/app/build/outputs/apk/debug/app-debug.apk
3. File Structure And Key Scripts
Main Pod App
/home/forum-user1/Desktop/forum-pod
Key files:

forum-pod/src/pod-ui.jsx
forum-pod/src/pod-store.js
forum-pod/src/main.jsx
forum-pod/package.json
forum-pod/capacitor.config.json
forum-pod/vite.config.js
forum-pod/public/manifest.webmanifest
forum-pod/public/service-worker.js
pod-ui.jsx
Main React UI and pod logic.

Responsibilities:

Civic Feedback tab.
Category selection.
Local-first submission flow.
Retry saved submissions.
DuckDB setup and hydration.
AI Agent chat.
Automatic read-only SQL execution inside chat.
Settings tab for Android/server URL.
Important behaviors:

Android app uses a configurable cooperative server URL.
Browser/PWA can use same-origin /api/civic/submit.
Civic submissions are saved locally before sync.
Failed submissions stay local and can be retried.
pod-store.js
IndexedDB storage layer.

Created file:

/home/forum-user1/Desktop/forum-pod/src/pod-store.js
Responsibilities:

Open IndexedDB database:
forum-personal-pod
Store civic submissions.
Patch submission sync status.
Return retryable submissions.
Clear local submissions if needed.
Key exported functions:

openPodStore()
getSubmissions()
saveSubmission(row)
patchSubmission(receiptId, patch)
getRetryableSubmissions()
clearAllSubmissions()
Capacitor Config
Created file:

/home/forum-user1/Desktop/forum-pod/capacitor.config.json
Purpose:

Defines Android app ID and app name.
Uses dist as the web directory.
Configures Capacitor Android wrapper.
Expected app ID:

forum.personalpod
Expected app name:

Forum Personal Pod
Android Build Script
Created file:

/home/forum-user1/Desktop/deploy/build-android-apk.sh
Purpose:

Detect Java path.
Set Android SDK environment variables.
Install dependencies.
Force install Capacitor 6.
Build Vite web assets.
Generate Android project if missing.
Sync Capacitor assets.
Run Gradle debug APK build.
Important command:

bash ~/Desktop/deploy/build-android-apk.sh
Expected output APK:

~/Desktop/forum-pod/android/app/build/outputs/apk/debug/app-debug.apk
Server Install Script
Created file:

/home/forum-user1/Desktop/deploy/install-forum-server.sh
Purpose:

Install dependencies.
Build PWA.
Install systemd user services.
Enable listener and analysis timer.
Phone Access / Cloudflare Tunnel Scripts
Created files:

/home/forum-user1/Desktop/deploy/install-phone-access.sh
/home/forum-user1/Desktop/deploy/forum-cloudflared.service
/home/forum-user1/Desktop/deploy/cloudflared-forum.yml.example
These were added for PWA phone access through Cloudflare Tunnel, but the user later decided to prioritize an Android app instead.

Systemd Services
Created files:

/home/forum-user1/Desktop/deploy/forum-airlock-listener.service
/home/forum-user1/Desktop/deploy/forum-analysis.service
/home/forum-user1/Desktop/deploy/forum-analysis.timer
Purpose:

Run the local airlock listener without keeping a terminal open.
Run analysis periodically.
Documentation
Created files:

/home/forum-user1/Desktop/README-PERSONAL-POD.md
/home/forum-user1/Desktop/README-ANDROID-APP.md
README-ANDROID-APP.md documents:

Server URL setup inside the app.
APK build prerequisites.
APK build command.
APK install command.
Troubleshooting for Node/Java/Capacitor issues.
4. Important Environment State
Android SDK
Set these before Android builds:

export ANDROID_HOME=$HOME/android-sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
Java
Java is already installed:

java -version
Expected:

openjdk version "17.0.12"
Temurin-17.0.12
Avoid using the invalid path:

/usr/lib/jvm/java-17-openjdk-amd64
If needed:

unset JAVA_HOME
The build script auto-detects Java from which java.

Capacitor
Do not run:

npm install @capacitor/android
That may pull the latest Capacitor and recreate Node/Java mismatch problems.

Use the pinned command:

npm install @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 --save-dev --save-exact
5. Immediate Next Steps
Step 1: Clean And Rebuild APK
Run:

cd ~/Desktop/forum-pod
rm -rf node_modules package-lock.json android
unset JAVA_HOME
export ANDROID_HOME=$HOME/android-sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
bash ~/Desktop/deploy/build-android-apk.sh
Check for APK:

ls -lh ~/Desktop/forum-pod/android/app/build/outputs/apk/debug/app-debug.apk
Step 2: Install APK To Phone
If phone is connected with USB debugging:

adb devices
adb install -r ~/Desktop/forum-pod/android/app/build/outputs/apk/debug/app-debug.apk
Step 3: Configure App Server URL
Inside Android app:

Open Settings.
Enter cooperative server URL, for example:
https://pod.yourdomain.com
or whatever route exposes /api/civic/submit.

Tap Save connection.
Tap Retry saved submissions now if needed.
The app submits to:

<server-url>/api/civic/submit
Step 4: Verify Local-First Behavior
In the Android app:

Submit Civic Feedback.
Close and reopen the app.
Ask AI Agent:
tell me about my latest submission
Expected:

Submission remains available locally.
AI Agent queries civic_submissions.
Row info is returned in chat.
If server is online, egress_status should become transmitted.
If server is offline, egress_status should remain failed or pending until retry.
Step 5: Verify Server Ingestion
On the server:

sqlite3 ~/Desktop/forum-ai/database_syncs/forum_inbound.db \
  "SELECT id, zip_code, receipt_id, created_at FROM forum_inbound ORDER BY created_at DESC LIMIT 5;"
Expected:

New Android submissions appear encrypted in forum_inbound.db.
6. Known Issues / Warnings
Capacitor Version Mismatch
Symptoms:

The Capacitor CLI requires NodeJS >=22.0.0
Cause:

Capacitor 8 installed.
Fix:

rm -rf node_modules package-lock.json android
npm install @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 --save-dev --save-exact
Java Version Mismatch
Symptoms:

error: invalid source release: 21
Cause:

Android project generated by newer Capacitor/Gradle expecting Java 21.
Fix:

rm -rf android
bash ~/Desktop/deploy/build-android-apk.sh
after ensuring Capacitor 6 is installed.

Invalid JAVA_HOME
Symptoms:

JAVA_HOME is set to an invalid directory: /usr/lib/jvm/java-17-openjdk-amd64
Fix:

unset JAVA_HOME
Then run the build script.

android/ Missing
Symptoms:

cd: android: No such file or directory
Cause:

npx cap add android failed earlier.
Fix:

bash ~/Desktop/deploy/build-android-apk.sh
7. Strategic Next Goals
After APK builds successfully:

Test install on an actual Android phone.
Confirm IndexedDB persistence across app restarts.
Confirm civic sync to /api/civic/submit.
Decide whether the cooperative server URL should be:
entered manually in Settings,
baked into .env,
selected by QR code,
or discovered through a registration link.
Add signing/release build process for non-debug APK distribution.
Consider replacing WebLLM in Android builds with server/Ollama-only mode to reduce bundle size.
Consider adding export/import backup for local pod data.
8. Current Mental Model
The Android app should now be treated as the primary downloadable “personal pod.”

The web/PWA path still exists, but Android is the active packaging direction.

The important invariant is:

Local first, sync second.
Every civic submission should be saved locally before attempting network sync, and the user should be able to view/query their own local history even if the cooperative server is unreachable.