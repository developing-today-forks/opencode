# SPDX-License-Identifier: MIT OR Apache-2.0
#
# opencode module — nix-darwin.
#
# Canonical home: developing-today-forks/opencode, nix/modules
# (opencode#1511). Installs the standing server as a launchd user
# agent, equivalent to the systemd user unit the NixOS and
# home-manager modules install: same command, same environment
# pins, same restart policy (KeepAlive's SuccessfulExit = false is
# launchd's on-failure — see home-manager.nix for why).
#
# The agent runs the store path directly. mcpx's darwin module
# interposes a fixed /usr/local path because background-item
# identity and a daemon socket are at stake there; the opencode
# server is found through its registration file, not its
# executable path, so no indirection is needed here.
{
  config,
  lib,
  ...
}:
let
  cfg = config.services.opencode;
  home = config.users.users.${config.system.primaryUser}.home;
in
{
  imports = [ ./common.nix ];

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    launchd.user.agents.opencode.serviceConfig = {
      ProgramArguments = [
        "${cfg.package}/bin/opencode"
        "serve"
        "--service"
        "--hostname"
        cfg.hostname
        "--port"
        (toString cfg.port)
      ];
      # String values throughout: nix-darwin's envVariables option
      # is typed string with no derivation coercion.
      EnvironmentVariables = {
        HOME = home;
        OPENCODE_DB = "${home}/.local/share/opencode/opencode.db";
        TMPDIR = "${home}/.local/share/opencode/tmp";
      }
      // cfg.environment;
      KeepAlive = {
        SuccessfulExit = false;
      };
      RunAtLoad = true;
      WorkingDirectory = home;
      StandardOutPath = "${home}/Library/Logs/opencode.log";
      StandardErrorPath = "${home}/Library/Logs/opencode.log";
    };
  };
}
