# Icon assets

Tauri expects these files for the bundler:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png` (256x256)
- `icon.icns` (macOS)
- `icon.ico` (Windows, contains 16/32/48/256)

Drop your final brand assets here before running `npm run tauri:build`.
A placeholder is fine for development; the bundler will complain only
on `tauri build`, not on `tauri dev`.

You can regenerate every required size from a single 1024×1024 PNG
named `app-icon.png` with:

```bash
npx @tauri-apps/cli icon ../../forum-pod/public/favicon.svg
```
