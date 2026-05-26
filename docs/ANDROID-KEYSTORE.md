# Android Keystore Signing Path (Post-POC)

Production APK should sign Pod RPC payloads with a key in **Android Keystore** (`setUserAuthenticationRequired(true)`), not in the WebView JavaScript heap.

## Current state

- `forum-pod/src/native-signing.js` delegates to Web Crypto (`extractable: false`).
- `capacitor.config.json`: `webContentsDebuggingEnabled: false` for release.

## Implementation sketch

1. Capacitor plugin `ForumSigningPlugin` with `@PluginMethod sign(payload: String): String`.
2. Keystore alias `forum_pod_ed25519`; generate on first unlock after biometric/passkey gate.
3. JS sends canonical JSON string; native returns hex signature + `publicKeyHex`.
4. Worker continues to verify Ed25519 as today.

## Recovery

- Non-exportable Keystore keys require **recovery passkey** enrollment (second WebAuthn credential bound to same DO).
- Device-export blobs are disabled (`exportDeviceKeyBlob` throws).

## Testing

- Release build on physical device; confirm `adb backup` does not include WebView storage.
- Confirm WebView remote debugging disabled.
