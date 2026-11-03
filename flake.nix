{
  description = "OpenCode development flake";

  # The fleet's own binary cache (developing-today/nix-cache: Nix on
  # Cloudflare R2 + Workers) as an ADDED substituter — cache.nixos.org
  # stays in place; this only covers fleet-built paths the public cache
  # does not have. Public read; pushes are signed with the nix-cache-1
  # key, which is the key trusted here.
  nixConfig = {
    extra-substituters = [ "https://nix-cache.developing-today-llc-domains-0.workers.dev" ];
    extra-trusted-public-keys = [ "nix-cache-1:x/kKZuzyQI3L0/twmOp3w2U68F2ZgM3WnH3ERYKrwf8=" ];
  };

  inputs = {
    # The fleet repo carries the canonical nixpkgs pin for all fleet
    # repos (dezren39/fleet, flake.nix): one rev, aligned everywhere,
    # pinned to a nixpkgs-unstable channel tip so Hydra has the tree
    # fully built. To move the pin, move it in fleet and re-lock here.
    fleet.url = "github:dezren39/fleet";
    nixpkgs.follows = "fleet/nixpkgs";
    # mcpx source: developing-today/code is the canonical home of mcpx
    # (pkgs/mcpx). Used as a plain source tree (flake = false) so this
    # flake does not evaluate that repo's flake-parts graph; the pin in
    # flake.lock is the mcpx version this build ships.
    mcpx-src = {
      url = "github:developing-today/code";
      flake = false;
    };
  };

  outputs =
    { self, nixpkgs, mcpx-src, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "dirty";

      # The mcpx daemon modules originate in developing-today/code
      # (pkgs/mcpx/modules, code#4801); this flake re-exports them
      # (opencode#1502) with the package defaulted to THIS flake's
      # mcpx build — the same derivation as packages.<system>.mcpx,
      # and the one opencode bundles — so a consumer enabling the
      # daemon through here runs the identical mcpx this opencode
      # carries. The option set itself never forks: it is imported
      # from the pinned mcpx source tree.
      mcpxModule =
        module:
        { lib, pkgs, ... }:
        {
          imports = [ "${mcpx-src}/pkgs/mcpx/modules/${module}" ];
          services.mcpx.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.mcpx;
        };
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs
            pkg-config
            openssl
            git
          ];
          # The @parcel/watcher native addon dlopens libstdc++, which is not on the default search path. Without
          # it the watcher reports no native backend and watch tests time out.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      });

      overlays = {
        default =
          final: _prev:
          let
            node_modules = final.callPackage ./nix/node_modules.nix {
              inherit rev;
            };
          in
          rec {
            mcpx = final.callPackage "${mcpx-src}/pkgs/mcpx/package.nix" { };
            opencode = final.callPackage ./nix/opencode.nix {
              inherit node_modules;
              inherit mcpx;
            };
            opencode-desktop = final.callPackage ./nix/desktop.nix {
              inherit opencode;
            };
          };
      };

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev;
          };
        in
        rec {
          default = opencode;
          mcpx = pkgs.callPackage "${mcpx-src}/pkgs/mcpx/package.nix" { };
          opencode = pkgs.callPackage ./nix/opencode.nix {
            inherit node_modules;
            inherit mcpx;
          };
          opencode-desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit opencode;
          };
          # Updater derivation with fakeHash - build fails and reveals correct hash
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );

      nixosModules.mcpx = mcpxModule "nixos.nix";
      homeManagerModules.mcpx = mcpxModule "home-manager.nix";
      darwinModules.mcpx = mcpxModule "darwin.nix";
    };
}
