{
  lib,
  stdenvNoCC,
  stdenv,
  callPackage,
  bun,
  nodejs,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  wayland,
  zlib,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node_modules.nix { },
  mcpx ? null,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "opencode";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    bun
    nodejs # for patchShebangs node_modules
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  postPatch = ''
    # NOTE: Relax Bun version check to be a warning instead of an error
    substituteInPlace packages/script/src/index.ts \
      --replace-fail 'throw new Error(`This script requires bun@''${expectedBunVersionRange}' \
                     'console.warn(`Warning: This script requires bun@''${expectedBunVersionRange}'
  '';

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.OPENCODE_DISABLE_MODELS_FETCH = true;
  env.OPENCODE_VERSION = finalAttrs.version;
  env.OPENCODE_CHANNEL = "prod";
  env.NODE_OPTIONS = "--max-old-space-size=4096";

  buildPhase = ''
    runHook preBuild

    cd ./packages/cli
    bun --bun ./script/build.ts --single --skip-install

    runHook postBuild
  '';

  # On a symlinked store (e.g. /nix itself is a symlink into a persistent
  # directory) installPhase fails: gcc canonicalizes the store path through
  # the symlink while linking makeBinaryWrapper's C wrapper, so the
  # cc-wrapper purity check rejects the compiler's own store path as an
  # "impure path ... liblto_plugin.so used in link". Detect exactly that
  # layout — the store directory's canonical form differing from its
  # literal path — and relax the check for the wrapper compile only. On a
  # regular store the two are identical, nothing is exported, and the
  # build is unchanged.
  preInstall = ''
    opencodeStoreDir=$(dirname "$out")
    opencodeCanonicalStoreDir=$(readlink -f "$opencodeStoreDir" || true)
    if [ -n "$opencodeCanonicalStoreDir" ] && [ "$opencodeCanonicalStoreDir" != "$opencodeStoreDir" ]; then
      export NIX_ENFORCE_PURITY=0
    fi
    unset opencodeStoreDir opencodeCanonicalStoreDir
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/cli-*/bin/opencode $out/bin/opencode

    # OpenTUI dlopens Wayland for clipboard images.
    wrapProgram $out/bin/opencode \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          ++ lib.optional (mcpx != null) mcpx
          # bun runs sysctl to detect if running on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      } ${lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
        --prefix LD_LIBRARY_PATH : ${
          lib.makeLibraryPath [
            wayland
            # onnxruntime-node / sharp (native-onnx embeddings, #1727) dlopen
            # libstdc++.so.6 and libz.so.1; the packaged closure must provide them.
            stdenv.cc.cc.lib
            zlib
          ]
        }
      ''}

    ${lib.optionalString (mcpx != null) ''
      ln -s ${mcpx}/bin/mcpx $out/bin/mcpx
    ''}

    ln -s opencode $out/bin/opencode2

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # v2 dropped the `completion` subcommand; --completions is the global flag.
    # --completions also accepts sh, which emits the same script as bash.
    # staged to files, substitute below rejects anything that is not a regular file
    $out/bin/opencode --completions bash > opencode.bash
    $out/bin/opencode --completions zsh > _opencode
    $out/bin/opencode --completions fish > opencode.fish

    installShellCompletion --cmd opencode \
      --bash opencode.bash \
      --fish opencode.fish \
      --zsh _opencode

    # OPENCODE_CLI_NAME is a build-time define, so the opencode2 copies are
    # renamed rather than regenerated. --replace-fail is a global literal
    # substitution, so any lowercase opencode that later appears in a
    # description or help text ships as opencode2 in the opencode2 copy.
    substitute opencode.bash opencode2.bash --replace-fail opencode opencode2
    substitute _opencode _opencode2 --replace-fail opencode opencode2
    substitute opencode.fish opencode2.fish --replace-fail opencode opencode2

    installShellCompletion --cmd opencode2 \
      --bash opencode2.bash \
      --fish opencode2.fish \
      --zsh _opencode2
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "OPENCODE_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru = {
    env = finalAttrs.env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    mainProgram = "opencode";
    inherit (node_modules.meta) platforms;
  };
})
