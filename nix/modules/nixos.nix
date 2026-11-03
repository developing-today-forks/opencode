# SPDX-License-Identifier: MIT OR Apache-2.0
#
# opencode module — NixOS.
#
# Canonical home: developing-today/opencode, nix/modules
# (opencode#1511). Installs a systemd *user* unit for the standing
# server; the darwin module in this directory installs the launchd
# equivalent.
#
# - started at login (wantedBy default.target);
# - Restart = "on-failure", deliberately not "always": the fork's
#   service lifecycle hands a running server over to a successor
#   during upgrades, and the old process then exits cleanly — a
#   restart-on-success policy would immediately spawn a second
#   server racing the successor for the port. Crashes still
#   restart. (The same policy the live OpenChamber unit uses.)
# - WorkingDirectory = %h: the server discovers its configuration
#   from the user's home, like the CLI does.
# - OPENCODE_DB / TMPDIR pins: every opencode and OpenChamber on a
#   machine must open the one session database (OpenChamber
#   hard-codes ~/.local/share/opencode), and macOS-style /var
#   scratch sweeps must never be advertised to agents as workspace.
#   dezren39/nix used to apply these with a shell wrapper around
#   the package; for the service they are simply its environment.
{
  config,
  lib,
  ...
}:
let
  cfg = config.services.opencode;
in
{
  imports = [ ./common.nix ];

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    systemd.user.services.opencode = {
      description = "OpenCode server (standing, --service)";
      wantedBy = [ "default.target" ];
      environment = {
        OPENCODE_DB = "%h/.local/share/opencode/opencode.db";
        TMPDIR = "%h/.local/share/opencode/tmp";
      }
      // cfg.environment;
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/opencode serve --service --hostname ${cfg.hostname} --port ${toString cfg.port}";
        Restart = "on-failure";
        WorkingDirectory = "%h";
      };
    };
  };
}
