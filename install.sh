#!/usr/bin/env bash
# install.sh — set up claude-skills on any machine
# Usage: ./install.sh
# Symlinks skills, processes, agents, hooks, and commands from this repo.

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_TARGET="${HOME}/.claude/skills"
PROCESSES_TARGET="${HOME}/.a5c/processes"
AGENTS_TARGET="${HOME}/.a5c/agents"
HOOKS_TARGET="${HOME}/.claude/hooks"
COMMANDS_TARGET="${HOME}/.claude/commands"

echo "=> claude-skills installer"
echo "   repo: $REPO_DIR"
echo ""

mkdir -p "$SKILLS_TARGET" "$PROCESSES_TARGET" "$AGENTS_TARGET" "$HOOKS_TARGET" "$COMMANDS_TARGET"

# ── helper ──────────────────────────────────────────────────────────────────
link_dir() {
  local src="$1" target="$2" label="$3"
  if [ -L "$target" ]; then
    echo "   already linked: $label"
  elif [ -d "$target" ]; then
    echo "   ⚠️  $label exists as real directory — skipping (remove manually to link)"
  else
    ln -s "$src" "$target"
    echo "   linked: $label"
  fi
}

link_file() {
  local src="$1" target="$2" label="$3"
  if [ -L "$target" ]; then
    echo "   already linked: $label"
  elif [ -f "$target" ]; then
    echo "   ⚠️  $label exists as real file — skipping (remove manually to link)"
  else
    ln -s "$src" "$target"
    echo "   linked: $label"
  fi
}
# ────────────────────────────────────────────────────────────────────────────

echo "=> skills (~/.claude/skills/)"
for d in "$REPO_DIR/skills"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  link_dir "$d" "$SKILLS_TARGET/$name" "$name"
done

echo ""
echo "=> processes (~/.a5c/processes/)"
for f in "$REPO_DIR/processes"/*.js; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  link_file "$f" "$PROCESSES_TARGET/$name" "$name"
done

echo ""
echo "=> agents (~/.a5c/agents/)"
for d in "$REPO_DIR/agents"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  link_dir "$d" "$AGENTS_TARGET/$name" "$name"
done

echo ""
echo "=> hooks (~/.claude/hooks/)"
for f in "$REPO_DIR/hooks"/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  link_file "$f" "$HOOKS_TARGET/$name" "$name"
done

echo ""
echo "=> commands (~/.claude/commands/)"
for f in "$REPO_DIR/commands"/*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  link_file "$f" "$COMMANDS_TARGET/$name" "$name"
done

echo ""
echo "Done. Everything is live in Claude Code."
echo "To update on this machine: git pull"
