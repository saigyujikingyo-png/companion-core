# Exact-session menu action

The button source in `src/client.opus.js` is the unchanged output of the actual
Claude Opus CLI (`claude-opus-5-5`); `OPUS-AUTHORSHIP.json` records its receipt and
canonical text hash. Windows CRLF is recorded separately.

`build.mjs` only converts that source to DSH rc.3's lazy CommonJS factory and
injects one public UUID. DSH does not project host row config to client plugins.
The factory uses the existing React baseline rather than shipping another copy.
Build the artifact into the new runtime package before official CLI installation:

```
node build.mjs <owned-session-uuid> <new-package>/lib/client.js
```

After the backend audit confirms ready, open any existing visible session row's
ellipsis menu and choose **打开 Companion Core 会话**. The menu row's session is
ignored. Only a trusted user click opens the compiled owned UUID; loading and
rendering the plugin do not navigate, create a session, select a preset, submit
input or call a model. This appended list action does not replace a shell slot.

The current deployment has existing visible session rows. A wholly empty profile
has no such menu; that broader navigation case is not supported by this small
helper. Actual rendering/clicking is left for user confirmation because this
deployment uses CLI and public SDK only.

Deployment feedback on 2026-10-25: the user first reported no menu item, then confirmed successfully opening Companion Core. Both observations are retained without attributing a cause. The current desktop status-command reply remains pending.
