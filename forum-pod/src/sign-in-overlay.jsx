import { useMemo, useState } from "react";
import {
  clearMemberProfile,
  createPodFlow,
  getPodProviderUrl,
  loadMemberProfile,
  setPodProviderUrl,
  unlockPodFlow,
  webAuthnSupported,
} from "./pod-solid-integration.js";
import { getPodPlatform, isNativePodPlatform, isAirlockWebApp } from "./pod-adapter.js";
import { buildLocalDeviceProfile } from "./webauthn-member.js";
import { saveMemberProfile } from "./member-store.js";
import { regenerateSigningKey } from "./pod-signing.js";
import { recoverWithPhrase, rebindAfterRecovery } from "./recovery-api.js";
import { setPilotUnlock } from "./unlock-session.js";

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(9, 11, 15, 0.92)",
  padding: 24,
};

const panelStyle = {
  width: "100%",
  maxWidth: 440,
  padding: "28px 24px",
  borderRadius: 12,
  border: "1px solid #21262d",
  background: "#0d1117",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginBottom: 12,
  borderRadius: 6,
  border: "1px solid #30363d",
  background: "#161b22",
  color: "#e6edf3",
  fontFamily: "inherit",
  fontSize: 13,
};

const btn = (primary, disabled) => ({
  width: "100%",
  padding: "12px 16px",
  marginBottom: 10,
  borderRadius: 8,
  border: primary ? "1px solid #1f6feb" : "1px solid #30363d",
  background: primary ? "#1f6feb" : "#21262d",
  color: disabled ? "#484f58" : "#fff",
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});

export default function SignInOverlay({
  defaultPodProvider,
  cooperativeUrl,
  onSignedIn,
  runBtnStyle,
}) {
  const [podProviderUrl, setPodProviderUrlState] = useState(
    () => localStorage.getItem("forum.podProviderUrl") || defaultPodProvider || getPodProviderUrl()
  );
  const [showAdvanced, setShowAdvanced] = useState(
    () => localStorage.getItem("forum.showPodAdvanced") === "1"
  );
  const [showRecover, setShowRecover] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const native = useMemo(() => {
    if (isAirlockWebApp()) return true;
    const platform = getPodPlatform();
    if (isNativePodPlatform()) return true;
    if (typeof window !== "undefined" && window.location) {
      const { protocol, hostname } = window.location;
      if (protocol === "file:" || protocol === "capacitor:") return true;
      if (
        (protocol === "http:" || protocol === "https:") &&
        (hostname === "localhost" || hostname === "127.0.0.1")
      ) {
        return true;
      }
    }
    return platform !== "browser";
  }, []);

  const coop = (cooperativeUrl || "").trim().replace(/\/$/, "");

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    setStatus({ ok: true, text: "Starting Pod creation..." });
    try {
      setPodProviderUrl(podProviderUrl);
      localStorage.setItem(
        "forum.podProviderUrl",
        podProviderUrl.trim().replace(/\/$/, "")
      );
      setStatus({ ok: true, text: "Creating device credential..." });
      await createPodFlow({ podProviderUrl, cooperativeUrl: coop });
      setStatus({ ok: true, text: "Signed in. Loading your Pod..." });
      const session = await import("./solid-session.js").then((m) =>
        m.getSolidSession()
      );
      if (session.isLoggedIn) {
        onSignedIn();
      } else {
        setError(
          "Pod created but session did not initialise. Try Sign in to existing Pod."
        );
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    setStatus({ ok: true, text: "Unlocking your Pod..." });
    try {
      setPodProviderUrl(podProviderUrl);
      localStorage.setItem(
        "forum.podProviderUrl",
        podProviderUrl.trim().replace(/\/$/, "")
      );
      const profile = loadMemberProfile();
      if (profile?.credential_id) {
        await unlockPodFlow(coop);
      } else {
        setError(
          "No device credential found on this device. Tap Create a new Pod first."
        );
        return;
      }
      const session = await import("./solid-session.js").then((m) =>
        m.getSolidSession()
      );
      if (session.isLoggedIn) {
        onSignedIn();
      } else {
        setError("Sign-in did not complete. Try again.");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRecover = async () => {
    if (!recoveryPhrase.trim()) {
      setError("Enter your 12-word recovery phrase.");
      return;
    }
    if (!coop) {
      setError("Cooperative URL is not configured.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus({ ok: true, text: "Verifying recovery phrase…" });
    try {
      const data = await recoverWithPhrase(recoveryPhrase.trim());
      setStatus({ ok: true, text: "Identity verified. Re-binding this device…" });

      clearMemberProfile();
      const { credentialId } = buildLocalDeviceProfile();
      const meta = await regenerateSigningKey();
      await rebindAfterRecovery({
        recoveryPublicKeyHex: data.recoveryPublicKeyHex,
        rebindToken: data.rebind_token,
        newPublicKeyHex: meta.publicKeyHex,
        newSessionId: meta.sessionId,
      });

      if (coop) {
        await fetch(`${coop}/api/register-signing-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: meta.sessionId,
            public_key_hex: meta.publicKeyHex,
          }),
        });
      }

      const slug = (credentialId.replace(/[^a-zA-Z0-9]/g, "x") || `m${Date.now()}`).slice(0, 24);
      const podRoot = `recovered://forum-personal-pod/forum-members/${slug}/`;
      const webId = `${podRoot}profile/card#me`;
      saveMemberProfile({
        credential_id: credentialId,
        webId,
        podRoot,
        civicContainer: `${podRoot}civic/`,
        sessionId: meta.sessionId,
        slug,
        auth_mode: "recovered",
        recovered_at: new Date().toISOString(),
      });
      setPilotUnlock(credentialId);

      const { solidLogin } = await import("./solid-session.js");
      await solidLogin(webId);

      setStatus({
        ok: true,
        text: `Recovered ${data.receipts?.length || 0} submission proof(s). Raw content is not restored — use your export if you have one.`,
      });
      setShowRecover(false);
      onSignedIn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#e6edf3", marginBottom: 8 }}>
          {showRecover ? "Recover with phrase" : "Sign in to your Pod"}
        </div>
        <p style={{ fontSize: 12, color: "#8b949e", lineHeight: 1.55, marginBottom: 12 }}>
          {showRecover
            ? "Enter the 12-word recovery phrase you saved when you enrolled. This restores your cooperative identity and submission proofs — not raw comment text."
            : native
              ? isAirlockWebApp()
                ? "Your data stays in this browser until you download a copy. Opt in to share with the cooperative when you're ready — raw text is wiped from the cloud after 7 days; only aggregates remain."
                : "Your journal, submissions, and personal data live in an on-device Pod (encrypted SQLite). Nothing leaves this device unless you opt in to share with the cooperative."
              : "Your journal, submissions, and personal data live in your Personal Pod (Cloudflare Durable Object), keyed to a WebAuthn passkey on this device. This device may cache encrypted copies while you are signed in; signing out or locking clears signing keys from memory."}
        </p>
        {native && !showRecover && (
          <div
            style={{
              fontSize: 11,
              color: "#3fb950",
              border: "1px solid #2ea04330",
              background: "#122119",
              padding: "8px 10px",
              borderRadius: 6,
              marginBottom: 14,
            }}
          >
            {isAirlockWebApp()
              ? "Web app ready. No passkey or app download required — create a Pod to start, then download your data from Settings."
              : "On-device Pod ready. No airlock or trial period; passkey not required."}
          </div>
        )}

        {showRecover ? (
          <>
            <textarea
              value={recoveryPhrase}
              onChange={(e) => setRecoveryPhrase(e.target.value)}
              placeholder="Enter your 12-word recovery phrase…"
              style={{ ...inputStyle, minHeight: 88, fontFamily: "monospace", fontSize: 12 }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={handleRecover}
              style={runBtnStyle ? runBtnStyle(busy) : btn(true, busy)}
            >
              {busy ? "Recovering…" : "Recover identity"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowRecover(false);
                setRecoveryPhrase("");
                setError(null);
                setStatus(null);
              }}
              style={btn(false, busy)}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={handleCreate}
              style={runBtnStyle ? runBtnStyle(busy) : btn(true, busy)}
            >
              {busy ? "Working…" : "Create a new Pod"}
            </button>
            {!native && !webAuthnSupported() && (
              <p style={{ fontSize: 10, color: "#f0b72f", lineHeight: 1.45, margin: "-2px 0 10px" }}>
                Passkey API is not exposed by this WebView. Enable VITE_ALLOW_PILOT_FALLBACK=1 at build time for a device-local fallback credential.
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={handleSignIn}
              style={btn(false, busy)}
            >
              Sign in to existing Pod
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowRecover(true);
                setError(null);
                setStatus(null);
              }}
              style={btn(false, busy)}
            >
              Lost your device? Recover with phrase
            </button>

            {!native && (
              <button
                type="button"
                onClick={() => {
                  const next = !showAdvanced;
                  setShowAdvanced(next);
                  localStorage.setItem("forum.showPodAdvanced", next ? "1" : "0");
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#58a6ff",
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  padding: "8px 0",
                  marginBottom: showAdvanced ? 8 : 0,
                }}
              >
                {showAdvanced ? "Hide advanced" : "Advanced: Pod provider URL"}
              </button>
            )}

            {showAdvanced && !native && (
              <>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>
                  Pod provider URL
                </label>
                <input
                  value={podProviderUrl}
                  onChange={(e) => setPodProviderUrlState(e.target.value)}
                  placeholder="https://airlock.yourcommunity.forum"
                  style={inputStyle}
                />
                <p style={{ fontSize: 10, color: "#484f58", lineHeight: 1.5, margin: "0 0 6px" }}>
                  Pod data lives in a Cloudflare Durable Object addressed by your device key. The build-time VITE_SERVER_URL takes precedence over this field unless they share a host.
                </p>
                <p style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.5, margin: "0 0 10px" }}>
                  Next request will hit: <code style={{ color: "#79c0ff" }}>{getPodProviderUrl()}/api/pod</code>
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearMemberProfile();
                    localStorage.removeItem("forum.solidSession");
                    localStorage.removeItem("forum.podProviderUrl");
                    setPodProviderUrlState(getPodProviderUrl());
                    setStatus({
                      ok: true,
                      text: "Local Pod state cleared. Tap Create a new Pod.",
                    });
                    setError(null);
                  }}
                  style={{
                    ...btn(false, busy),
                    fontSize: 12,
                    padding: "8px 12px",
                    marginBottom: 4,
                  }}
                >
                  Clear local Pod state
                </button>
              </>
            )}
          </>
        )}

        {error && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 6,
              fontSize: 12,
              background: "#3d1c1c",
              border: "1px solid #6e3030",
              color: "#f85149",
            }}
          >
            {error}
          </div>
        )}
        {status && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 6,
              fontSize: 12,
              background: status.ok ? "#122119" : "#3d1c1c",
              border: `1px solid ${status.ok ? "#2ea04330" : "#6e3030"}`,
              color: status.ok ? "#3fb950" : "#f85149",
            }}
          >
            {status.text}
          </div>
        )}
      </div>
    </div>
  );
}
