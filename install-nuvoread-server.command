#!/bin/zsh
set -euo pipefail

LABEL="com.nuvoread.mlx-audio-server"
HOST="127.0.0.1"
PORT="9876"
IDLE_UNLOAD_SECONDS="1800"

SCRIPT_PATH="${0:A}"
SCRIPT_NAME="${SCRIPT_PATH:t}"
PROJECT_DIR="${SCRIPT_PATH:h}"
VENV_DIR="${PROJECT_DIR}/.venv"
UPSTREAM_DIR="${PROJECT_DIR}/upstream/mlx-audio"
PYTHON_BIN="${VENV_DIR}/bin/python"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/Nuvoread"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
OUT_LOG="${LOG_DIR}/mlx-audio-server.out.log"
ERR_LOG="${LOG_DIR}/mlx-audio-server.err.log"
GUI_DOMAIN="gui/$(id -u)"
SERVER_URL="http://${HOST}:${PORT}"

info() {
  printf "==> %s\n" "$*"
}

die() {
  printf "Error: %s\n" "$*" >&2
  exit 1
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf "%s" "$value"
}

print_plist() {
  local escaped_script escaped_project escaped_out escaped_err
  escaped_script="$(xml_escape "${SCRIPT_PATH}")"
  escaped_project="$(xml_escape "${PROJECT_DIR}")"
  escaped_out="$(xml_escape "${OUT_LOG}")"
  escaped_err="$(xml_escape "${ERR_LOG}")"

  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${escaped_script}</string>
    <string>--serve</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${escaped_project}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${escaped_out}</string>

  <key>StandardErrorPath</key>
  <string>${escaped_err}</string>
</dict>
</plist>
PLIST
}

serve() {
  cd "${PROJECT_DIR}"

  if [[ ! -x "${PYTHON_BIN}" ]]; then
    die "Missing ${PYTHON_BIN}. Run ${SCRIPT_PATH} first to install the server."
  fi

  exec "${PYTHON_BIN}" -m mlx_audio.server \
    --host "${HOST}" \
    --port "${PORT}" \
    --idle-unload-seconds "${IDLE_UNLOAD_SECONDS}"
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This installer uses macOS LaunchAgents and must be run on macOS."
}

require_python() {
  command -v python3 >/dev/null 2>&1 || die "python3 is required. Install Python 3.10 or newer, then rerun this script."
  python3 - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10 or newer is required.")
PY
}

install_python_deps() {
  [[ -f "${UPSTREAM_DIR}/pyproject.toml" ]] || die "Missing ${UPSTREAM_DIR}/pyproject.toml."

  if [[ ! -x "${PYTHON_BIN}" ]]; then
    info "Creating virtual environment at ${VENV_DIR}"
    python3 -m venv "${VENV_DIR}"
  else
    info "Using existing virtual environment at ${VENV_DIR}"
  fi

  info "Upgrading pip"
  "${PYTHON_BIN}" -m pip install --upgrade pip

  info "Installing local mlx-audio server and TTS dependencies"
  "${PYTHON_BIN}" -m pip install --editable "${UPSTREAM_DIR}[server,tts]"

  [[ -x "${VENV_DIR}/bin/mlx_audio.server" ]] || die "Install finished but ${VENV_DIR}/bin/mlx_audio.server is missing."
}

install_launch_agent() {
  mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

  info "Writing LaunchAgent to ${PLIST_PATH}"
  print_plist > "${PLIST_PATH}"
  plutil -lint "${PLIST_PATH}" >/dev/null

  if launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    info "Unloading existing LaunchAgent"
    launchctl bootout "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1 || \
      launchctl bootout "${GUI_DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true

    local attempt
    for attempt in {1..10}; do
      launchctl print "${GUI_DOMAIN}/${LABEL}" >/dev/null 2>&1 || break
      sleep 1
    done
  fi

  info "Loading LaunchAgent"
  launchctl bootstrap "${GUI_DOMAIN}" "${PLIST_PATH}"
  launchctl enable "${GUI_DOMAIN}/${LABEL}"

  info "Starting LaunchAgent"
  launchctl kickstart -k "${GUI_DOMAIN}/${LABEL}"
}

verify_server() {
  info "Waiting for ${SERVER_URL}"

  local attempt response
  for attempt in {1..30}; do
    response="$(curl -fsS --max-time 2 "${SERVER_URL}/" 2>/dev/null || true)"
    if [[ -n "${response}" ]]; then
      info "Server responded: ${response}"
      return 0
    fi
    sleep 1
  done

  printf "Warning: Server did not respond at %s within 30 seconds.\n" "${SERVER_URL}" >&2
  printf "Check logs:\n  %s\n  %s\n" "${OUT_LOG}" "${ERR_LOG}" >&2
  return 1
}

print_summary() {
  cat <<SUMMARY

Nuvoread server setup complete.

Server URL:
  ${SERVER_URL}

LaunchAgent:
  ${PLIST_PATH}

Logs:
  ${OUT_LOG}
  ${ERR_LOG}

Useful commands:
  launchctl print ${GUI_DOMAIN}/${LABEL}
  curl ${SERVER_URL}/

SUMMARY
}

main() {
  case "${1:-}" in
    --serve)
      serve
      ;;
    --print-plist)
      print_plist
      ;;
    -h|--help)
      cat <<HELP
Usage:
  ${SCRIPT_NAME}            Install dependencies, install the LaunchAgent, and start the server.
  ${SCRIPT_NAME} --serve    Run the server. Intended for LaunchAgent use.
HELP
      ;;
    "")
      require_macos
      require_python
      install_python_deps
      install_launch_agent
      verify_server
      print_summary
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
}

main "$@"
