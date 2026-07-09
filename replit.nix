{pkgs}: {
  deps = [
    pkgs.bore-cli
    pkgs.jq
    pkgs.cloudflared
    pkgs.dropbear
  ];
}
