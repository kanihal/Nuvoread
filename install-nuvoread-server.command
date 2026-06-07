#!/bin/zsh
set -euo pipefail

LABEL="com.nuvoread.mlx-audio-server"
HOST="127.0.0.1"
PORT="9876"
IDLE_UNLOAD_SECONDS="1800"

SCRIPT_PATH="${0:a}"
SCRIPT_NAME="${SCRIPT_PATH:t}"

resolve_project_dir() {
  local candidate
  for candidate in "${NUVOREAD_PROJECT_DIR:-}" "${SCRIPT_PATH:h}" "${PWD:-}"; do
    [[ -n "${candidate}" ]] || continue
    candidate="${candidate:a}"
    if [[ -f "${candidate}/upstream/mlx-audio/pyproject.toml" ]]; then
      printf "%s" "${candidate}"
      return 0
    fi
  done

  printf "%s" "${SCRIPT_PATH:h}"
  return 0
}

PROJECT_DIR="$(resolve_project_dir)"
VENV_DIR="${PROJECT_DIR}/.venv"
UPSTREAM_DIR="${PROJECT_DIR}/upstream/mlx-audio"
PYTHON_BIN="${VENV_DIR}/bin/python"
PYTHON_CMD=""
BREW_CMD=""
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

find_brew() {
  local -a candidates=(
    brew
    /opt/homebrew/bin/brew
    /usr/local/bin/brew
  )

  local candidate resolved
  for candidate in "${candidates[@]}"; do
    if [[ "${candidate}" == */* ]]; then
      [[ -x "${candidate}" ]] || continue
      resolved="${candidate}"
    else
      resolved="$(command -v "${candidate}" 2>/dev/null || true)"
      [[ -n "${resolved}" ]] || continue
    fi

    printf "%s" "${resolved}"
    return 0
  done

  return 1
}

load_brew_shellenv() {
  [[ -n "${BREW_CMD}" ]] || return 0
  eval "$("${BREW_CMD}" shellenv)"
}

install_homebrew() {
  BREW_CMD="$(find_brew)" && {
    load_brew_shellenv
    info "Using Homebrew: ${BREW_CMD}"
    return 0
  }

  command -v curl >/dev/null 2>&1 || die "curl is required to install Homebrew."
  command -v /bin/bash >/dev/null 2>&1 || die "/bin/bash is required to install Homebrew."

  info "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  BREW_CMD="$(find_brew)" || die "Homebrew install finished, but brew was not found."
  load_brew_shellenv
  info "Using Homebrew: ${BREW_CMD}"
}

install_python_with_brew() {
  install_homebrew

  info "Installing Python with Homebrew"
  "${BREW_CMD}" install python
}

python_is_supported() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
}

find_python() {
  local -a candidates=(
    "${PYTHON:-}"
    python3.14
    python3.13
    python3.12
    python3.11
    python3.10
    python3
    /opt/homebrew/bin/python3
    /opt/homebrew/bin/python3.14
    /opt/homebrew/bin/python3.13
    /opt/homebrew/bin/python3.12
    /opt/homebrew/bin/python3.11
    /opt/homebrew/bin/python3.10
    /usr/local/bin/python3
    /usr/local/bin/python3.14
    /usr/local/bin/python3.13
    /usr/local/bin/python3.12
    /usr/local/bin/python3.11
    /usr/local/bin/python3.10
  )

  local candidate resolved
  for candidate in "${candidates[@]}"; do
    [[ -n "${candidate}" ]] || continue

    if [[ "${candidate}" == */* ]]; then
      [[ -x "${candidate}" ]] || continue
      resolved="${candidate}"
    else
      resolved="$(command -v "${candidate}" 2>/dev/null || true)"
      [[ -n "${resolved}" ]] || continue
    fi

    if python_is_supported "${resolved}"; then
      printf "%s" "${resolved}"
      return 0
    fi
  done

  return 1
}

require_python() {
  if ! PYTHON_CMD="$(find_python)"; then
    info "Python 3.10 or newer was not found."
    install_python_with_brew
    PYTHON_CMD="$(find_python)" || die "Homebrew Python install finished, but Python 3.10 or newer was not found."
  fi

  info "Using Python: $("${PYTHON_CMD}" -c 'import sys; print(f"{sys.executable} ({sys.version.split()[0]})")')"
}

ensure_upstream_source() {
  [[ -f "${UPSTREAM_DIR}/pyproject.toml" ]] && return 0

  command -v git >/dev/null 2>&1 || die "Missing ${UPSTREAM_DIR}/pyproject.toml, and git is required to fetch upstream/mlx-audio."

  info "Fetching upstream/mlx-audio"
  if [[ -d "${PROJECT_DIR}/.git" || -f "${PROJECT_DIR}/.git" ]]; then
    git -C "${PROJECT_DIR}" submodule update --init --recursive upstream/mlx-audio || true
    [[ -f "${UPSTREAM_DIR}/pyproject.toml" ]] && return 0
  fi

  local repo_url branch existing_file
  repo_url="$(git -C "${PROJECT_DIR}" config -f .gitmodules --get submodule.upstream/mlx-audio.url 2>/dev/null || true)"
  branch="$(git -C "${PROJECT_DIR}" config -f .gitmodules --get submodule.upstream/mlx-audio.branch 2>/dev/null || true)"
  repo_url="${repo_url:-https://github.com/kanihal/mlx-audio.git}"
  branch="${branch:-nuvoread-server-support}"

  mkdir -p "${PROJECT_DIR}/upstream"
  existing_file="$(find "${UPSTREAM_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  if [[ -n "${existing_file}" ]]; then
    die "Missing ${UPSTREAM_DIR}/pyproject.toml, and ${UPSTREAM_DIR} is not empty. Remove or fix that directory, then rerun this script."
  fi

  git clone --branch "${branch}" "${repo_url}" "${UPSTREAM_DIR}"
  [[ -f "${UPSTREAM_DIR}/pyproject.toml" ]] || die "Fetched ${UPSTREAM_DIR}, but pyproject.toml is still missing."
}

install_python_deps() {
  ensure_upstream_source

  if [[ ! -x "${PYTHON_BIN}" ]]; then
    info "Creating virtual environment at ${VENV_DIR}"
    "${PYTHON_CMD}" -m venv "${VENV_DIR}"
  else
    info "Using existing virtual environment at ${VENV_DIR}"
    python_is_supported "${PYTHON_BIN}" || die "Existing virtual environment uses an unsupported Python. Remove ${VENV_DIR}, then rerun this script."
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
