{
  description = "DeepSeek Harness plugin development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      home-manager,
      ...
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      module = import ./home-manager/deepseek-harness-dev.nix;
    in
    {
      homeManagerModules.deepseek-harness-dev = module;

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpmWrapper = pkgs.runCommand "dsh-pnpm-wrapper" { } ''
            mkdir -p "$out/bin"
            cat > "$out/bin/pnpm" <<'EOF'
            #!${pkgs.runtimeShell}
            exec ${pkgs.nodejs_24}/bin/corepack pnpm "$@"
            EOF
            chmod +x "$out/bin/pnpm"
          '';
          dshWebWrapper = pkgs.runCommand "dsh-web-wrapper" { } ''
            mkdir -p "$out/bin"
            cat > "$out/bin/dsh-web" <<'EOF'
            #!${pkgs.runtimeShell}
            set -eu

            if test -z "''${DSH_HOME:-}"; then
              echo "dsh-web: DSH_HOME is not set; enter the DS-Plugins development shell first" >&2
              exit 1
            fi

            harness_dir="$(dirname -- "$DSH_HOME")/upstream/deepseek-harness"
            if ! test -f "$harness_dir/apps/cli/src/bin.ts"; then
              echo "dsh-web: Harness source checkout not found at $harness_dir" >&2
              exit 1
            fi

            cd "$harness_dir"
            exec ${pkgs.nodejs_24}/bin/node \
              --expose-internals \
              --import tsx/esm \
              apps/cli/src/bin.ts web --no-open "$@"
            EOF
            chmod +x "$out/bin/dsh-web"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              pnpmWrapper
              dshWebWrapper
              nodejs_24
              git
              gcc
              clang
              gnumake
              cmake
              pkg-config
              python3
              uv
              rustc
              cargo
              typescript-language-server
              ripgrep
              fd
              jq
              tree-sitter
              gdb
              strace
              gh
            ];

            shellHook = ''
              export PATH="${pnpmWrapper}/bin:$PATH"

              project_root="$(pwd -P)"
              while
                ! test -f "$project_root/flake.nix" \
                  || ! test -f "$project_root/home-manager/deepseek-harness-dev.nix"
              do
                if test "$project_root" = "/"; then
                  echo "DeepSeek Harness development shell: could not find the DS-Plugins project root from $(pwd -P)" >&2
                  exit 1
                fi

                project_root="$(dirname -- "$project_root")"
              done

              export DSH_HOME="$project_root/.dsh"
              unset project_root

              echo "DeepSeek Harness development shell"
              echo "Node: $(node --version)"
              echo "Corepack: $(corepack --version 2>/dev/null || echo unavailable)"
              echo "DSH_HOME: $DSH_HOME"
              echo "Workspace: pnpm install, pnpm typecheck, pnpm test"
            '';
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          testHome = home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [
              module
              {
                home.username = "dsh-test";
                home.homeDirectory = "/home/dsh-test";
                home.stateVersion = "24.11";
              }
            ];
          };
        in
        {
          home-manager-module = testHome.activationPackage;
        }
      );
    };
}
