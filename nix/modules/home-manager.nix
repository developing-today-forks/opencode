# SPDX-License-Identifier: MIT OR Apache-2.0
#
# opencode module — home-manager.
#
# Canonical home: developing-today/opencode, nix/modules
# (opencode#1511). The Linux branch installs the same systemd user
# unit as nixos.nix; the darwin branch installs a launchd user
# agent with the same command and environment, the paths spelled
# absolutely (%h has no launchd equivalent, so the home directory
# comes from the home-manager configuration).
#
# launchd KeepAlive is the dict form { SuccessfulExit = false } —
# the on-failure policy of the systemd units (see nixos.nix for
# why): a clean exit after a lifecycle handover must not respawn
# a competing server; a crash must.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.opencode;
  home = config.home.homeDirectory;
  args = [
    "${cfg.package}/bin/opencode"
    "serve"
    "--service"
    "--hostname"
    cfg.hostname
    "--port"
    (toString cfg.port)
  ];
in
{
  imports = [ ./common.nix ];

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      { home.packages = [ cfg.package ]; }

      (lib.mkIf (!pkgs.stdenv.hostPlatform.isDarwin) {
        systemd.user.services.opencode = {
          Unit.Description = "OpenCode server (standing, --service)";
          Service = {
            ExecStart = lib.concatStringsSep " " args;
            Restart = "on-failure";
            WorkingDirectory = "%h";
            Environment = [
              "OPENCODE_DB=%h/.local/share/opencode/opencode.db"
              "TMPDIR=%h/.local/share/opencode/tmp"
            ]
            ++ lib.mapAttrsToList (name: value: "${name}=${value}") cfg.environment;
          };
          Install.WantedBy = [ "default.target" ];
        };
      })

      (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
        launchd.agents.opencode = {
          enable = true;
          config = {
            ProgramArguments = args;
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
      })
    ]
  );
}
