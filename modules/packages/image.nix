# packages.neo-autofix — OCI image of the incident desk (buildNpmPackage +
# dockerTools). The NixOS module uses self.packages.<system>.neo-autofix as imageFile.
{
  lib,
  self,
  ...
}: {
  perSystem = {pkgs, ...}: let
    inherit (pkgs) dockerTools buildNpmPackage nodejs_22 python3 pkg-config sqlite cacert tzdata fakeNss srcOnly removeReferencesTo;
    nodejs = nodejs_22;
    nodeSources = srcOnly nodejs;

    app = buildNpmPackage {
      pname = "neo-autofix";
      version = "0.1.1";
      src = lib.cleanSourceWith {
        src = self + "/app";
        filter = path: type: let
          base = baseNameOf path;
        in
          base
          != "node_modules"
          && base != ".env"
          && base != "data"
          && !(lib.hasSuffix ".sqlite" path)
          && !(lib.hasSuffix ".sqlite-wal" path)
          && !(lib.hasSuffix ".sqlite-shm" path);
      };
      npmDepsHash = "sha256-v/lj7+UuOhh9pySUBj+xGdCXGNKc93lAbZOXtBjOEmU=";
      inherit nodejs;
      dontNpmBuild = true;
      nativeBuildInputs = [python3 pkg-config removeReferencesTo];
      buildInputs = [sqlite];

      postBuild = ''
        pushd node_modules/better-sqlite3
        npm run build-release --offline --nodedir="${nodeSources}"
        find build -type f -exec remove-references-to -t "${nodeSources}" {} \;
        popd
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out/app
        cp -r server.js package.json lib public node_modules $out/app/
        if [ -d views ]; then cp -r views $out/app/; fi
        runHook postInstall
      '';
    };

    neo-autofix = dockerTools.buildLayeredImage {
      name = "neo-autofix";
      tag = "latest";
      contents = [
        nodejs
        app
        cacert
        tzdata
        fakeNss
        dockerTools.caCertificates
      ];
      extraCommands = ''
        mkdir -p data
      '';
      config = {
        WorkingDir = "/app";
        Env = [
          "NODE_ENV=production"
          "PORT=3000"
          "OPS_DB_PATH=/data/ops.sqlite"
          "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
        ];
        ExposedPorts = {
          "3000/tcp" = {};
        };
        Volumes = {
          "/data" = {};
        };
        Cmd = ["${nodejs}/bin/node" "/app/server.js"];
      };
    };
  in {
    packages = {
      inherit neo-autofix;
      default = neo-autofix;
    };
  };
}
