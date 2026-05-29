import React, { useEffect, useState, useCallback } from "react";
import { ownershipMode, podRpc } from "./pod-adapter.js";

/**
 * TrialPodBanner — shown only when the device is connected to a
 * cooperative-managed trial pod. Listens for the `X-Pod-Trial-Status`
 * header surfaced by the HTTP adapter and links the user to the
 * graduate-to-local-install flow.
 *
 * The banner self-dismisses if the user has already graduated, has
 * never hit a trial pod, or is on a self-hosted desktop/mobile
 * install.
 */
const DISMISS_KEY = "forum.trialBanner.dismissedAt";

function parseStatus(header) {
  if (!header) return null;
  if (header === "graduated") return { graduated: true };
  const out = { graduated: false };
  for (const part of header.split(";")) {
    const [k, v] = part.split("=");
    if (k && v != null) {
      const n = Number(v);
      out[k.trim()] = Number.isFinite(n) ? n : v;
    }
  }
  return out;
}

function recentlyDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return at && Date.now() - at < 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export default function TrialPodBanner() {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(async () => {
    if (ownershipMode() !== "trial") return;
    try {
      const body = await podRpc("GET", "/membership/trial-status");
      if (body && body.kind === "trial") {
        setStatus({
          banner: body.age_days >= (body.banner_after_days || 7) ? 1 : 0,
          wipe_in_days: body.wipe_in_days,
          graduated: !!body.graduated,
        });
      }
    } catch {
      /* not signed in yet, or non-trial pod responded 404 — ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    const onHeader = (e) => {
      const parsed = parseStatus(e?.detail?.status);
      if (parsed) setStatus((prev) => ({ ...(prev || {}), ...parsed }));
    };
    window.addEventListener("pod:trial-status", onHeader);
    return () => window.removeEventListener("pod:trial-status", onHeader);
  }, [refresh]);

  if (ownershipMode() !== "trial") return null;
  if (!status) return null;
  if (status.graduated) return null;
  if (status.banner !== 1 && !(status.wipe_in_days <= 7)) return null;
  if (recentlyDismissed() && status.wipe_in_days > 7) return null;

  const wipeIn = status.wipe_in_days != null ? Number(status.wipe_in_days) : null;
  const urgent = wipeIn != null && wipeIn <= 7;

  const onDismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setStatus({ ...(status || {}), banner: 0 });
  };

  return (
    <div
      role="alert"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: urgent ? "#3a1818" : "#1c2230",
        borderBottom: `1px solid ${urgent ? "#ff6b6b" : "#3b4a66"}`,
        color: "#f1f5f9",
        padding: "10px 16px",
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: "1 1 320px" }}>
        <strong style={{ marginRight: 6 }}>
          {urgent ? "Trial pod wiping soon." : "Move to your own Pod."}
        </strong>
        {urgent && wipeIn != null
          ? `In ${wipeIn} day${wipeIn === 1 ? "" : "s"} this trial pod
             auto-deletes everything you've stored here. Install the desktop
             or phone app to keep your data.`
          : `You're using the cooperative's trial pod. Install Forum Pod on
             your own device to own your data permanently.`}
      </span>
      <a
        href="https://github.com/richard-forum-user/forum-stack/releases/latest"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          background: "#3a86ff",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: 6,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Install Forum Pod
      </a>
      <button
        onClick={onDismiss}
        style={{
          background: "transparent",
          border: "1px solid #475569",
          color: "#cbd5e1",
          padding: "6px 10px",
          borderRadius: 6,
          cursor: "pointer",
        }}
        aria-label="Dismiss for 24 hours"
      >
        Later
      </button>
    </div>
  );
}
