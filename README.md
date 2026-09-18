# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Transcribing from a YouTube URL

Paste a YouTube URL in the sidebar and click **Fetch**. Audio is resolved
through a [cobalt](https://github.com/imputnet/cobalt) API instance and then
transcribed locally — the app itself stays fully client-side.

**Instance configuration** (under "Cobalt instance settings" in the sidebar):

- Default endpoint is `http://localhost:4940` — the bundled
  [yt-dlp sidecar](yt-dlp-sidecar/), which speaks cobalt's API shape (cobalt
  itself is blocked by YouTube's SABR rollout for long-form videos,
  [imputnet/cobalt#1455](https://github.com/imputnet/cobalt/issues/1455)).
  Run it in Docker:

  ```bash
  docker build -t yt-dlp-sidecar ./yt-dlp-sidecar
  docker run -d --name yt-dlp-sidecar -p 4940:4940 --restart unless-stopped yt-dlp-sidecar
  ```

- Public no-auth instances with working YouTube access are rare (see
  [cobalt discussion #860](https://github.com/imputnet/cobalt/discussions/860)),
  and `https://api.cobalt.tools` is bot-protected and returns auth errors.
  If you'd rather self-host cobalt:

  ```bash
  docker run -p 4939:4939 ghcr.io/imput/cobalt-api
  # then set Instance URL to http://localhost:4939
  ```

  If YouTube still refuses (fresh cloud IPs), pass your cookies via the
  instance's `COOKIE_PATH` setting.

Score playback uses sampled grand-piano sounds, lazy-loaded from a public
soundfont CDN on first Play (browser-cached afterwards). Offline it
automatically falls back to a simple built-in synth.

## Record system audio

"Record system audio" captures what your computer is playing (Spotify,
a local player, …) directly — no microphone noise. In the share picker,
choose **Entire Screen** and check **Share system audio**. Requires
Chrome 141+ on macOS 14.2+ (Apple's Core Audio taps); Safari does not
support it — use file upload, the YouTube URL, or a virtual audio device
such as BlackHole instead.

Only download content you have the right to use; downloading from YouTube
is against their Terms of Service for content you don't own or have
permission for.
