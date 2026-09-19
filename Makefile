.PHONY: test frontend build dev package dbxp auto

test:
	cd backend && GOCACHE=$${GOCACHE:-/tmp/dbx-plugin-k8s-gocache} go test -mod=readonly ./...

frontend:
	cd ui && pnpm run build

build:
	./scripts/build.sh

dev:
	dbx-plugin dev --path . --port $${PORT:-5190}

package:
	dbx-plugin package . --output-dir $${OUTPUT_DIR:-dist}

# Build the complete plugin and emit a local-platform .dbxp candidate.
dbxp: build
	dbx-plugin package . --output-dir $${OUTPUT_DIR:-dist}

# Rebuild + repackage only when sources changed, bumping the patch version.
auto:
	node scripts/auto-package.mjs
