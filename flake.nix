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
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
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
              project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              export DSH_HOME="$project_root/.dsh"
              unset project_root

              echo "DeepSeek Harness development shell"
              echo "Node: $(node --version)"
              echo "Corepack: $(corepack --version 2>/dev/null || echo unavailable)"
              echo "DSH_HOME: $DSH_HOME"
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
