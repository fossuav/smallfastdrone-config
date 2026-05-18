#!/usr/bin/env bash
# Dev environment setup for smallfastdrone-config.
#
# Idempotent — safe to re-run. This script is the source of truth for
# everything needed to develop on this project. When a slice introduces
# a new prerequisite, extend this script in the same commit.
#
# Supported: Linux (Debian/Ubuntu family) and macOS. Windows users:
# run inside WSL2.

set -euo pipefail

# ----- helpers --------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

have()  { command -v "$1" >/dev/null 2>&1; }

# ----- prerequisites --------------------------------------------------

install_bun() {
  if have bun; then
    ok "bun $(bun --version) already installed"
    return
  fi
  info "installing bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash
  # New shells will pick it up from .bashrc; export for current process
  export PATH="$HOME/.bun/bin:$PATH"
  have bun || fail "bun install reported success but binary not on PATH; open a fresh terminal and re-run"
  ok "bun $(bun --version) installed"
}

install_project_deps() {
  info "installing project deps via bun"
  bun install
  ok "deps installed"
}

init_submodules() {
  info "initialising git submodules (vendor/smallfastdrone for SITL builds)"
  info "  first run pulls SFD + nested submodules (ChibiOS, mavlink, ...) — can take several minutes"
  git submodule update --init --recursive
  ok "submodules ready"
}

check_sitl_build_deps() {
  info "checking SITL build prerequisites"
  local missing=()
  for tool in gcc g++ python3 ccache; do
    have "$tool" || missing+=("$tool")
  done

  if [ ${#missing[@]} -ne 0 ]; then
    warn "missing tools needed to build SITL: ${missing[*]}"
    warn "install via your distro (Debian/Ubuntu):"
    warn "  sudo apt install build-essential python3 python3-pip ccache"
    warn "see vendor/smallfastdrone/Tools/environment_install/install-prereqs-ubuntu.sh for the full SFD/ArduPilot prereq list"
  else
    ok "all SITL build tools present"
  fi
}

install_playwright_browser() {
  info "installing Playwright chromium browser (~115 MB, first time only)"
  bun x playwright install chromium
  ok "Playwright browser ready"
}

check_playwright_system_deps() {
  info "checking Chromium runtime libs for Playwright"
  # Try a quick smoke run; if Chromium can't load its libs the binary exits
  # with code 127 immediately and ldd lists what's missing.
  local bin
  bin="$(find "$HOME/.cache/ms-playwright" -name 'chrome-headless-shell' -executable 2>/dev/null | head -1)"
  if [ -z "$bin" ]; then
    warn "Playwright Chromium not found; rerun install_playwright_browser"
    return
  fi
  local missing
  missing="$(ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}' | sort -u)"
  if [ -n "$missing" ]; then
    warn "Chromium is missing system libraries:"
    while IFS= read -r lib; do warn "  $lib"; done <<<"$missing"
    warn "install via:"
    warn "  sudo bun x playwright install-deps chromium"
    warn "(or sudo apt install libnss3 libnspr4 libatk-bridge2.0-0 libxss1 libasound2t64 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0)"
  else
    ok "all Chromium runtime libs present"
  fi
}

# ----- main -----------------------------------------------------------

main() {
  cd "$(dirname "$0")/.."  # repo root

  info "smallfastdrone-config dev environment setup"
  echo

  install_bun
  install_project_deps
  init_submodules
  check_sitl_build_deps
  install_playwright_browser
  check_playwright_system_deps

  echo
  ok "dev environment ready"
  echo
  echo "Try:"
  echo "  bun run dev:sitl    # SITL + bridge + Vite dev server in one terminal"
  echo "  bun run build       # production build"
  echo "  bun run typecheck"
  echo "  bun run sitl:build  # build ArduCopter SITL (5-10 min cold; cached after)"
  echo "  bun run sitl:start  # start SITL on TCP 127.0.0.1:5760"
  echo "  bun run sitl:stop"
  echo "  bun run test:e2e    # Playwright E2E (auto-starts SITL + bridge + Vite)"
}

main "$@"
