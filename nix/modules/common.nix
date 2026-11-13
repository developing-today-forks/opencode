# SPDX-License-Identifier: MIT OR Apache-2.0
#
# opencode module — shared options.
#
# Canonical home: developing-today-forks/opencode, nix/modules (opencode
# #1511 — the service mode originates with opencode, the same way
# the mcpx daemon modules originate with mcpx in
# developing-today/code, pkgs/mcpx/modules). Imported by every
# platform module in this directory (nixos.nix, home-manager.nix,
# darwin.nix): the option set is the contract —
# `services.opencode.enable`, `package`, `hostname`, `port`,
# `environment` — and it is identical on every platform; only the
# service definition differs.
#
# The service is the fork's standing server: `opencode serve
# --service`. In --service mode the server registers itself on
# listen in ~/.local/state/opencode/service-<channel>.json
# (id, url, pid, version, password — written owner-only by
# packages/cli's ServiceRegistration), which is how clients —
# above all OpenChamber's module — find and authenticate to it.
# The password itself comes from the fork's per-channel service
# config (~/.config/opencode/service-<channel>.json): generated
# once if absent and persisted there across restarts. Nothing
# secret is ever rendered by these modules.
{
  config,
  lib,
  ...
}:
let
  cfg = config.services.opencode;
in
{
  options.services.opencode = {
    enable = lib.mkEnableOption "the standing OpenCode server (opencode serve --service)";

    package = lib.mkOption {
      type = lib.types.package;
      description = ''
        The opencode package to run. The flake's module outputs
        default this to the flake's own `packages.<system>.opencode`
        build; override it to run another build.
      '';
    };

    hostname = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Hostname the server listens on. Passed explicitly to
        `serve --hostname` so the address is a configuration fact
        consumers (OpenChamber's module) can rely on, not a default
        buried in the CLI.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 13420;
      description = ''
        Port the server listens on, passed explicitly to
        `serve --port`. 13420 is the prod channel's standing port —
        the value the fork's channel-hash default also lands on —
        pinned here so the address is a configuration fact, not a
        derivation from the channel name.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''{ OPENCODE_CONFIG_CONTENT = "{ }"; }'';
      description = ''
        Extra environment variables for the server process, merged
        over the module's own pins (OPENCODE_DB and TMPDIR — see the
        platform modules; a key written here wins). NOT for secrets:
        values are rendered into the generated unit/plist in the
        world-readable Nix store.
      '';
    };
  };

  # The cascade (Drew, 2026-11-03): enabling a layer enables the
  # layer below it by default. The fork's opencode talks to the
  # mcpx daemon (its package bundles the mcpx binary; the daemon is
  # what pools the MCP servers), so the standing server assumes the
  # daemon. mkDefault: a consumer can still turn mcpx off or manage
  # it themselves. The mcpx module itself is imported by the
  # flake's module outputs alongside this one, so the option exists
  # whenever this module does.
  config = lib.mkIf cfg.enable {
    services.mcpx.enable = lib.mkDefault true;
  };
}
