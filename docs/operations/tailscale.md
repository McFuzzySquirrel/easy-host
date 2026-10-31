# Reaching an app from outside the LAN with Tailscale

easy-host publishes exactly one host port per app and deliberately ships no TLS terminator, reverse proxy, or ingress. Tailscale fills that gap on the **host**: it terminates HTTPS, gives the machine a stable DNS name, and proxies to the app's loopback port. The image is never rebuilt by the steps below, and Tailscale never runs inside the container; only the publish address changes, and that is applied by the usual `update`.

This is an operator guide, not an easy-host feature. There is no `tailscale` command, no new `config.toml` key, and nothing in `easy-host update` knows Tailscale exists.

The examples use the app name `blog`, host port `8080`, and the default container port `3000`.

## Two supported layouts

| Layout | `bind` | Reachable from | TLS | Notes |
| --- | --- | --- | --- | --- |
| **Tailnet only** (recommended) | `127.0.0.1` | Your tailnet, through `tailscale serve` | Yes, by Tailscale | The port is closed to the LAN and the public internet. |
| **LAN and tailnet** | `0.0.0.0` (default) | LAN neighbours and your tailnet directly | No | Plain HTTP on every interface. Only for a trusted LAN. |

A third layout — binding the app to a Tailscale IP such as `100.x.y.z` — is **not supported**. The `bind` key accepts only `0.0.0.0`, `127.0.0.1`, and `::`, and the readiness probe always targets `127.0.0.1:<port>`, so an app listening on any other address would fail its own health gate. Use `127.0.0.1` plus `tailscale serve` instead; it reaches the same result without weakening the probe.

## Before you start

1. Install Tailscale on the host by following [Install Tailscale on Linux](https://tailscale.com/docs/install/linux).

2. Bring the node onto your tailnet and note its DNS name:

   ```sh
   sudo tailscale up
   tailscale status
   ```

   The DNS name has the form `<host>.<tailnet>.ts.net`; `tailscale ip -4` prints the `100.x.y.z` address. Both work inside the tailnet, but only the DNS name works with HTTPS and Funnel, so prefer the name.

3. In the admin console, enable [MagicDNS](https://tailscale.com/docs/features/magicdns) and [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) for the tailnet. Without certificates, `tailscale serve --https=…` cannot obtain its certificate and the URL will not load; use `--http=80` instead if you only need plain HTTP inside the tailnet.

4. Decide how you will run `tailscale serve`. It normally needs root (`sudo`). If you would rather run it as your own user, grant the operator first:

   ```sh
   sudo tailscale set --operator="$USER"
   ```

5. Confirm the app is registered and healthy before adding a proxy in front of it:

   ```sh
   easy-host status blog
   ```

   `status` exits `4` when the app is unhealthy. A proxy in front of an unhealthy app produces a 502, not a diagnosis.

## Publish one app with TLS (recommended)

The app is published on loopback so that nothing but the host itself can reach the container port. `easy-host config` has no `--bind` flag, so edit the file and apply the change with `update`:

1. Open the app's configuration:

   ```sh
   easy-host config blog --edit
   ```

2. Set the bind address to loopback and save:

   ```toml
   bind = "127.0.0.1"
   ```

3. Apply it. `bind` is a configuration-only change, so no image is rebuilt; the container is recreated and the new one must pass the readiness probe, exactly as in any other update. Remember that the swap briefly stops the app because the host port is fixed:

   ```sh
   easy-host update blog
   ```

4. Proxy the loopback port onto the tailnet with TLS:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
   ```

   Serve prints the URL it is now answering on:

   ```text
   Available within your tailnet:

   https://blog-host.example-tailnet.ts.net/
   |-- proxy http://127.0.0.1:8080
   ```

5. Verify from a **second** device that is on the tailnet:

   ```sh
   curl -fsS https://blog-host.example-tailnet.ts.net/
   ```

The target must be `http://127.0.0.1:<host-port>`, where `<host-port>` is the app's `port` key — not `container_port`. Serve only proxies to `127.0.0.1`, which is the reason this layout binds the app to loopback in the first place. If you set `bind = "127.0.0.1"` but point Serve at `localhost:3000` while the app publishes `8080`, you get a connection error, not a TLS error.

The `--bg` flag matters: it stores the route in the Tailscale daemon, where it survives reboots and `tailscale down`/`tailscale up`. Without `--bg`, the route exists only for the lifetime of the command.

## Several apps on one host

MagicDNS names belong to the **node**, not to an app, so a second app does not get its own hostname unless you run Tailscale on a separate node. There are two options, and the `port` key stays unique across apps in both:

| Approach | Command | URL |
| --- | --- | --- |
| Separate port | `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8081` | `https://<host>.<tailnet>.ts.net:8443/` |
| Path mount | `sudo tailscale serve --bg --https=443 --set-path=/blog http://127.0.0.1:8080` | `https://<host>.<tailnet>.ts.net/blog` |

A path mount only works if the app tolerates being served from a sub-path; an app that emits absolute asset URLs without a matching base path will break. A separate port is the safer default, and the port Serve listens on does not need to match the app's host port.

A port cannot be both private and public: Serve and Funnel cannot listen on the same port at the same time, and whichever command ran last owns it. If a `tailscale funnel` for one app and a `tailscale serve` for another both target `443`, one of them silently becomes the other's mode. Give each app a distinct port when you mix the two.

List and clean up routes with:

```sh
tailscale serve status
sudo tailscale serve --https=8443 off
sudo tailscale serve reset
```

`easy-host remove blog` deletes the container, images, and (with `--volumes`) volumes, but it never touches Tailscale configuration. Removing an app leaves its route behind, pointing at a closed port, so remove the route as part of the same change.

## The `0.0.0.0` shortcut

If the LAN is trusted and you only need the app reachable from your own devices, you do not need Serve or a configuration change. The default `bind = "0.0.0.0"` already listens on every host interface, including the Tailscale one, so after `sudo tailscale up` the app answers at `http://<host>.<tailnet>.ts.net:8080/` on any tailnet device.

The catch is in the name: the port is also open to every LAN neighbour, and on a host with a public address and a permissive firewall, to the internet. Tailscale ACLs do not close the LAN-side socket. Use this layout only when the network around the host is trusted, or add a host firewall rule that allows the port on `tailscale0` only.

## Exposing to the public internet

Tailscale Funnel publishes a route to the open internet without a Tailscale account on the client:

```sh
sudo tailscale funnel --bg --https=443 http://127.0.0.1:8080
```

Funnel is a beta feature with requirements that catch people out:

- MagicDNS and valid HTTPS certificates must be enabled for the tailnet.
- The tailnet policy file must contain a `funnel` [node attribute](https://tailscale.com/docs/reference/syntax/policy-file#node-attributes). The CLI offers to add it the first time you enable Funnel.
- Funnel listens only on ports `443`, `8443`, and `10000`, and only over TLS.
- The public URL is always in your tailnet's domain (`<host>.<tailnet>.ts.net`); it is not a custom domain.
- Traffic is subject to non-configurable bandwidth limits.

Funnel exposes the app to anyone who has the URL. easy-host adds no authentication, and neither does Funnel. If the app has a login, this is the same trust model as putting it on the internet behind a proxy; if it does not, do not use Funnel.

## Access control

Tailscale decides who can reach the node, and the tailnet policy file is the only place to express that:

- Default tailnet policy allows every device and user in the tailnet to reach every node. For a home tailnet that is usually acceptable; for a shared or team tailnet, write a [grant](https://tailscale.com/docs/features/access-control/grants) that names the users or tags allowed to reach the host on the ports you serve.
- Tag the host (for example `tag:apps`) if it is administered by automation rather than a person, and grant access to the tag instead of to individual accounts.
- `tailscale serve` adds no authentication of its own. A user allowed to reach the node reaches the app; the app's own auth is what separates one user from another.

`tailscale serve status` shows the routes; the admin console's [Access controls](https://tailscale.com/docs/features/access-control) page shows and edits the policy.

## Reboot and persistence

Three independent things come back after a reboot:

1. **The container.** Rootless Podman replays `--restart=always` containers through `podman-restart.service`, which requires lingering for your user. This is the same mechanism described in [Host prerequisites](prerequisites.md#user-lingering); Tailscale is not involved.
2. **`tailscaled`.** The Linux package installs and enables a systemd service, so the node rejoins the tailnet on its own.
3. **The Serve or Funnel routes.** Routes configured with `--bg` are persisted by the Tailscale daemon and resume automatically after a reboot or a `tailscale up`. Routes configured without `--bg` do not.

If the app answers on the host but not over the tailnet after a reboot, check these in order: `tailscale status`, then `tailscale serve status`, then `easy-host status blog`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `502 Bad Gateway` or an empty response from the Serve URL | The app is unhealthy, or the target port is wrong | `easy-host status blog`; confirm the target uses `port`, not `container_port` |
| `connection refused` from the Serve URL | The container is bound to a different interface, or the port was changed without recreating | Check `status` reports `on 127.0.0.1`; run `easy-host update blog` after editing `bind` |
| `403 Forbidden` from a tailnet device | The tailnet policy does not grant that device or user access | Add a grant for the user or tag in the ACL policy |
| Certificate error, or the URL does not resolve | MagicDNS or HTTPS certificates are disabled | Enable both in the admin console, then re-run the Serve command |
| `tailscale serve` reports the port is already in use | Another route, or a Funnel, owns that port | `tailscale serve status`, then turn the old route off |
| The route works until reboot, then stops | It was configured without `--bg` | Re-run the same command with `--bg` |
| A device outside the tailnet cannot connect | Serve is tailnet-only by design | Use Funnel if public access is really intended |

## What this guide is not

- **It does not run Tailscale inside the app container.** Rootless Podman cannot create a Tailscale interface without `NET_ADMIN` and `/dev/net/tun`, easy-host runs exactly one container per app, and its cleanup and retention are label-scoped, so an untracked sidecar could be left behind by `remove`.
- **It does not add TLS termination, a reverse proxy, or authentication to easy-host.** Those stay outside the tool, on the host or in the tailnet policy.
- **It does not add a command or a configuration key.** The ten-command surface and the `config.toml` schema are unchanged, and a tailnet-IP `bind` remains rejected.
- **It does not make an app reachable without Tailscale on the client**, except through Funnel, which publishes it to everyone.

## Tailscale documentation

| Topic | Upstream page |
| --- | --- |
| Install on Linux | [tailscale.com/docs/install/linux](https://tailscale.com/docs/install/linux) |
| `tailscale serve` command and flags | [tailscale.com/docs/reference/tailscale-cli/serve](https://tailscale.com/docs/reference/tailscale-cli/serve) |
| Serve overview | [tailscale.com/docs/features/tailscale-serve](https://tailscale.com/docs/features/tailscale-serve) |
| Serve examples | [tailscale.com/docs/reference/examples/serve](https://tailscale.com/docs/reference/examples/serve) |
| `tailscale funnel` command and flags | [tailscale.com/docs/reference/tailscale-cli/funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel) |
| Funnel overview and requirements | [tailscale.com/docs/features/tailscale-funnel](https://tailscale.com/docs/features/tailscale-funnel) |
| Funnel vs. sharing | [tailscale.com/docs/reference/funnel-vs-sharing](https://tailscale.com/docs/reference/funnel-vs-sharing) |
| MagicDNS | [tailscale.com/docs/features/magicdns](https://tailscale.com/docs/features/magicdns) |
| HTTPS certificates | [tailscale.com/docs/how-to/set-up-https-certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) |
| Access control | [tailscale.com/docs/features/access-control](https://tailscale.com/docs/features/access-control) |
| Grants | [tailscale.com/docs/features/access-control/grants](https://tailscale.com/docs/features/access-control/grants) |
| Tailnet name | [tailscale.com/docs/concepts/tailnet-name](https://tailscale.com/docs/concepts/tailnet-name) |
| CLI reference | [tailscale.com/docs/reference/tailscale-cli](https://tailscale.com/docs/reference/tailscale-cli) |
| Troubleshooting | [tailscale.com/docs/reference/troubleshooting](https://tailscale.com/docs/reference/troubleshooting) |

Serve and Funnel command-line flags changed in Tailscale client 1.52; if your client behaves differently from the examples above, run `tailscale serve --help` or `tailscale funnel --help` for the installed version.
