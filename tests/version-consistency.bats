#!/usr/bin/env bats

# version-consistency tests
# Verifies that version numbers are consistent across all manifest files

@test "package.json version matches plugin.json version" {
  PKG_VER=$(jq -r '.version' package.json)
  PLUGIN_VER=$(jq -r '.version' .claude-plugin/plugin.json)
  [ "$PKG_VER" = "$PLUGIN_VER" ]
}

@test "package.json version matches marketplace.json version" {
  PKG_VER=$(jq -r '.version' package.json)
  MKT_VER=$(jq -r '.plugins[0].version' .claude-plugin/marketplace.json)
  [ "$PKG_VER" = "$MKT_VER" ]
}

@test "package.json has valid semver" {
  VER=$(jq -r '.version' package.json)
  [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "all JSON files are valid" {
  for f in package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json settings.json; do
    jq '.' "$f" > /dev/null 2>&1
  done
}

@test "all template JSON files are valid" {
  for f in templates/progress/phase-gate.json templates/progress/feature_list.json templates/evals/acceptance-criteria.json; do
    if [ -f "$f" ]; then
      jq '.' "$f" > /dev/null 2>&1
    fi
  done
}
