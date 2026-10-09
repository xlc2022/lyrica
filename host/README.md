# Lyrica model host

Turns a Linux GPU machine (NVIDIA or AMD) into a model host for Lyrica: a
Docker Compose stack that Lyrica reaches over mutual TLS after pairing.

- [PAIRING.md](PAIRING.md): how Lyrica and a host come to trust each other.
- [API.md](API.md): what Lyrica can call.

## Install

The machine needs:
- Debian or Ubuntu (other Linux distributions should work);
- the GPU driver;
- Docker with the compose plugin, or Podman with a compose provider;
- the container runtime's GPU support. For NVIDIA, that's
  `nvidia-container-toolkit`.

```sh
git clone https://github.com/xlc2022/lyrica && cd lyrica
host/install.sh
```

`install.sh` does the following:
- checks the GPU, the driver and the container runtime's GPU support;
- asks for the host's name, the LAN address and the models folder;
- writes `host/.env`;
- builds and starts the stack;
- offers to set a dashboard password.

To upgrade, or to change a setting, run it again: `git pull && host/install.sh`.
Options: `host/install.sh --help`.

With `--tailscale NAME`, the stack joins your tailnet as a device of its own,
named `NAME`. It asks once for an auth key, which is removed from `.env` once
the device has joined. With `--no-lan` as well, the host is reachable only
over Tailscale.

## The dashboard

- **At the machine:** `http://127.0.0.1:7236`, with no login.
- **From the LAN:** `https://<LAN address>:7236`, with the password. The
  certificate is the host's own: check its fingerprint against the one
  `install.sh` printed.
- **Over Tailscale:** `https://NAME.<tailnet>.ts.net`, with the password and
  Tailscale's certificate.

The password is set at the machine, either by `install.sh` or on the
dashboard. Until it is set, the dashboard opens only at the machine. Five
wrong tries in 15 minutes from one address, or 20 in all, lock the login
until the window passes. The dashboard refuses requests whose Host or
Origin isn't the host's own.

## The models folder

The models folder is given at install (`--models`, default `/srv/models`) and
mounted read-only into the containers. It can be a folder another program
also uses, such as LM Studio's. To change it, run
`host/install.sh --models /new/path`. host-api can't remount containers
itself, because it has no access to the Docker socket.

## Pairing

1. On the dashboard, choose **Pair with Lyrica**. A code like
   `7KQ2-M9XD-4RTB-W1HZ` appears there and in the log
   (`docker compose logs host-api`). It works once, for 10 minutes.
2. In Lyrica, on the Models page, choose **Add model host**. Give it the
   host's addresses (`192.168.1.20`, or its tailnet name) and the code.

Paired Lyrica servers are listed on the dashboard, where they can be
revoked. A revoked server must pair again.

## How it's put together

- `host-api` (this folder's `src/`): TypeScript run by Node 22, with no npm
  dependencies. It is the only service with published ports:
  - `127.0.0.1:7236` for the dashboard at the machine. The container accepts
    that listener only from Docker's gateway address, which is where
    published loopback traffic arrives.
  - `<LAN address>:7236` for everything else, over TLS 1.3. It is never
    published on every interface, because Docker's published ports bypass
    the machine's firewall.
- Networks:
  - `models` is internal: no route out, and nothing outside can reach it.
  - `outside` holds `host-api` and, with Tailscale, the `tailscale` service.
    It is the only network with a route out.
- No container mounts the Docker socket.
- The host's key, certificate and state are in the `data` volume, readable
  only by host-api's user. The state is paired clients, the password hash,
  and pause. Prompts are never stored, and host-api's log has no text: only
  event names, IDs and counts, plus the pairing code while it's valid.
- Images are pinned by digest. `host-api` is built from this checkout by
  `install.sh`, and CI builds it on every pull request.
- `test/stack/network.sh` checks the network layout on a running stack.

Podman is supported by `install.sh` but hasn't been tested. The local
dashboard's address check assumes Docker's port publishing.
