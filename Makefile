.PHONY: check bump-version

check:
	bun test

bump-version:
	@test -n "$(PLUGIN)" || (echo "Usage: make bump-version PLUGIN=<plugin-name> VERSION=<version>" && exit 1)
	@test -n "$(VERSION)" || (echo "Usage: make bump-version PLUGIN=<plugin-name> VERSION=<version>" && exit 1)
	bun scripts/bump-plugin-version.ts "$(PLUGIN)" "$(VERSION)"
	bun test "plugins/$(PLUGIN)/tests"
