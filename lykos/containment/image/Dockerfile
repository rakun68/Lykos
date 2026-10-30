# The toolchain Lykos runs a contained session's commands in.
#
# It holds what a project's commands need and nothing of Lykos: no agent, no
# `lykos` CLI, no credentials. The session itself stays on the host; only the
# commands it starts come here (ADR-0036).
#
# Lykos builds this file on first use and tags the image by a hash of these
# bytes, so editing anything below produces a new tag and a rebuild.

FROM node:24-bookworm-slim

# git because projects use it; python3 because most toolchains reach for it;
# ripgrep, jq, curl, make, procps and unzip are the Unix tools a shell session
# expects to find. util-linux (setsid) is already in the base and is what lets
# Lykos stop a command's whole process group.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make curl ripgrep jq procps unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# .git is read-only in here, so a git command that writes would fail with an
# error about a lock or a read-only file system. This wrapper answers the common
# ones with the way to do it: the `commit` tool, on the host. It is a message,
# not the boundary (the read-only mount is), so /usr/bin/git still works for
# everything else. Written with printf so the file is part of this Dockerfile's
# bytes and the image tag still covers it.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'skip=0' \
      'for a in "$@"; do' \
      '  if [ "$skip" = 1 ]; then skip=0; continue; fi' \
      '  case "$a" in' \
      '    -C|-c|--git-dir|--work-tree|--namespace) skip=1 ;;' \
      '    -*) ;;' \
      '    add|commit|rm|mv|reset|restore|checkout|switch|merge|rebase|cherry-pick|revert|stash|pull|push|fetch|am|update-index|update-ref|commit-tree)' \
      '      echo "lykos: git $a is not available inside the container: .git is read-only here. Use the commit tool to record your work; git status, diff and log still work." >&2' \
      '      exit 1 ;;' \
      '    *) break ;;' \
      '  esac' \
      'done' \
      'exec /usr/bin/git "$@"' \
      > /usr/local/bin/git \
 && chmod +x /usr/local/bin/git
