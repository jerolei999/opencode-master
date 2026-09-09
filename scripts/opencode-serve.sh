#!/bin/bash
# opencode-slave real executor 的 spawn 目标（包装源码 opencode，零改动）
BUN="${BUN:-$HOME/.bun/bin/bun}"
exec "$BUN" run --cwd /Users/jero/Documents/code/opencode/packages/opencode --conditions=browser src/index.ts "$@"
