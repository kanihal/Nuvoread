# Nuvoread

Nuvoread is a local browser reader extension backed by an MLX Audio text-to-speech server running on your Mac.

## Prerequisites

- macOS on an Apple Silicon Mac.
- Homebrew and Python 3.12. The installer will install Python 3.12 automatically if needed.
- Google Chrome, Microsoft Edge, or another Chromium browser for the unpacked extension.
- Internet access for Homebrew, Python dependencies, and model downloads.

## Install And Start The Server

From this folder, run:

```sh
chmod +x ./install-nuvoread-server.command
./install-nuvoread-server.command
```

The installer creates or reuses `.venv`, installs the local `upstream/mlx-audio` package with server and TTS dependencies, installs English Kokoro text-processing dependencies (`espeak-ng` and `misaki[en]`), downloads the default Kokoro TTS model and voice preset, writes a LaunchAgent to `~/Library/LaunchAgents/com.nuvoread.mlx-audio-server.plist`, starts it immediately, runs a curl-based TTS smoke test, and configures it to start at login.

The server listens at:

```text
http://127.0.0.1:9876
```

## Verify The Server

Check the HTTP endpoint:

```sh
curl http://127.0.0.1:9876/
```

Check the LaunchAgent:

```sh
launchctl print gui/$(id -u)/com.nuvoread.mlx-audio-server
```

Logs are written to:

```text
~/Library/Logs/Nuvoread/mlx-audio-server.out.log
~/Library/Logs/Nuvoread/mlx-audio-server.err.log
```

## Install The Browser Extension

Install the extension as an unpacked Chromium extension:

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension` folder inside this project.
5. Open the Nuvoread extension options and confirm the server URL is `http://127.0.0.1:9876`.

## Stop Or Remove The Background Server

Unload the LaunchAgent:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.nuvoread.mlx-audio-server.plist
```

Remove it from login startup:

```sh
rm ~/Library/LaunchAgents/com.nuvoread.mlx-audio-server.plist
```

The project-local virtual environment remains in `.venv`. Remove it only if you want to reinstall Python dependencies from scratch:

```sh
rm -rf .venv
```
