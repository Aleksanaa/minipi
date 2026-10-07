{
  description = "pi coding agent with vimpi, a compact vim-style UI for small terminals";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Settings that suit a 66x20 terminal. Merged into ~/.pi/agent/settings.json
      # by the Home Manager module; see README for manual use.
      compactSettings = {
        tuiMode = "fullscreen";
        quietStartup = true;
        collapseChangelog = true;
        hideThinkingBlock = true;
        outputPad = 0;
        editorPaddingX = 0;
        autocompleteMaxVisible = 3;
        fullscreenScrollbar = "auto";
        markdown.codeBlockIndent = " ";
        terminal.imageWidthCells = 40;
      };

      # pi's own library tree: the SDK types and the modules extensions import.
      piSdk = pkgs: "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";

      vimpiFor =
        pkgs:
        # A named directory, so pi labels the extension "vimpi" rather than by store hash.
        pkgs.runCommand "vimpi" { } ''
          d=$out/share/pi/extensions/vimpi
          mkdir -p $d
          cp ${./extensions/vimpi}/*.ts $d/
          rm -f $d/*.test.ts
          install -Dm644 ${./themes/basic8.json} $out/share/pi/themes/basic8.json
        '';

      # pi's own example extensions that add no UI rows and are ASCII-only:
      # desktop notification when idle, and /handoff to a fresh session.
      extrasFor =
        pkgs:
        map (n: "${piSdk pkgs}/examples/extensions/${n}.ts") [
          "notify"
          "handoff"
        ];

      piFor =
        pkgs: extensions:
        let
          vimpi = vimpiFor pkgs;
          flags = lib.concatMapStringsSep " " (e: "--extension ${lib.escapeShellArg e}") (
            [ "${vimpi}/share/pi/extensions/vimpi" ] ++ extensions
          );
        in
        pkgs.writeShellApplication {
          name = "pi";
          runtimeInputs = [ pkgs.pi-coding-agent ];
          text = ''
            # Subcommands take their own options; only the interactive agent gets the UI flags.
            case "''${1:-}" in
              install | remove | uninstall | update | list | config | auth)
                exec pi "$@" ;;
            esac
            # basic8: only the 8 basic ANSI colors. --use-theme lasts for this run only.
            exec pi ${flags} --theme ${vimpi}/share/pi/themes/basic8.json --use-theme basic8 --tui-mode fullscreen "$@"
          '';
          meta = pkgs.pi-coding-agent.meta // {
            mainProgram = "pi";
          };
        };
    in
    {
      packages = forAllSystems (pkgs: rec {
        vimpi = vimpiFor pkgs;
        pi = piFor pkgs (extrasFor pkgs);
        pi-unwrapped = pkgs.pi-coding-agent;
        default = pi;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.pi;
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.typescript
            pkgs.pi-coding-agent
          ];
          # Expose pi's SDK so tsc and editors resolve @earendil-works/* imports.
          shellHook = ''
            ln -sfn ${piSdk pkgs} .pi-sdk
            echo "vimpi dev shell: tsc -p . | node --test extensions/vimpi/*.test.ts | pi -e ./extensions/vimpi"
          '';
        };
      });

      checks = forAllSystems (pkgs: {
        vimpi =
          pkgs.runCommand "vimpi-check"
            {
              nativeBuildInputs = [
                pkgs.nodejs
                pkgs.typescript
              ];
            }
            ''
              cp -r ${./.}/. src && chmod -R u+w src && cd src
              ln -sfn ${piSdk pkgs} .pi-sdk
              tsc -p .
              node --test extensions/vimpi/*.test.ts
              touch $out
            '';
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      lib = { inherit compactSettings; };
    };
}
