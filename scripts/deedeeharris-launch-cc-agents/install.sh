#!/usr/bin/env bash
# ================================================================
# INSTALL — creates a desktop shortcut for the Claude Agents Launcher
# Run once after cloning. Works on Windows (Git Bash), macOS, Linux.
# ================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$SCRIPT_DIR/launch-agents.sh"
BAT="$SCRIPT_DIR/launch-agents.bat"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

case "$(uname -s)" in

    # ---- Windows (Git Bash) ----
    MINGW*|CYGWIN*|MSYS*)
        DESKTOP="$(cygpath "$USERPROFILE/Desktop" 2>/dev/null || echo "$USERPROFILE/Desktop")"
        LNK="$DESKTOP/Claude Agents Launcher.lnk"
        WIN_LNK="$(cygpath -w "$LNK" 2>/dev/null || echo "$LNK")"
        WIN_BAT="$(cygpath -w "$BAT" 2>/dev/null || echo "$BAT")"
        WIN_DIR="$(cygpath -w "$SCRIPT_DIR" 2>/dev/null || echo "$SCRIPT_DIR")"

        MSYS2_ARG_CONV_EXCL='*' powershell -NoProfile -Command \
            '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($args[0]); $s.TargetPath=$args[1]; $s.WorkingDirectory=$args[2]; $s.Save()' \
            "$WIN_LNK" "$WIN_BAT" "$WIN_DIR"
        echo -e "${GREEN}Shortcut created: $LNK${NC}"
        ;;

    # ---- macOS ----
    Darwin*)
        DESKTOP="$HOME/Desktop"
        APP="$DESKTOP/Claude Agents Launcher.command"
        cat > "$APP" <<EOF
#!/usr/bin/env bash
cd "$SCRIPT_DIR"
bash "$LAUNCHER"
EOF
        chmod +x "$APP"
        echo -e "${GREEN}Launcher created: $APP${NC}"
        echo -e "${CYAN}Double-click it in Finder to run.${NC}"
        ;;

    # ---- Linux ----
    *)
        DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || printf '%s/Desktop' "$HOME")"
        ENTRY="$DESKTOP/claude-agents-launcher.desktop"
        WRAPPER="$SCRIPT_DIR/launch-agents-linux.sh"
        cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec bash "$LAUNCHER"
EOF
        chmod +x "$WRAPPER"
        cat > "$ENTRY" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Claude Agents Launcher
Comment=Launch Claude Code background agents
Exec=$WRAPPER
Terminal=true
Icon=utilities-terminal
EOF
        chmod +x "$ENTRY"
        echo -e "${GREEN}Desktop entry created: $ENTRY${NC}"
        ;;
esac

echo -e "${CYAN}Done. Run launch-agents.bat (Windows) or bash launch-agents.sh (Mac/Linux).${NC}"
